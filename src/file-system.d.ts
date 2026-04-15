// File System Access API type declarations (Chrome 86+)
interface Window {
  showOpenFilePicker(options?: {
    types?: { description: string; accept: Record<string, string[]> }[];
    multiple?: boolean;
  }): Promise<FileSystemFileHandle[]>;

  showSaveFilePicker(options?: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle>;
}
