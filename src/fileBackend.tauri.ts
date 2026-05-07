import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileBackend } from "./fileBackend";

export async function openFile(): Promise<{ path: string; text: string } | null> {
  const r = await invoke<{ path: string; text: string } | null>("dialog_open_command");
  return r ?? null;
}

export async function saveFile(text: string): Promise<void> {
  await invoke("write_file_command", { text });
}

export async function saveFileAs(text: string): Promise<string | null> {
  const r = await invoke<string | null>("dialog_save_command", { text });
  return r ?? null;
}

export function subscribeToOpenRequest(cb: (path: string) => void): () => void {
  // The `cancelled` flag guards every async path that could deliver a value
  // after unsubscribe: (a) the get_initial_path resolution; (b) any event
  // already queued in the JS event loop when listen()'s handler runs;
  // (c) the unlisten fn itself if the listen() promise hasn't resolved yet.
  let cancelled = false;
  let unlisten: (() => void) | null = null;

  // Drain any cold-start initial path first.
  void invoke<string | null>("get_initial_path").then(initial => {
    if (initial && !cancelled) cb(initial);
  }).catch(() => { /* swallow — frontend stays usable */ });

  void listen<string>("open-path-request", e => {
    if (!cancelled) cb(e.payload);
  }).then(fn => {
    if (cancelled) { fn(); return; }
    unlisten = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export async function readFileByPath(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_file_command", { path });
  } catch {
    return null;
  }
}

export function setTitle(title: string): void {
  void invoke("set_window_title", { title });
}

const _backend: FileBackend = { openFile, saveFile, saveFileAs, subscribeToOpenRequest, readFileByPath, setTitle };
export default _backend;
