// File System Access API type declarations (Chrome 86+)
// `declare global` is required because `moduleDetection: "force"` in
// tsconfig.app.json makes every src/*.d.ts a module by default; without
// the global wrapper, `interface Window` would augment only this module's
// local Window and not the real DOM Window seen by other modules.
export {};
declare global {
  interface Window {
    showOpenFilePicker(options?: {
      types?: { description: string; accept: Record<string, string[]> }[];
      multiple?: boolean;
    }): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker(options?: {
      types?: { description: string; accept: Record<string, string[]> }[];
      suggestedName?: string;
    }): Promise<FileSystemFileHandle>;
    __TAURI_INTERNALS__?: unknown;
  }
}
