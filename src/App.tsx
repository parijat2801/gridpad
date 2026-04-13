import { useEffect } from "react";
import { useEditorStore } from "./store";
import LayerPanel from "./LayerPanel";

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

  // Autosave: write to file on every layer change (debounced)
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const unsub = useEditorStore.subscribe((state, prev) => {
      if (state.layers === prev.layers) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(async () => {
        const handle = useEditorStore.getState().fileHandle;
        if (!handle) return;
        try {
          const writable = await handle.createWritable();
          await writable.write(useEditorStore.getState().toText());
          await writable.close();
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

  return (
    <div className="app">
      <div className="panel-pane">
        <LayerPanel />
      </div>
      <div className="main-area">
        <div className="toolbar-pane">
          {/* Toolbar will go here */}
          <span style={{ color: "#666", padding: 8 }}>Gridpad — tools coming soon</span>
        </div>
        <div className="canvas-area">
          {/* KonvaCanvas will go here */}
          <pre style={{ color: "#e0e0e0", padding: 16, fontFamily: "monospace", fontSize: 14 }}>
            {useEditorStore((s) => s.toText()) || DEFAULT_ASCII}
          </pre>
        </div>
      </div>
    </div>
  );
}
