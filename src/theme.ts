/**
 * theme.ts — Live-editable theme module.
 *
 * Architecture (per plan):
 *   - All knobs live on a single mutable `theme` object. ES module imports
 *     of this object are live bindings, so any call site that does
 *     `theme.wireframeFontSize` reads the current value at call time.
 *     This avoids function-call overhead in the paint loop while still
 *     allowing live mutation from the panel.
 *
 *   - `updateTheme(patch)` is sync-mutate→sync-snapshot→sync-notify, then
 *     fire-and-forget side-effects. Subscribers fire synchronously so React's
 *     useSyncExternalStore re-renders controlled inputs immediately and the
 *     slider thumb tracks the drag. The async work (font load, remeasure,
 *     reflow, paint) is dispatched by the subscriber, NOT awaited inside
 *     updateTheme.
 *
 *   - `getSnapshot` returns the same frozen reference between updates. A new
 *     reference is generated synchronously inside updateTheme, after the
 *     mutation but before listener notification. This satisfies
 *     useSyncExternalStore's tearing-detection contract — returning a fresh
 *     object every call would cause infinite re-renders.
 *
 *   - The classifier (`classifyPatch`) maps patch fields to one of three
 *     buckets. The actual reflow handler lives in DemoV2 (it needs stateRef /
 *     preparedRef / framesRef access), but the classification policy lives
 *     here so it stays close to the Theme shape it describes.
 */

export interface Theme {
  proseFontFamily: string;
  proseFontSize: number;
  proseLineHeight: number;
  proseColor: string;
  /** Monospace-only — the picker enumerates Menlo / Monaco / Courier New / SF Mono / JetBrains Mono. */
  wireframeFontFamily: string;
  wireframeFontSize: number;
  wireframeColor: string;
  charWidthMultiplier: number;
  charHeightMultiplier: number;
  bgColor: string;
  selectionColor: string;
  gridBorderColor: string;
}

export type ThemeUpdateKind = "reflow" | "paint" | "css-vars-only";
export type ThemeListener = (kind: ThemeUpdateKind) => void;

/** Default values pinned to current production hardcodes (see plan step 13).
 * Zero visual change at first launch when no persisted theme is present. */
export const DEFAULT_THEME: Readonly<Theme> = Object.freeze({
  proseFontFamily: "Inter",
  proseFontSize: 16,
  proseLineHeight: 22, // matches textFont.ts
  proseColor: "#e0e0e0",
  wireframeFontFamily: 'Menlo, Monaco, "Courier New", monospace',
  wireframeFontSize: 16,
  wireframeColor: "#e0e0e0",
  charWidthMultiplier: 1.0,
  charHeightMultiplier: 1.4, // was the magic 1.4 multiplier in grid.ts:28
  bgColor: "#1e1e2e",
  selectionColor: "#4a90e2",
  gridBorderColor: "#444",
});

/** Live, mutable theme object. Call sites read fields directly at call time. */
export const theme: Theme = { ...DEFAULT_THEME };

// ── Snapshot management ─────────────────────────────────────────────

let _snapshot: Readonly<Theme> = Object.freeze({ ...theme });

/** useSyncExternalStore-compatible: returns the SAME reference between updates,
 * a NEW frozen reference after each updateTheme call. */
export function getSnapshot(): Readonly<Theme> {
  return _snapshot;
}

// ── Subscribers ─────────────────────────────────────────────────────

const _listeners = new Set<ThemeListener>();

export function subscribe(listener: ThemeListener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

function notifyListeners(kind: ThemeUpdateKind): void {
  for (const fn of _listeners) {
    try { fn(kind); } catch (err) {
      // A misbehaving listener mustn't break the others.
      // eslint-disable-next-line no-console
      console.error("theme listener threw", err);
    }
  }
}

// ── Patch classification ────────────────────────────────────────────

/** Fields whose value participates in measurement / reflow.
 * Pretext does not use color in measurement (confirmed in plan review),
 * so colors never reflow. */
const REFLOW_FIELDS: ReadonlySet<keyof Theme> = new Set<keyof Theme>([
  "wireframeFontFamily",
  "wireframeFontSize",
  "charWidthMultiplier",
  "charHeightMultiplier",
  "proseFontFamily",
  "proseFontSize",
  "proseLineHeight",
]);

/** Canvas-side colors — repaint required (ctx.fillStyle reads at draw time). */
const PAINT_FIELDS: ReadonlySet<keyof Theme> = new Set<keyof Theme>([
  "proseColor",
  "wireframeColor",
]);

/** Classify a patch into the strongest bucket needed.
 * DOM-side colors (bgColor, selectionColor, gridBorderColor) are the implicit
 * default — they only need a CSS-var write, no canvas work.
 * reflow > paint > css-vars-only.  Empty patch → css-vars-only (no work). */
export function classifyPatch(patch: Partial<Theme>): ThemeUpdateKind {
  let needsPaint = false;
  for (const key of Object.keys(patch) as (keyof Theme)[]) {
    if (REFLOW_FIELDS.has(key)) return "reflow";
    if (PAINT_FIELDS.has(key)) needsPaint = true;
    // CSS_VAR_FIELDS contribute nothing — they're the default.
  }
  return needsPaint ? "paint" : "css-vars-only";
}

// ── CSS variable sync ───────────────────────────────────────────────

/** Map theme fields to CSS variable names. The DOM-only fields go to :root;
 * canvas-side fields (proseColor, wireframeColor) are mirrored too so anything
 * that wants to use them in CSS (e.g. future toolbar text) can. */
const CSS_VAR_MAP: ReadonlyArray<readonly [keyof Theme, string]> = [
  ["bgColor", "--theme-bg"],
  ["selectionColor", "--theme-selection"],
  ["gridBorderColor", "--theme-grid-border"],
  ["proseColor", "--theme-prose-fg"],
  ["wireframeColor", "--theme-wireframe-fg"],
];

function syncCssVars(): void {
  // jsdom and SSR safety: bail if there's no document.
  if (typeof document === "undefined" || !document.documentElement) return;
  const style = document.documentElement.style;
  for (const [key, varName] of CSS_VAR_MAP) {
    style.setProperty(varName, theme[key] as string);
  }
}

// Initial CSS-var write so the DOM matches `theme` from module load.
syncCssVars();

// ── updateTheme / resetTheme ────────────────────────────────────────

/** Apply a patch synchronously, regenerate the snapshot, notify subscribers,
 * and write CSS variables. Returns the classification kind so callers (e.g.
 * the React subscriber) can decide whether to dispatch async reflow / paint. */
export function updateTheme(patch: Partial<Theme>): ThemeUpdateKind {
  const kind = classifyPatch(patch);
  Object.assign(theme, patch);
  _snapshot = Object.freeze({ ...theme });
  // Always sync CSS vars — even on paint/reflow patches that touch
  // proseColor / wireframeColor, the CSS mirror stays in lockstep.
  syncCssVars();
  notifyListeners(kind);
  return kind;
}

/** Restore every field to DEFAULT_THEME and notify subscribers.
 * Reset is classified as `reflow` because it potentially touches every field
 * (font sizes, multipliers, etc.) — the strongest possible action. */
export function resetTheme(): void {
  Object.assign(theme, DEFAULT_THEME);
  _snapshot = Object.freeze({ ...theme });
  syncCssVars();
  notifyListeners("reflow");
}

// ── Font helpers ────────────────────────────────────────────────────

/** Compose the prose-measurement font string from theme.
 * Used by Pretext (no fallback stack — Pretext warns system-ui is unsafe). */
export function proseFontMeasure(): string {
  return `${theme.proseFontSize}px ${theme.proseFontFamily}`;
}

/** Compose the prose-render font string from theme.
 * Includes a fallback for missing glyphs. */
export function proseFontRender(): string {
  return `${theme.proseFontSize}px ${theme.proseFontFamily}, sans-serif`;
}

/** Compose the wireframe font string from theme. */
export function wireframeFont(): string {
  return `${theme.wireframeFontSize}px ${theme.wireframeFontFamily}`;
}

// ── Persistence (Tauri store plugin) ────────────────────────────────
//
// The store plugin only works inside the Tauri runtime (it talks to a Rust
// host). In the Vite dev server (browser-only) and the gh-pages build, the
// import would 404. We detect Tauri at runtime via window.__TAURI_INTERNALS__
// and no-op gracefully outside it — defaults still work, just no persistence.

const STORE_FILE = "theme.json";
const STORE_KEY = "theme";

interface TauriStoreInstance {
  set(key: string, value: unknown): Promise<void>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  save(): Promise<void>;
}

let _storePromise: Promise<TauriStoreInstance | null> | null = null;

function isTauri(): boolean {
  // Tauri v2 sets window.__TAURI_INTERNALS__; checking for it avoids a hard
  // import failure in non-Tauri contexts. The plugin module IS bundled, but
  // its IPC calls fail without the Tauri host.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;
}

async function getStore(): Promise<TauriStoreInstance | null> {
  if (!isTauri()) return null;
  if (_storePromise) return _storePromise;
  _storePromise = (async () => {
    try {
      const mod = await import("@tauri-apps/plugin-store");
      // Tauri plugin-store v2 exposes `load(path)` returning a Store instance.
      return await mod.load(STORE_FILE) as unknown as TauriStoreInstance;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("theme: store plugin unavailable", err);
      return null;
    }
  })();
  return _storePromise;
}

// ── Validators ──────────────────────────────────────────────────────
// Per-field validation so a partial / corrupt theme.json falls back per-field
// instead of discarding the whole file.

const HEX_RE = /^#[0-9a-f]{3,8}$/i;
const isHex = (v: unknown): v is string => typeof v === "string" && HEX_RE.test(v);
const isFontSize = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 8 && v <= 32;
const isLineHeight = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 12 && v <= 48;
const isMul = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0.5 && v <= 3.0;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const VALIDATORS: { [K in keyof Theme]: (v: unknown) => v is Theme[K] } = {
  proseFontFamily: isStr,
  proseFontSize: isFontSize,
  proseLineHeight: isLineHeight,
  proseColor: isHex,
  wireframeFontFamily: isStr,
  wireframeFontSize: isFontSize,
  wireframeColor: isHex,
  charWidthMultiplier: isMul,
  charHeightMultiplier: isMul,
  bgColor: isHex,
  selectionColor: isHex,
  gridBorderColor: isHex,
};

/** Coerce an unknown loaded payload into a valid Theme by per-field validation.
 * Invalid fields fall back to DEFAULT_THEME individually. */
export function validatePersistedTheme(raw: unknown): Theme {
  const out: Theme = { ...DEFAULT_THEME };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(VALIDATORS) as (keyof Theme)[]) {
    const v = obj[key];
    if (VALIDATORS[key](v)) {
      // The validator narrowed v to Theme[key]. The type system can't follow
      // through an indexed validator dict, so cast through unknown once.
      (out as unknown as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

/** Load persisted theme from disk (Tauri only). Applies validated values
 * synchronously into `theme` and refreshes the snapshot. Returns true if
 * a persisted theme was loaded. Defaults remain in place if not. */
export async function loadTheme(): Promise<boolean> {
  const store = await getStore();
  if (!store) return false;
  try {
    const raw = await store.get(STORE_KEY);
    if (raw === undefined || raw === null) return false;
    const validated = validatePersistedTheme(raw);
    Object.assign(theme, validated);
    _snapshot = Object.freeze({ ...theme });
    syncCssVars();
    // Don't notify listeners here — the caller (DemoV2 init effect) runs
    // measureCellSize() right after this resolves, which is the same work the
    // reflow listener would do. Notifying would queue a redundant 100ms-
    // delayed runReflow on top of the explicit init measurement.
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("theme: loadTheme failed", err);
    return false;
  }
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 500;

/** Persist the current theme to disk (Tauri only). Debounced 500ms so
 * slider drags don't hammer the disk. */
export function scheduleSaveTheme(): void {
  if (!isTauri()) return;
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    void (async () => {
      const store = await getStore();
      if (!store) return;
      try {
        await store.set(STORE_KEY, { ...theme });
        await store.save();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("theme: save failed", err);
      }
    })();
  }, SAVE_DEBOUNCE_MS);
}

// Wire the auto-save into every updateTheme / resetTheme.
subscribe(() => { scheduleSaveTheme(); });
