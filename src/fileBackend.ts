export interface FileBackend {
  openFile(): Promise<{ path: string; text: string } | null>;
  saveFile(text: string): Promise<void>;
  saveFileAs(text: string): Promise<string | null>;
  subscribeToOpenRequest(cb: (path: string) => void): () => void;
  readFileByPath(path: string): Promise<string | null>;
  setTitle(title: string): void;
}

export async function createFileBackend(): Promise<FileBackend> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return await import("./fileBackend.tauri");
  }
  return await import("./fileBackend.browser");
}
