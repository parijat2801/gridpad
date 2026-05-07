import { useEffect } from "react";

export interface UnsavedChangesModalProps {
  pendingPath: string;
  onDiscard: () => void;
  onSaveFirst: () => void;
  onCancel: () => void;
}

const PALETTE = {
  pageBg: "#141420",
  surface: "#2b2b33",
  text: "#e0e0e0",
  accent: "#4a90e2",
  divider: "#444",
} as const;

const FONT_STACK = "system-ui, -apple-system, sans-serif";

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function UnsavedChangesModal({ pendingPath, onDiscard, onSaveFirst, onCancel }: UnsavedChangesModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, fontFamily: FONT_STACK,
    }}>
      <div role="dialog" aria-modal="true" style={{
        background: PALETTE.surface, color: PALETTE.text,
        padding: 24, borderRadius: 10, minWidth: 380, maxWidth: 520,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
      }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600 }}>
          Unsaved changes
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 14, lineHeight: 1.5 }}>
          You have unsaved changes. Open <strong>{basename(pendingPath)}</strong> anyway?
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={btnStyle("ghost")}>Cancel</button>
          <button onClick={onDiscard} style={btnStyle("danger")}>Discard changes</button>
          <button onClick={onSaveFirst} style={btnStyle("primary")} autoFocus>Save and open</button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(variant: "ghost" | "danger" | "primary"): React.CSSProperties {
  const base: React.CSSProperties = {
    border: "none", borderRadius: 6, padding: "8px 14px",
    fontFamily: FONT_STACK, fontSize: 13, fontWeight: 500, cursor: "pointer",
    color: PALETTE.text,
  };
  if (variant === "primary") return { ...base, background: PALETTE.accent };
  if (variant === "danger") return { ...base, background: "#a23a3a" };
  return { ...base, background: "transparent", border: `1px solid ${PALETTE.divider}` };
}
