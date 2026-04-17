// File System Access API type declarations (Chrome 86+)
interface Window {
  showOpenFilePicker(options?: {
    types?: { description: string; accept: Record<string, string[]> }[];
    multiple?: boolean;
  }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(options?: {
    types?: { description: string; accept: Record<string, string[]> }[];
    suggestedName?: string;
  }): Promise<FileSystemFileHandle>;
}
