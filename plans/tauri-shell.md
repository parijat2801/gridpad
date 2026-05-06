# Tauri v2 Desktop Shell for Gridpad

## Resolved Decisions

1. **Tauri is the primary target.** `vite.config.ts` `base` flips to `'/'`. For gh-pages deploys, run `vite build --base=/gridpad/` manually when desired. No env-var branching.
2. **No Mantine.** Unsaved-changes modal is a plain React component with inline styles.
3. **Window title shows `<filename> ● Gridpad`** (dot when dirty). Tabs (Figma-style) are out of scope; single-file shell first, tabs as a follow-up plan once dogfooding informs the need.
4. **Save As: new path becomes the current path.** Subsequent Cmd+S writes to the new path. Original is no longer tracked. (Matches VS Code, Sublime, browser File System Access semantics.)
5. **`bin/gridpad` is a shell script** that calls `open -a "Gridpad" --args <path>`. No custom Rust CLI binary.
6. **Tauri dev runs on port 1420** (Tauri convention). Browser dev keeps 5173. Both can run simultaneously.

---

## 1. Architecture Overview

```
CLI INVOCATION PATH
───────────────────
bin/gridpad /abs/path/to/file.md
  └─ open -a "Gridpad" --args /abs/path/to/file.md
       └─ macOS launches Gridpad.app with argv = [binary, /abs/path/to/file.md]

COLD START (first window)
─────────────────────────
main.rs: setup() reads argv[1] → stores in AppState.pending_path (Mutex)
  └─ Frontend mounts → invoke("get_initial_path") → fileBackend.tauri.ts
       └─ calls loadDocument(text) → existing pipeline unchanged

WARM START (app already open)
──────────────────────────────
bin/gridpad foo.md → OS delivers to existing instance via single-instance plugin
  └─ Rust single-instance closure: app.emit("open-path-request", {path})
       └─ Frontend listener in fileBackend.tauri.ts receives event
            └─ if dirty → queue path, show UnsavedChangesModal
               else → invoke("read_file_command", {path}) → loadDocument(text)

SAVE PATH (Cmd+S)
─────────────────
DemoV2.tsx keydown handler calls fileBackend.saveFile(text)
  └─ Tauri mode: invoke("write_file_command", {path: currentPath, text})
     Browser mode: saveToHandle(fileHandleRef.current) [unchanged]

macOS Finder "Open With" (warm path only, cold handled by setup())
───────────────────────────────────────────────────────────────────
RunEvent::Opened{urls} → Rust stores path, emits "open-path-request"
  └─ Same warm-start frontend path above
```

## 2. New Files

| Path | Purpose |
|---|---|
| `src-tauri/Cargo.toml` | Rust package; declares tauri, serde, plugins |
| `src-tauri/build.rs` | Calls `tauri_build::build()` |
| `src-tauri/src/main.rs` | `fn main()` entry point — 3 lines, calls `lib::run()` |
| `src-tauri/src/lib.rs` | All Rust logic: plugins, commands, state, event wiring |
| `src-tauri/tauri.conf.json` | App identity, window settings, Vite integration |
| `src-tauri/capabilities/default.json` | v2 permissions for fs, cli, event, single-instance |
| `src/fileBackend.ts` | Public adapter interface + environment detection |
| `src/fileBackend.browser.ts` | File System Access API implementation |
| `src/fileBackend.tauri.ts` | Tauri invoke/listen implementation |
| `src/UnsavedChangesModal.tsx` | Three-button modal component |
| `bin/gridpad` | Shell script wrapper |

## 3. src-tauri Configuration

### 3.1 `tauri.conf.json`

```json
{
  "productName": "Gridpad",
  "version": "0.1.0",
  "identifier": "app.gridpad.gridpad",
  "build": {
    "beforeDevCommand": "npm run dev -- --port 1420 --strictPort",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{ "label": "main", "width": 1280, "height": 800, "title": "Gridpad" }],
    "security": { "csp": null }
  }
}
```

`base` in `vite.config.ts` flips to `'/'` (Tauri is primary). For gh-pages deploys: `vite build --base=/gridpad/` invoked manually when desired. No env-var branching.

### 3.2 `capabilities/default.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    { "identifier": "fs:allow-read-text-file",  "allow": [{ "path": "**" }] },
    { "identifier": "fs:allow-write-text-file", "allow": [{ "path": "**" }] },
    "cli:default"
  ]
}
```

The `fs` scope `"**"` is intentional: gridpad opens arbitrary user-specified paths. v1-style `allowlist` does not apply.

### 3.3 `Cargo.toml`

```toml
[package]
name = "gridpad"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri         = { version = "2", features = [] }
tauri-plugin-fs              = "2"
tauri-plugin-cli             = "2"
tauri-plugin-single-instance = "2"
serde         = { version = "1", features = ["derive"] }
serde_json    = "1"
```

## 4. Rust Backend (`src-tauri/src/lib.rs`)

Stays under 300 lines.

### 4.1 Shared state

```rust
struct AppState {
    pending_path: Mutex<Option<String>>,   // argv[1], consumed once
    current_path: Mutex<Option<String>>,   // updated by open, cleared by new-file
}
```

### 4.2 Commands

- **`get_initial_path`** — drains `pending_path`, returns `Option<String>`. Frontend reads file separately via `read_file_command`.
- **`read_file_command(path)`** — `std::fs::read_to_string`. Validates non-empty path. Updates `current_path` on success.
- **`write_file_command(path, text)`** — `std::fs::write`. Validates `path == current_path` (prevents stale writes).
- **`get_current_path()`** — for hot-reload state recovery.
- **`set_window_title(title)`** — frontend calls this whenever filename or dirty state changes. Format: `"<basename> ● Gridpad"` when dirty, `"<basename> — Gridpad"` when clean, `"Gridpad"` when no file open. Implementation: `webview_window.set_title(&title)`. Frontend builds the string; Rust just sets it.

### 4.3 Single-instance wiring

```rust
tauri_plugin_single_instance::init(|app, argv, _cwd| {
    let path = argv.get(1).cloned().unwrap_or_default();
    let _ = app.emit("open-path-request", path);
    if let Some(w) = app.get_webview_window("main") { let _ = w.set_focus(); }
})
```

### 4.4 macOS open-with / cold-start

```rust
.run(|app, event| {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = event {
        use tauri::Emitter;
        let paths: Vec<String> = urls.iter()
            .filter_map(|u| u.to_file_path().ok())
            .filter_map(|p| p.to_str().map(String::from))
            .collect();
        if let Some(path) = paths.first() {
            let state = app.state::<AppState>();
            let mut pending = state.pending_path.lock().unwrap();
            if pending.is_some() { *pending = Some(path.clone()); }
            else { let _ = app.emit("open-path-request", path.clone()); }
        }
    }
});
```

Cold/warm distinction: if `pending_path` is `Some`, replace it (frontend hasn't called `get_initial_path`); if `None`, emit warm-start event.

### 4.5 CLI argument capture

In `setup()`:

```rust
let matches = app.cli().matches()?;
if let Some(ArgData { value: serde_json::Value::String(path), .. }) =
    matches.args.get("file")
{
    *app.state::<AppState>().pending_path.lock().unwrap() = Some(path.clone());
}
```

`tauri.conf.json` declares:
```json
"plugins": {
  "cli": {
    "args": [{ "name": "file", "index": 1, "takesValue": true }]
  }
}
```

## 5. Frontend Adapter (`src/fileBackend.ts`)

Single environment-detection point. All of DemoV2's file I/O goes through it.

```typescript
export interface FileBackend {
  openFile(): Promise<{ path: string; text: string } | null>;
  saveFile(text: string): Promise<void>;
  saveFileAs(text: string): Promise<string | null>;
  subscribeToOpenRequest(cb: (path: string) => void): () => void;
  readFileByPath(path: string): Promise<string | null>;
  setTitle(title: string): void;
}
```

`createFileBackend()` returns `import('./fileBackend.tauri')` when `'__TAURI_INTERNALS__' in window` is truthy, else `import('./fileBackend.browser')`. Dynamic imports keep each tree-shakable.

**Why `__TAURI_INTERNALS__` not `__TAURI__`**: In v2, `__TAURI_INTERNALS__` is always injected; `__TAURI__` requires `withGlobalTauri` opt-in.

### 5.1 `fileBackend.browser.ts`

Wraps the existing `showOpenFilePicker` / `showSaveFilePicker` / `saveToHandle` logic extracted verbatim from `DemoV2.tsx`. Module-level `fileHandle: FileSystemFileHandle | null`. `subscribeToOpenRequest` is a no-op. `readFileByPath` returns `null`.

### 5.2 `fileBackend.tauri.ts`

Uses `invoke` from `@tauri-apps/api/core` and `listen` from `@tauri-apps/api/event`.

- `openFile()`: `invoke('dialog_open_command')` — Rust calls `tauri_plugin_dialog`, returns `{ path, text }` or `null`.
- `saveFile(text)`: `invoke('write_file_command', { text })`.
- `saveFileAs(text)`: `invoke('dialog_save_command', { text })`.
- `subscribeToOpenRequest(cb)`: `listen<string>('open-path-request', e => cb(e.payload))` — returns unlisten fn. **The one legitimate `useEffect` use** in `DemoV2.tsx`.
- `readFileByPath(path)`: `invoke<string>('read_file_command', { path })`.

## 6. Changes to `DemoV2.tsx`

Minimal diff. Every change is in the file I/O surface only.

- **A.** Remove `fileHandleRef`, `saveToHandle`, `scheduleAutosave`. They move into `fileBackend.browser.ts`. Replace `saveToHandle` calls with `fileBackend.saveFile(md)`.
- **B.** Cmd+O handler: `const r = await backend.openFile(); if (r) { loadDocument(r.text); doLayout(); paint(); }`.
- **C.** Cmd+S handler: `await backend.saveFile(serializeUnified(...))`.
- **D.** Cmd+Shift+S handler: `await backend.saveFileAs(serializeUnified(...))`.
- **E.** Add a `useEffect` (justified: subscription lifecycle, not data flow) that subscribes to open-requests, calls `readFileByPath` on initial path, and returns unsubscribe fn.
- **F.** `handleOpenRequest(path)`: if not dirty → load. If dirty → `setPendingPath(path); setShowUnsavedModal(true)`.
- **G.** Title-bar sync: a single helper `updateTitle()` reads current filename + `isDirty()` and calls `backend.setTitle(...)`. Invoked at: file open, file save (clean transition), and on each edit that flips dirty state. Browser backend's `setTitle` is a no-op. Tauri backend invokes `set_window_title` Rust command.

`isDirty()` already exists in `__gridpad`; extract as `const isDirty = () => framesRef.current.some(f => f.dirty)`.

**No other changes.** `__gridpad`, `loadDocument`, `syncRefsFromState`, painting pipeline untouched.

## 7. Unsaved Changes Modal

Pure React component, no external deps. Inline styles matching the dark palette.

Props: `pendingPath: string; onDiscard(): void; onSaveFirst(): void; onCancel(): void`.

State machine lives in `DemoV2.tsx`:

```
Idle ──open-request-arrives──► DirtyCheck
DirtyCheck ──clean──► ReadAndLoad → Idle
DirtyCheck ──dirty──► ShowModal(pendingPath)
ShowModal ──Discard──► ReadAndLoad(pendingPath) → Idle
ShowModal ──SaveFirst──► SaveCurrent → ReadAndLoad(pendingPath) → Idle
ShowModal ──Cancel──► Idle (pendingPath dropped)
```

Invariant: `pendingPath` always holds the queued path when `showUnsavedModal === true`.

To swap policy later (auto-discard in agent mode, queue multiple paths), only `handleOpenRequest` and the state machine change. Modal and backend are not coupled to policy.

## 8. `bin/gridpad` Shell Script

```sh
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: gridpad <path>" >&2
  exit 1
fi

TARGET="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

if [[ ! -f "$TARGET" ]]; then
  echo "gridpad: file not found: $TARGET" >&2
  exit 1
fi

open -a "Gridpad" --args "$TARGET"
```

Recommendation: **detach** — `open -a` returns immediately. Agent use cases don't require blocking.

## 9. Build and Install

### Dev loop

```sh
npm install --save-dev @tauri-apps/cli@^2
npm install @tauri-apps/api @tauri-apps/plugin-fs @tauri-apps/plugin-cli
# add to package.json scripts: "tauri": "tauri"
npm run tauri dev
```

`tauri dev` spawns `npm run dev` (Vite on 5173), opens the Tauri window. Rust hot-reload requires restart; TS hot-reloads via Vite.

### Production build

```sh
npm run tauri build
# .app at: src-tauri/target/release/bundle/macos/Gridpad.app
cp -r src-tauri/target/release/bundle/macos/Gridpad.app /Applications/
chmod +x bin/gridpad
cp bin/gridpad /usr/local/bin/gridpad
```

## 10. Test Strategy

**Existing tests stay unchanged.** `fileBackend.browser.ts` keeps the File System Access path intact.

Unit-testable surfaces (TDD):
- `fileBackend.browser.ts`: mock `showOpenFilePicker`/`showSaveFilePicker` in Vitest.
- `UnsavedChangesModal.tsx`: Vitest + jsdom; verify all three callbacks fire.
- `fileBackend.tauri.ts`: mock `__TAURI_INTERNALS__`, `invoke`, `listen` with `vi.fn()`.
- Rust commands: unit tests with `std::env::temp_dir()`.

Manual smoke tests:
1. `gridpad /tmp/test.md` → app opens with content.
2. Edit + Cmd+S → file updated on disk.
3. Dirty doc + `gridpad /tmp/other.md` → modal appears; all three buttons work.
4. `gridpad /tmp/nonexistent.md` → error logged, app doesn't crash.

Playwright is **not** retargeted to Tauri. Future effort.

## 11. Risks and Unknowns

- **Gatekeeper on first launch.** Unsigned .app shows "developer cannot be verified." Right-click → Open on first launch. Document in README.
- **File path encoding.** `argv` parsing via `std::env::args()` fails on invalid UTF-8. Mitigation: `args_os()` + `to_string_lossy()`, surface a user-visible error.
- **File not found / permission errors.** `read_file_command` returns `Result<String, String>`. Frontend must convert Err to a visible alert.
- **Port: Tauri dev = 1420, browser dev = 5173.** Both can run simultaneously.
- **`__TAURI_INTERNALS__` timing.** Injected before page load. Synchronous detection is safe.
- **Single-instance lock file.** May persist across crashes. Workaround: delete `$TMPDIR/gridpad-single-instance.lock`.
- **`RunEvent::Opened` vs single-instance.** Finder uses Apple Events (`kAEOpenDocuments`); CLI `open --args` uses argv. Both must be implemented.
- **Vite `base` change.** `process.env.TAURI_ENV_TARGET_TRIPLE` branch is the isolation mechanism; verify with CI before committing.

## 12. Out of Scope

- Code signing / notarization.
- `.dmg` distribution.
- Auto-update via `tauri-plugin-updater`.
- Windows / Linux support.
- File association (Finder double-click → gridpad).
- Playwright e2e under Tauri WebDriver.
- **Figma-style tabs** (multiple files open in one window with a tab strip). Adapter is designed so this is a localized future extension: `current_path: Option<String>` becomes `documents: Vec<DocState>`, frontend gains a tab strip, `open_file_command` adds a doc instead of replacing.

## 13. Task Sequence (Bite-Sized, TDD)

1. Add Tauri CLI to devDependencies. Verify: `npm run tauri -- --version`.
2. Scaffold `src-tauri/` via `npx tauri init`. Verify: directory + config files exist.
3. Write `fileBackend.ts` interface + `fileBackend.browser.ts` with unit tests. Extract from `DemoV2.tsx`. Verify: `npm test`.
4. Wire `DemoV2.tsx` to `fileBackend.browser.ts` exclusively (no Tauri yet). Verify: `npm run dev` Cmd+O / Cmd+S still work.
5. Write `fileBackend.tauri.ts` with mocked unit tests. Verify: tests pass.
6. Write `UnsavedChangesModal.tsx` with unit test. Verify: `npm test`.
7. Add state machine to `DemoV2.tsx` (`pendingPath`, `showUnsavedModal`, `handleOpenRequest`). Verify: trigger from console.
8. Implement Rust commands in `lib.rs` + Rust unit tests. Verify: `cargo test`.
9. Wire single-instance plugin + `RunEvent::Opened`. Verify: second invocation focuses existing window.
10. CLI argv capture in `setup()`. Verify: `npm run tauri dev -- -- /tmp/test.md` opens file on cold start.
11. Flip `vite.config.ts` `base` to `'/'`. Verify: `npm run tauri build` produces a working `.app`. Note: gh-pages now requires `vite build --base=/gridpad/` (manual, when desired).
12. Write `bin/gridpad`, `chmod +x`. Verify: `bin/gridpad /tmp/test.md`.
13. Run full test suite: `npm test && npx playwright test e2e/`. No regressions.
14. Manual smoke tests of all four scenarios.
