import type { FileBackend } from "./fileBackend";

type WritableHandle = FileSystemFileHandle & {
  createWritable(): Promise<FileSystemWritableFileStream>;
};

let fileHandle: FileSystemFileHandle | null = null;

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export async function openFile(): Promise<{ path: string; text: string } | null> {
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
  if (!fileHandle) return;
  await writeTo(fileHandle, text);
}

export async function saveFileAs(text: string): Promise<string | null> {
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
