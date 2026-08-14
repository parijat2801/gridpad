import type { FileBackend } from "./fileBackend";

type WritableHandle = FileSystemFileHandle & {
  createWritable(): Promise<FileSystemWritableFileStream>;
};

let fileHandle: FileSystemFileHandle | null = null;
// Fallback path: remember the last chosen filename so plain Cmd+S re-downloads
// under the same name in browsers without the File System Access API.
let fallbackName: string | null = null;

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

// File System Access API ships in Chromium only. Firefox and Safari need the
// classic fallbacks: <input type=file> for open, blob-download for save.
// Checked per API at call time.
function hasOpenPicker(): boolean {
  return typeof window.showOpenFilePicker === "function";
}

function hasSavePicker(): boolean {
  return typeof window.showSaveFilePicker === "function";
}

function openViaInput(): Promise<{ path: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,text/markdown,text/plain";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      fallbackName = file.name;
      resolve({ path: file.name, text: await file.text() });
    };
    // cancel event (supported in modern engines); worst case the promise
    // just never resolves, which leaves the app idle rather than broken.
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

function downloadAs(name: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export async function openFile(): Promise<{ path: string; text: string } | null> {
  if (!hasOpenPicker()) return openViaInput();
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
    });
    fileHandle = handle;
    const file = await handle.getFile();
    return { path: handle.name, text: await file.text() };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

async function writeTo(handle: FileSystemFileHandle, text: string): Promise<void> {
  const w = await (handle as WritableHandle).createWritable();
  try {
    await w.write(text);
  } finally {
    await w.close();
  }
}

export async function saveFile(text: string): Promise<void> {
  if (fileHandle) {
    await writeTo(fileHandle, text);
    return;
  }
  if (!hasSavePicker() && fallbackName) {
    downloadAs(fallbackName, text);
  }
}

export async function saveFileAs(text: string): Promise<string | null> {
  if (!hasSavePicker()) {
    const name = fallbackName ?? "document.md";
    downloadAs(name, text);
    fallbackName = name;
    return name;
  }
  try {
    const handle = await window.showSaveFilePicker({
      types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      suggestedName: "document.md",
    });
    fileHandle = handle;
    await writeTo(handle, text);
    return handle.name;
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export function subscribeToOpenRequest(_cb: (path: string) => void): () => void {
  return () => {};
}

export async function readFileByPath(_path: string): Promise<string | null> {
  return null;
}

export function setTitle(_title: string): void {
}

const _backend: FileBackend = { openFile, saveFile, saveFileAs, subscribeToOpenRequest, readFileByPath, setTitle };
export default _backend;
