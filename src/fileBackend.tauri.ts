// Stub — the full Tauri backend lands in Task 5.
// This file exists so Vite's static analysis of `import("./fileBackend.tauri")`
// in fileBackend.ts can resolve during browser-only dev/build. The runtime
// branch that selects this module is gated on `window.__TAURI_INTERNALS__`,
// which is never set under Vite/Vitest, so the throwing stubs below are
// unreachable in non-Tauri contexts.
import type { FileBackend } from "./fileBackend";

function unimplemented(): never {
  throw new Error("fileBackend.tauri: not implemented (placeholder pending Task 5)");
}

export async function openFile(): Promise<{ path: string; text: string } | null> { return unimplemented(); }
export async function saveFile(_text: string): Promise<void> { return unimplemented(); }
export async function saveFileAs(_text: string): Promise<string | null> { return unimplemented(); }
export function subscribeToOpenRequest(_cb: (path: string) => void): () => void { return unimplemented(); }
export async function readFileByPath(_path: string): Promise<string | null> { return unimplemented(); }
export function setTitle(_title: string): void { unimplemented(); }

const _backend: FileBackend = { openFile, saveFile, saveFileAs, subscribeToOpenRequest, readFileByPath, setTitle };
export default _backend;
