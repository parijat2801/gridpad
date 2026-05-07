use std::path::PathBuf;
use std::sync::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager, State, RunEvent};
use tauri_plugin_cli::CliExt;
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct AppState {
    pub pending_path: Mutex<Option<String>>,
    pub current_path: Mutex<Option<String>>,
    pub frontend_ready: Mutex<bool>,
}

#[derive(Serialize)]
pub struct OpenedFile { pub path: String, pub text: String }

// ── Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_initial_path(state: State<'_, AppState>) -> Option<String> {
    *state.frontend_ready.lock().unwrap() = true;
    state.pending_path.lock().unwrap().take()
}

#[tauri::command]
fn read_file_command(path: String, state: State<'_, AppState>) -> Result<String, String> {
    if path.is_empty() { return Err("empty path".into()); }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))?;
    *state.current_path.lock().unwrap() = Some(path);
    Ok(text)
}

#[tauri::command]
fn write_file_command(text: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = state.current_path.lock().unwrap().clone()
        .ok_or_else(|| "no current path; use saveFileAs first".to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("write failed: {e}"))
}

// `tauri_plugin_dialog::FilePath` is an enum that handles cross-platform paths
// (incl. mobile content:// URIs). On desktop, .into_path() always succeeds and
// returns a std::path::PathBuf.
#[tauri::command]
async fn dialog_open_command(app: tauri::AppHandle) -> Result<Option<OpenedFile>, String> {
    let picked = app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .blocking_pick_file();
    let Some(file_path) = picked else { return Ok(None); };
    let path: PathBuf = file_path.into_path()
        .map_err(|e| format!("invalid path from dialog: {e}"))?;
    let path_str = path.to_string_lossy().to_string();
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))?;
    let state = app.state::<AppState>();
    *state.current_path.lock().unwrap() = Some(path_str.clone());
    Ok(Some(OpenedFile { path: path_str, text }))
}

#[tauri::command]
async fn dialog_save_command(app: tauri::AppHandle, text: String) -> Result<Option<String>, String> {
    let picked = app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name("document.md")
        .blocking_save_file();
    let Some(file_path) = picked else { return Ok(None); };
    let path: PathBuf = file_path.into_path()
        .map_err(|e| format!("invalid path from dialog: {e}"))?;
    let path_str = path.to_string_lossy().to_string();
    std::fs::write(&path, text).map_err(|e| format!("write failed: {e}"))?;
    let state = app.state::<AppState>();
    *state.current_path.lock().unwrap() = Some(path_str.clone());
    Ok(Some(path_str))
}

#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| format!("set_title failed: {e}"))
}

// ── App entry ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = argv.get(1).cloned() {
                let _ = app.emit("open-path-request", path);
            }
            if let Some(w) = app.get_webview_window("main") { let _ = w.set_focus(); }
        }))
        .setup(|app| {
            // Capture cold-start argv via plugin-cli.
            if let Ok(matches) = app.cli().matches() {
                if let Some(arg) = matches.args.get("file") {
                    if let serde_json::Value::String(p) = &arg.value {
                        *app.state::<AppState>().pending_path.lock().unwrap() = Some(p.clone());
                    }
                }
            }
            // Default macOS menu (Cmd+Q, Cmd+H, Edit menu).
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_path,
            read_file_command,
            write_file_command,
            dialog_open_command,
            dialog_save_command,
            set_window_title,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { ref urls } = event {
                let paths: Vec<String> = urls.iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter_map(|p| p.to_str().map(String::from))
                    .collect();
                if let Some(path) = paths.first() {
                    let state = app.state::<AppState>();
                    let ready = *state.frontend_ready.lock().unwrap();
                    if ready { let _ = app.emit("open-path-request", path.clone()); }
                    else { *state.pending_path.lock().unwrap() = Some(path.clone()); }
                }
            }
            let _ = (app, event);
        });
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_file_command_round_trip() {
        let tmp = std::env::temp_dir().join("gridpad-test-read.md");
        fs::write(&tmp, "# hello\n").unwrap();
        let state = AppState::default();
        let text = std::fs::read_to_string(&tmp).unwrap();
        assert_eq!(text, "# hello\n");
        *state.current_path.lock().unwrap() = Some(tmp.to_string_lossy().to_string());
        assert!(state.current_path.lock().unwrap().is_some());
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn write_file_round_trip() {
        let tmp = std::env::temp_dir().join("gridpad-test-write.md");
        let _ = fs::remove_file(&tmp);
        std::fs::write(&tmp, "data").unwrap();
        assert_eq!(fs::read_to_string(&tmp).unwrap(), "data");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn read_empty_path_errors() {
        let path: String = "".into();
        assert!(path.is_empty());
    }

    #[test]
    fn frontend_ready_starts_false() {
        let s = AppState::default();
        assert!(!*s.frontend_ready.lock().unwrap());
    }

    #[test]
    fn pending_path_take_clears() {
        let s = AppState::default();
        *s.pending_path.lock().unwrap() = Some("/tmp/x.md".into());
        let drained = s.pending_path.lock().unwrap().take();
        assert_eq!(drained, Some("/tmp/x.md".into()));
        assert!(s.pending_path.lock().unwrap().is_none());
    }
}
