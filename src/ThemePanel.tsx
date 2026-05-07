/**
 * ThemePanel — popover that lets the user live-edit fonts, sizes, multipliers,
 * and colors. Binds to the theme module via useSyncExternalStore so updates
 * elsewhere (e.g. Reset, persisted load) re-render every control.
 *
 * Per plan:
 *   - Sliders fire updateTheme on every onChange (no debounce in the panel —
 *     debounce lives in DemoV2's reflow subscriber).
 *   - Font-size number inputs commit on blur or Enter so stepping is a single
 *     reflow per click.
 *   - Color pickers fire on every change (color updates are paint or css-vars-
 *     only, both cheap).
 *   - Wireframe font combobox is filtered to monospace fonts that exist on the
 *     machine via document.fonts.check().
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  subscribe,
  getSnapshot,
  updateTheme,
  resetTheme,
  type Theme,
} from "./theme";

const MONO_CANDIDATES = [
  "Menlo",
  "Monaco",
  'Courier New',
  "SF Mono",
  "JetBrains Mono",
] as const;

const PROSE_CANDIDATES = [
  "Inter",
  "system-ui",
  "Helvetica",
  "Arial",
  "Georgia",
  "Times New Roman",
] as const;

/** Filter a candidate list to fonts the browser can actually render.
 * `document.fonts.check` returns false for unloaded webfonts, but in this
 * project @fontsource/inter is bundled so Inter loads on first paint. */
function detectAvailable(candidates: readonly string[]): string[] {
  if (typeof document === "undefined" || !document.fonts) return [...candidates];
  return candidates.filter(name => {
    try { return document.fonts.check(`16px "${name}"`); }
    catch { return true; } // be permissive on errors
  });
}

interface SectionProps { title: string; children: React.ReactNode }
function Section({ title, children }: SectionProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--theme-grid-border, #444)" }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "#a0a0a8" }}>{title}</div>
      {children}
    </div>
  );
}

interface RowProps { label: string; children: React.ReactNode }
function Row({ label, children }: RowProps) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "110px 1fr", alignItems: "center", gap: 10, fontSize: 12, color: "#d0d0d8" }}>
      <span>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{children}</span>
    </label>
  );
}

interface NumberInputProps { value: number; min: number; max: number; step?: number; onCommit: (v: number) => void }
/** Number input that commits on blur or Enter (per plan: no debounce — one
 * step click = one reflow). */
function NumberInput({ value, min, max, step = 1, onCommit }: NumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  // Reset draft when the upstream value changes (e.g. Reset button).
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
      onCommit(parsed);
    } else {
      setDraft(String(value)); // revert invalid input
    }
  };

  return (
    <input
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      style={{ width: 60, background: "#1a1a22", color: "#e0e0e0", border: "1px solid #444", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}
    />
  );
}

interface SliderProps { value: number; min: number; max: number; step: number; onChange: (v: number) => void }
function Slider({ value, min, max, step, onChange }: SliderProps) {
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: "var(--theme-selection, #4a90e2)" }}
      />
      <span style={{ width: 40, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#a0a0a8" }}>
        {value.toFixed(step < 1 ? 2 : 0)}
      </span>
    </>
  );
}

interface ColorPickerProps { value: string; onChange: (v: string) => void }
function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <>
      <input
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: 36, height: 22, border: "none", background: "transparent", padding: 0, cursor: "pointer" }}
      />
      <span style={{ fontSize: 11, color: "#808088", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </>
  );
}

interface ComboProps<T extends string> { value: T; options: readonly T[]; onChange: (v: T) => void }
function Combo<T extends string>({ value, options, onChange }: ComboProps<T>) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as T)}
      style={{ flex: 1, background: "#1a1a22", color: "#e0e0e0", border: "1px solid #444", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}
    >
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

interface ThemePanelProps { open: boolean; onClose: () => void }

export function ThemePanel({ open, onClose }: ThemePanelProps) {
  const t = useSyncExternalStore(subscribe, getSnapshot);

  const monoFonts = useMemo(() => detectAvailable(MONO_CANDIDATES), []);
  const proseFonts = useMemo(() => detectAvailable(PROSE_CANDIDATES), []);

  // The wireframe font in theme is a stack ('Menlo, Monaco, "Courier New", monospace'),
  // but the picker shows single names. Match the persisted family by checking
  // which candidate is the leading name in the stack.
  const currentMono = useMemo(() => {
    const head = (t.wireframeFontFamily.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
    return monoFonts.find(f => f.toLowerCase() === head.toLowerCase()) ?? monoFonts[0] ?? "Menlo";
  }, [t.wireframeFontFamily, monoFonts]);

  if (!open) return null;

  const setMono = (name: string) => {
    // Build a stack with the chosen face first, plus the project fallback chain.
    const stack = `${name}, Menlo, Monaco, "Courier New", monospace`;
    updateTheme({ wireframeFontFamily: stack });
  };

  return (
    <div
      role="dialog"
      aria-label="Theme"
      style={{
        position: "fixed",
        top: 60,
        right: 20,
        zIndex: 200,
        width: 320,
        maxHeight: "calc(100vh - 80px)",
        overflowY: "auto",
        background: "#23232b",
        color: "#e0e0e0",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        border: "1px solid #333",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid #333" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Theme</span>
        <button
          onClick={onClose}
          aria-label="Close theme panel"
          style={{ background: "transparent", color: "#a0a0a8", border: "none", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 16, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      <Section title="Prose">
        <Row label="Family">
          <Combo value={t.proseFontFamily} options={proseFonts} onChange={v => updateTheme({ proseFontFamily: v })} />
        </Row>
        <Row label="Size">
          <Slider min={8} max={32} step={1} value={t.proseFontSize} onChange={v => updateTheme({ proseFontSize: v })} />
          <NumberInput min={8} max={32} value={t.proseFontSize} onCommit={v => updateTheme({ proseFontSize: v })} />
        </Row>
        <Row label="Color">
          <ColorPicker value={t.proseColor} onChange={v => updateTheme({ proseColor: v })} />
        </Row>
      </Section>

      <Section title="Wireframe">
        <Row label="Family">
          <Combo value={currentMono} options={monoFonts} onChange={setMono} />
        </Row>
        <Row label="Size">
          <Slider min={8} max={32} step={1} value={t.wireframeFontSize} onChange={v => updateTheme({ wireframeFontSize: v })} />
          <NumberInput min={8} max={32} value={t.wireframeFontSize} onCommit={v => updateTheme({ wireframeFontSize: v })} />
        </Row>
        <Row label="Color">
          <ColorPicker value={t.wireframeColor} onChange={v => updateTheme({ wireframeColor: v })} />
        </Row>
      </Section>

      <Section title="Layout">
        <Row label="Char width">
          <Slider min={0.8} max={1.5} step={0.01} value={t.charWidthMultiplier} onChange={v => updateTheme({ charWidthMultiplier: v })} />
        </Row>
        <Row label="Row height">
          <Slider min={1.0} max={2.0} step={0.01} value={t.charHeightMultiplier} onChange={v => updateTheme({ charHeightMultiplier: v })} />
        </Row>
        <div style={{ fontSize: 10, color: "#808088", lineHeight: 1.4 }}>
          Row height scales prose lines and wireframe rows together so frames stay aligned with the prose around them.
        </div>
      </Section>

      <Section title="Color">
        <Row label="Background">
          <ColorPicker value={t.bgColor} onChange={v => updateTheme({ bgColor: v })} />
        </Row>
        <Row label="Selection">
          <ColorPicker value={t.selectionColor} onChange={v => updateTheme({ selectionColor: v })} />
        </Row>
        <Row label="Grid border">
          <ColorPicker value={t.gridBorderColor} onChange={v => updateTheme({ gridBorderColor: v })} />
        </Row>
      </Section>

      <div style={{ padding: 10 }}>
        <button
          onClick={() => resetTheme()}
          style={{ width: "100%", background: "#1a1a22", color: "#e0e0e0", border: "1px solid #444", borderRadius: 6, padding: "6px", cursor: "pointer", fontSize: 12 }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

// Re-export so callers can avoid an extra import line.
export type { Theme };
