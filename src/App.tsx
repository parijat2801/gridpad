import { useEffect, useRef } from "react";
import { useEditorStore } from "./store";
import LayerPanel from "./LayerPanel";
import { SpatialCanvas } from "./SpatialCanvas";
import { Toolbar } from "./Toolbar";

const DEFAULT_ASCII = `┌─────────────────────────────────────────────────┐
│                   Dashboard                     │
├──────────┬──────────────────────┬───────────────┤
│ Sidebar  │  Main Content        │  Right Panel  │
│          │                      │               │
│          │  ┌────────────────┐  │               │
│          │  │  Card Title    │  │               │
│          │  │  Description   │  │               │
│          │  └────────────────┘  │               │
│          │                      │               │
└──────────┴──────────────────────┴───────────────┘`;

export default function App() {
  // Initial load
  useEffect(() => {
    useEditorStore.getState().loadFromText(DEFAULT_ASCII);
  }, []);

  // Autosave: write to file on every layer change (debounced).
  const lastModifiedRef = useRef<number>(0);
  const lastWrittenTextRef = useRef<string>("");

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const unsub = useEditorStore.subscribe((state, prev) => {
      if (state.layers === prev.layers) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(async () => {
        const handle = useEditorStore.getState().fileHandle;
        if (!handle) return;
        const newText = useEditorStore.getState().toText();
        if (newText === lastWrittenTextRef.current) return;
        try {
          const writable = await handle.createWritable();
          await writable.write(newText);
          await writable.close();
          lastWrittenTextRef.current = newText;
          const file = await handle.getFile();
          lastModifiedRef.current = file.lastModified;
        } catch (e) {
          console.error("Autosave failed:", e);
        }
      }, 500);
    });
    return () => {
      if (timeout) clearTimeout(timeout);
      unsub();
    };
  }, []);

  // File handlers
  const handleOpen = async () => {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      });
      const file = await handle.getFile();
      const text = await file.text();
      lastModifiedRef.current = file.lastModified;
      lastWrittenTextRef.current = text;
      useEditorStore.getState().reset();
      useEditorStore.getState().setFileHandle(handle);
      useEditorStore.getState().loadFromText(text);
    } catch {
      // User cancelled
    }
  };

  const handleSave = async () => {
    let handle: FileSystemFileHandle | null = useEditorStore.getState().fileHandle;
    if (!handle) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: "wireframe.md",
          types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
        });
        useEditorStore.getState().setFileHandle(handle);
      } catch { return; }
    }
    if (!handle) return;
    const text = useEditorStore.getState().toText();
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    lastWrittenTextRef.current = text;
    const file = await handle.getFile();
    lastModifiedRef.current = file.lastModified;
  };

  const handleReload = async () => {
    const handle = useEditorStore.getState().fileHandle;
    if (!handle) return;
    try {
      const file = await handle.getFile();
      const text = await file.text();
      lastModifiedRef.current = file.lastModified;
      lastWrittenTextRef.current = text;
      useEditorStore.getState().loadFromText(text);
    } catch (e) {
      console.error("Reload failed:", e);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const isMac = navigator.platform.includes("Mac");
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement ||
          e.target instanceof HTMLInputElement) return;
      const store = useEditorStore.getState();
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "o") { e.preventDefault(); handleOpen(); return; }
      if (mod && e.key === "s") { e.preventDefault(); handleSave(); return; }
      if (mod && e.shiftKey && e.key === "r") { e.preventDefault(); handleReload(); return; }
      // Tool shortcuts suppressed in text typing mode
      if (store.activeTool === "text") {
        if (e.key === "Escape") store.setActiveTool("select");
        return;
      }
      switch (e.key.toLowerCase()) {
        case "v": store.setActiveTool("select"); break;
        case "r": store.setActiveTool("rect"); break;
        case "l": store.setActiveTool("line"); break;
        case "t": store.setActiveTool("text"); break;
        case "e": store.setActiveTool("eraser"); break;
        case "escape": store.setActiveTool("select"); break;
        case "delete": case "backspace":
          if (store.activeTool === "select" && store.selectedId) {
            e.preventDefault();
            store.deleteLayer(store.selectedId);
          }
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="app">
      <div className="panel-pane">
        <LayerPanel />
      </div>
      <div className="main-area">
        <div className="toolbar-pane">
          <Toolbar onOpen={handleOpen} onSave={handleSave} onReload={handleReload} />
        </div>
        <div className="canvas-area">
          <SpatialCanvas />
        </div>
      </div>
    </div>
  );
}
