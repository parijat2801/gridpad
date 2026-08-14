/**
 * DemoV2 — Frame-based spatial canvas. Thin shell using frame.ts + frameRenderer.ts.
 */
import { useEffect, useRef, useState } from "react";
import { buildPreparedCache, type PreparedCache } from "./preparedCache";
import type { EditorState } from "@codemirror/state";
import { Transaction, type StateEffect } from "@codemirror/state";
import {
  createEditorStateUnified, getDoc, getFrames,
  selectFrameEffect, getSelectedId,
  moveFrameEffect, resizeFrameEffect, setZEffect,
  applyAddTopLevelFrame, applyAddChildFrame, applyReparentFrame, applyDeleteFrame, applyClearDirty,
  proseInsert, proseDeleteBefore, moveCursorTo, getCursor,
  proseMoveLeft, proseMoveRight, proseMoveUp, proseMoveDown,
  proseMoveToLineStart, proseMoveToLineEnd,
  editorUndo, editorRedo,
  setTextEditEffect, editTextFrameEffect, getTextEdit,
  resolveSelectionTarget, decideSelectionForMouseDown, decideReparent, landingGridFromCursor, shouldEscalateResidual, findImmediateParent, findFrameInList,
  findContainingBandDeep, getBandRelativeRow, getBandRelativeCol,
  docDiffersFrom,
  type CursorPos,
  type ReparentDecision,
} from "./editorState";
import { UnsavedChangesModal } from "./UnsavedChangesModal";
import { serializeUnified } from "./serializeUnified";
import { createFileBackend, type FileBackend } from "./fileBackend";
import { type Frame, hitTestFrames, resizeFrame, createRectFrame, createLineFrame, createTextFrame, recomputePixelFields } from "./frame";
import { renderFrame, renderFrameSelection } from "./frameRenderer";
import { setTextAlignEffect } from "./editorState";
import { reflowLayout, type PositionedLine } from "./reflowLayout";
import { findCursorLine } from "./cursorFind";
import { measureCellSize, getCharWidth, getCharHeight } from "./grid";
import { ensureProseFontReady, proseFontRender } from "./textFont";
import { theme, subscribe as subscribeTheme, loadTheme, wireframeFont, type ThemeUpdateKind } from "./theme";
import { ThemePanel } from "./ThemePanel";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type ResizeHandle = "tl" | "tm" | "tr" | "ml" | "mr" | "bl" | "bm" | "br";
interface HandleRect { handle: ResizeHandle; x: number; y: number; w: number; h: number; }
const HANDLE_HIT = 24;
const HANDLE_HALF_HIT = HANDLE_HIT / 2;
const RESIZE_CURSOR_MAP: Record<ResizeHandle, string> = {
  tl: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", br: "nwse-resize",
  tm: "ns-resize", bm: "ns-resize", ml: "ew-resize", mr: "ew-resize",
};

function computeHandleRects(absX: number, absY: number, fw: number, fh: number): HandleRect[] {
  const pts: [ResizeHandle, number, number][] = [
    ["tl", absX, absY], ["tm", absX + fw / 2, absY], ["tr", absX + fw, absY],
    ["ml", absX, absY + fh / 2], ["mr", absX + fw, absY + fh / 2],
    ["bl", absX, absY + fh], ["bm", absX + fw / 2, absY + fh], ["br", absX + fw, absY + fh],
  ];
  return pts.map(([handle, cx, cy]) => ({ handle, x: cx - HANDLE_HALF_HIT, y: cy - HANDLE_HALF_HIT, w: HANDLE_HIT, h: HANDLE_HIT }));
}

function hitTestHandle(rects: HandleRect[], px: number, py: number): ResizeHandle | null {
  for (const r of rects) {
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r.handle;
  }
  return null;
}

// Top-level wireframes shrink-wrap around their internals — resizing the
// outer box has no effect (the auto-layout pass overwrites any change).
// Hide handles so the user resizes the children instead. A "top-level
// wireframe" is a content-less, non-band frame whose immediate parent is
// a band (i.e. depth 1 under the eager-band wrapper).
function isTopLevelWireframe(frame: Frame, frames: Frame[]): boolean {
  if (frame.isBand || frame.content !== null) return false;
  const parent = findImmediateParent(frames, frame.id);
  return parent?.isBand === true;
}

function shouldShowResizeHandles(frame: Frame, frames: Frame[]): boolean {
  if (frame.content?.type === "text") return false;
  if (isTopLevelWireframe(frame, frames)) return false;
  return true;
}

const DEFAULT_TEXT = `# Gridpad

Where ASCII wireframes come alive. Drag any box to see prose reflow around it. Resize from edges. Click anywhere to type. Press R to draw rectangles, L for lines, V to go back to select mode.



## Dashboard Layout

A classic three-column web app. Drag the sidebar or panels to watch text reflow in real time around the wireframe obstacles.



┌───────────────────────────────────────────────────────┐
│                      My App                           │
├───────────┬───────────────────────────┬───────────────┤
│ Nav       │  Main Content             │  Details      │
│           │                           │               │
│ Home      │  ┌─────────────────────┐  │  User: Alice  │
│ Search    │  │  Revenue Chart      │  │  Role: Admin  │
│ Settings  │  │  ████▓▓░░           │  │               │
│ Help      │  └─────────────────────┘  │  ┌─────────┐  │
│           │                           │  │ Actions │  │
│           │  ┌──────────┐ ┌────────┐  │  │ Edit    │  │
│           │  │ Users    │ │ Tasks  │  │  │ Delete  │  │
│           │  │ 1,204    │ │ 38     │  │  └─────────┘  │
│           │  └──────────┘ └────────┘  │               │
└───────────┴───────────────────────────┴───────────────┘



The text you are reading reflows dynamically around every wireframe on this page. Try dragging the dashboard above and the paragraphs will rearrange themselves to fill the remaining space. This is the core idea behind Gridpad: prose and wireframes coexist on a single canvas, each aware of the other.



## Mobile App

A phone-sized screen with header, content area, and bottom navigation bar.



┌──────────────────┐
│   My App    ≡    │
├──────────────────┤
│                  │
│  Welcome back!   │
│                  │
│  ┌────────────┐  │
│  │  Profile   │  │
│  │  ┌──────┐  │  │
│  │  │ IMG  │  │  │
│  │  └──────┘  │  │
│  └────────────┘  │
│                  │
├──────────────────┤
│ ⌂    ☆    ✉    ⚙ │
└──────────────────┘



## User Flow

A simple flowchart showing navigation between screens. Drag the boxes to rearrange the flow.



┌─────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│  Login  │────│ Dashboard │────│ Settings │────│  Logout  │
└─────────┘    └───────────┘    └──────────┘    └──────────┘



Every element on this page is interactive. Wireframes are detected from plain ASCII box-drawing characters, no special syntax needed. Open your own markdown file with Cmd+O to try it on your own documents.



## Sign Up Form

A form wireframe. Double-click the text labels inside frames to edit them inline.



┌──────────────────────────┐
│      Create Account      │
├──────────────────────────┤
│                          │
│  Name:  ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
│  Email: ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
│  Pass:  ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
│                          │
│     ┌──────────────┐     │
│     │   Sign Up    │     │
│     └──────────────┘     │
│                          │
└──────────────────────────┘`;

interface DragState {
  frameId: string; startX: number; startY: number;
  startFrameX: number; startFrameY: number; startFrameW: number; startFrameH: number;
  hasMoved: boolean; resizeHandle?: ResizeHandle;
  // Strategy A (Fix 1): true when onMouseDown skipped the selection rule
  // because the hit was the current selection or a descendant. If
  // hasMoved stays false through mouseup, we drill via the rule THEN.
  deferredDrillHit?: Frame;
  // Fix 5: gesture-level state — true once any tick has produced
  // clamped vertical motion of the dragged rect inside its band. Used
  // by shouldEscalateResidual to avoid rotating the band when the rect
  // was at the wall from the first tick.
  gestureHadClampedMotion?: boolean;
  // Fix 9: snapshot of EditorState at mousedown. Used by commitCumulativeDrag
  // to apply a single history-recorded transaction from pre-drag → post-drag.
  mouseDownState?: EditorState;
}

type ToolName = "select" | "rect" | "line" | "text";
const TOOL_BUTTONS: { tool: ToolName; label: string }[] = [
  { tool: "select", label: "↖ V" }, { tool: "rect", label: "□ R" },
  { tool: "line", label: "╱ L" }, { tool: "text", label: "T T" },
];

export default function DemoV2() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<EditorState>(null!);
  const [ready, setReady] = useState(false);
  const framesRef = useRef<Frame[]>([]);
  const proseRef = useRef("");
  const preparedRef = useRef<PreparedCache>([]);
  const linesRef = useRef<PositionedLine[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const cwRef = useRef(0);
  const chRef = useRef(0);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const activeToolRef = useRef<ToolName>("select");
  const [activeTool, setActiveTool] = useState<ToolName>("select");
  // Debug overlay: tints synthetic eager-bands magenta. Off by default.
  const showBandsRef = useRef<boolean>(false);
  const [showBands, setShowBands] = useState<boolean>(false);
  // Debug overlay: tints scanner-created wireframe-wrappers cyan so the
  // shared parent that blocks drop-on-sibling reparent is visible.
  const showWrappersRef = useRef<boolean>(false);
  const [showWrappers, setShowWrappers] = useState<boolean>(false);
  const [canvasCursor, setCanvasCursor] = useState("default");
  const proseCursorRef = useRef<CursorPos | null>(null);
  const blinkRef = useRef(true);
  const textEditRef = useRef<{ frameId: string; col: number } | null>(null);
  const lastClickRef = useRef<{ time: number; px: number; py: number } | null>(null);
  const drawPreviewRef = useRef<{ startX: number; startY: number; curX: number; curY: number; parentId: string | null } | null>(null);
  const textPlacementRef = useRef<{ x: number; y: number; chars: string; parentId: string | null } | null>(null);
  const [backend, setBackend] = useState<FileBackend | null>(null);
  useEffect(() => {
    let cancelled = false;
    void createFileBackend().then(b => {
      if (!cancelled) setBackend(b);
    });
    return () => { cancelled = true; };
  }, []);

  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [docDirty, setDocDirty] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const [themePanelOpen, setThemePanelOpen] = useState(false);

  function buildTitle(path: string | null, dirty: boolean): string {
    if (!path) return "Gridpad";
    const base = path.split(/[/\\]/).pop() ?? path;
    return dirty ? `${base} ● Gridpad` : `${base} — Gridpad`;
  }

  function pushTitle(path: string | null, dirty: boolean): void {
    document.title = buildTitle(path, dirty);
    backend?.setTitle(buildTitle(path, dirty));
  }

  function markDirty(): void {
    if (!docDirty) {
      setDocDirty(true);
      pushTitle(currentPath, true);
    }
  }

  // `pathOverride` is for callers that just resolved a new path mid-async
  // (loadFromPath, Cmd+Shift+S) — the closure's `currentPath` is stale at
  // that moment because setCurrentPath() hasn't flushed yet. Without it the
  // titlebar briefly shows the previous file.
  function markClean(pathOverride?: string | null): void {
    setDocDirty(false);
    pushTitle(pathOverride !== undefined ? pathOverride : currentPath, false);
  }

  // Centralized seam — every doc-mutating helper (apply*/editorUndo/
  // editorRedo/proseInsert/proseDeleteBefore) routes through this wrapper
  // so dirty-tracking observes doc changes once. Selection-only and
  // effect-only sites (selectFrameEffect, setTextEditEffect, proseMove*)
  // can't change the doc and stay as direct .update() calls.
  // See T7 of the tauri-shell plan for the rationale.
  function applyAndTrack(producer: (prev: EditorState) => EditorState): void {
    const prev = stateRef.current;
    const next = producer(prev);
    stateRef.current = next;
    if (docDiffersFrom(prev, next)) markDirty();
  }

  async function saveCurrent(): Promise<void> {
    if (!backend) return;
    // Snapshot the state-at-save-start. If the user edits between now and
    // when backend.saveFile() resolves, those edits aren't on disk and we
    // must keep the doc dirty.
    const snapshot = stateRef.current;
    const md = serializeUnified(getDoc(snapshot), getFrames(snapshot));
    await backend.saveFile(md);
    stateRef.current = applyClearDirty(stateRef.current);
    syncRefsFromState();
    if (!docDiffersFrom(snapshot, stateRef.current)) {
      markClean();
    }
  }

  async function loadFromPath(path: string): Promise<void> {
    if (!backend) return;
    const text = await backend.readFileByPath(path);
    if (text === null) {
      console.error("readFileByPath returned null for", path);
      return;
    }
    loadDocument(text);
    doLayout(); paint();
    setCurrentPath(path);
    // Pass explicit path: setCurrentPath hasn't flushed by the time
    // markClean → pushTitle reads currentPath from this closure.
    markClean(path);
  }

  function handleOpenRequest(path: string): void {
    if (!docDirty) {
      void loadFromPath(path);
      return;
    }
    setPendingPath(path);
    setShowUnsavedModal(true);
  }

  useEffect(() => {
    if (!backend) return;
    const unsub = backend.subscribeToOpenRequest(handleOpenRequest);
    return unsub;
    // handleOpenRequest closes over docDirty/backend/currentPath — all are
    // dependencies because the closure's behavior changes when any of them
    // does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, docDirty, currentPath]);
  function setTool(t: ToolName) { activeToolRef.current = t; setActiveTool(t); drawPreviewRef.current = null; textPlacementRef.current = null; }

  function loadDocument(text: string) {
    const cw = cwRef.current, ch = chRef.current;
    stateRef.current = createEditorStateUnified(text, cw, ch);
    syncRefsFromState();
    dragRef.current = null;
    proseCursorRef.current = null;
  }

  /** Refresh framesRef + proseRef + preparedRef from the current EditorState.
   * Call after any mutation that goes through unifiedDocSync (drag, resize,
   * delete, add) so the prepared-line cache reflects the post-mutation doc. */
  function syncRefsFromState() {
    const proseText = getDoc(stateRef.current);
    proseRef.current = proseText;
    framesRef.current = getFrames(stateRef.current);
    preparedRef.current = buildPreparedCache(proseText);
  }

  // The unified document advances prose and wireframe rows at the same rate
  // so frames sit cleanly between prose blocks at any zoom level. That rate
  // is `ch` (the wireframe cell height — see `measureCellSize` in grid.ts),
  // which already responds to the `charHeightMultiplier` knob in the theme
  // panel. The legacy `theme.proseLineHeight` field is preserved for
  // forward-compat with persisted theme.json files but is no longer driven
  // by the UI; it's kept here only so the canvas-side cursor blink rect can
  // pick a sensible glyph height if the wireframe ch ever drifts below it.
  function effectiveProseLineHeight(): number {
    return chRef.current;
  }

  function doLayout() {
    if (!stateRef.current) { linesRef.current = []; return; }
    const ch = chRef.current;
    const plh = effectiveProseLineHeight();
    const frames = getFrames(stateRef.current);

    // Build set of claimed line numbers (0-based)
    const claimedLines = new Set<number>();
    for (const f of frames) {
      if (f.lineCount === 0) continue;
      const startLine = stateRef.current.doc.lineAt(f.docOffset).number - 1;
      for (let i = 0; i < f.lineCount; i++) claimedLines.add(startLine + i);
    }

    // Build preparedLines: null for claimed lines, prepared text for prose
    const prepared = preparedRef.current;
    const adjusted = prepared.map((p, i) => claimedLines.has(i) ? null : p);

    // Prose lines and wireframe rows advance at the same rate (`ch`) — the
    // unified-document invariant. plh === ch by construction, so the prose
    // line.y values produced by reflow line up exactly with the f.y values
    // assigned in the second pass below.
    linesRef.current = reflowLayout(adjusted, sizeRef.current.w, plh, []).lines;

    // Set frame pixel Y from lineTop accumulator
    let lineTop = 0;
    const doc = stateRef.current.doc;
    for (let i = 0; i < doc.lines; i++) {
      if (claimedLines.has(i)) {
        for (const f of frames) {
          if (f.lineCount === 0) continue;
          const startLine = doc.lineAt(f.docOffset).number - 1;
          if (i === startLine) {
            f.y = lineTop;
            f.x = f.gridCol * cwRef.current;
          }
        }
        lineTop += ch;
      } else {
        const visualLines = linesRef.current.filter(l => l.sourceLine === i);
        lineTop += Math.max(visualLines.length, 1) * plh;
      }
    }
  }

  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!stateRef.current) return;
    const { w, h: viewH } = sizeRef.current;
    let contentH = 100;
    const plh = effectiveProseLineHeight();
    for (const line of linesRef.current) contentH = Math.max(contentH, line.y + plh);
    for (const f of framesRef.current) contentH = Math.max(contentH, f.y + f.h);
    contentH = Math.max(contentH + 40, viewH);
    // Update scroll spacer to enable scrolling over full content
    const spacer = canvas.parentElement?.querySelector("[data-spacer]") as HTMLElement | null;
    if (spacer) spacer.style.height = `${contentH}px`;
    const scrollTop = canvas.parentElement?.scrollTop ?? 0;
    // Canvas is viewport-sized (never exceeds GPU limits), drawing is offset by scrollTop
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.floor(w * dpr), ph = Math.floor(viewH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext("2d")!;
    // Clear entire canvas in device space first (no transform)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.bgColor; ctx.fillRect(0, 0, pw, ph);
    // DPR scaling, then translate by scroll offset in CSS coords
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(0, -scrollTop);
    ctx.font = proseFontRender(); ctx.fillStyle = theme.proseColor; ctx.textBaseline = "top";
    // Viewport culling — only draw visible content. Pad by max(ch, plh) so
    // both prose and wireframe rows partially-on-screen still render.
    const cullPad = Math.max(chRef.current, plh);
    const viewTop = scrollTop - cullPad;
    const viewBot = scrollTop + viewH + cullPad;
    for (const line of linesRef.current) {
      if (line.y + plh >= viewTop && line.y <= viewBot) ctx.fillText(line.text, line.x, line.y);
    }
    const cw = cwRef.current, ch = chRef.current;
    for (const frame of framesRef.current) {
      if (frame.y + frame.h >= viewTop && frame.y <= viewBot) renderFrame(ctx, frame, 0, 0, cw, ch, showBandsRef.current, showWrappersRef.current);
    }
    const selectedId = getSelectedId(stateRef.current);
    if (selectedId) {
      const sel = findFrameById(framesRef.current, selectedId);
      if (sel) {
        const showHandles = shouldShowResizeHandles(sel.frame, framesRef.current);
        renderFrameSelection(ctx, sel.frame, sel.absX, sel.absY, showHandles);
      }
    }
    // Prose cursor (blinking) — uses prose line-height, not wireframe ch.
    const cursor = proseCursorRef.current;
    if (cursor && blinkRef.current) {
      ctx.font = proseFontRender();
      const pos = findCursorLine(cursor, linesRef.current, (s) => ctx.measureText(s).width, plh);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(pos.x, pos.y, 2, plh);
    }
    // Text frame cursor (blinking)
    const te = textEditRef.current;
    if (te && blinkRef.current) {
      const found = findFrameById(framesRef.current, te.frameId);
      if (found && found.frame.content?.type === "text") {
        const charWidth = getCharWidth();
        const charHeight = chRef.current;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(found.absX + te.col * charWidth, found.absY, 2, charHeight);
      }
    }
    // Ghost overflow for text being edited inside a rect
    const teGhost = textEditRef.current;
    if (teGhost) {
      const found = findFrameById(framesRef.current, teGhost.frameId);
      if (found && found.frame.content?.type === "text" && found.frame.content.text) {
        // Measure with correct font before checking overflow
        ctx.font = wireframeFont();
        const textWidth = ctx.measureText(found.frame.content.text).width;
        // Check against frame width (parent clip handles the rest)
        if (textWidth > found.frame.w) {
          ctx.save();
          ctx.globalAlpha = 0.4;
          ctx.font = wireframeFont();
          ctx.fillStyle = theme.wireframeColor;
          ctx.textBaseline = "top";
          ctx.fillText(found.frame.content.text, found.absX, found.absY);
          ctx.restore();
        }
      }
    }
    // Drawing tool preview + text placement
    const preview = drawPreviewRef.current;
    if (preview) {
      const x1 = Math.min(preview.startX, preview.curX), y1 = Math.min(preview.startY, preview.curY);
      const x2 = Math.max(preview.startX, preview.curX), y2 = Math.max(preview.startY, preview.curY);
      ctx.save(); ctx.strokeStyle = "#4a90e2"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      if (activeToolRef.current === "rect") { ctx.strokeRect(x1, y1, x2 - x1, y2 - y1); }
      else { ctx.beginPath(); ctx.moveTo(preview.startX, preview.startY); ctx.lineTo(preview.curX, preview.curY); ctx.stroke(); }
      ctx.restore();
    }
    const tp = textPlacementRef.current;
    if (tp) {
      const cw2 = cwRef.current, ch2 = chRef.current;
      ctx.save(); ctx.strokeStyle = "#4a90e2"; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.strokeRect(tp.x, tp.y, Math.max(1, [...tp.chars].length) * cw2, ch2); ctx.setLineDash([]);
      if (tp.chars.length > 0) { ctx.fillStyle = theme.wireframeColor; ctx.font = wireframeFont(); ctx.textBaseline = "top"; ctx.fillText(tp.chars, tp.x, tp.y); }
      ctx.restore();
    }
  }

  function findFrameById(frames: Frame[], id: string, px = 0, py = 0): { frame: Frame; absX: number; absY: number } | null {
    for (const f of frames) {
      const ax = px + f.x, ay = py + f.y;
      if (f.id === id) return { frame: f, absX: ax, absY: ay };
      const child = findFrameById(f.children, id, ax, ay);
      if (child) return child;
    }
    return null;
  }


  function proseCursorFromClick(px: number, py: number): CursorPos | null {
    if (linesRef.current.length === 0) return null;
    // Find closest visual line — vertical distance first, horizontal tie-break.
    // Vertical centre uses the same floored line-height that reflow used to
    // position lines, so the click→line mapping doesn't drift when the user
    // sets proseLineHeight below proseFontSize.
    const plh = effectiveProseLineHeight();
    let best: PositionedLine | null = null;
    let bestDist = Infinity;
    const candidates: PositionedLine[] = [];
    let minVDist = Infinity;

    for (const pl of linesRef.current) {
      const vDist = Math.abs(pl.y + plh / 2 - py);
      if (vDist < minVDist) minVDist = vDist;
    }
    // Collect all lines within 1px of the best vertical distance (same y-band)
    for (const pl of linesRef.current) {
      const vDist = Math.abs(pl.y + plh / 2 - py);
      if (vDist <= minVDist + 1) candidates.push(pl);
    }
    if (candidates.length === 1) {
      best = candidates[0];
    } else {
      // Multi-slot tie-break: prefer the slot that contains px horizontally
      for (const pl of candidates) {
        if (px >= pl.x && px <= pl.x + pl.width) { best = pl; break; }
      }
      // If px is outside all slots, pick nearest by horizontal distance
      if (!best) {
        for (const pl of candidates) {
          const hDist = px < pl.x ? pl.x - px : px > pl.x + pl.width ? px - pl.x - pl.width : 0;
          if (hDist < bestDist) { bestDist = hDist; best = pl; }
        }
      }
    }
    if (!best) return null;

    // Use sourceLine/sourceCol — the EditorState-compatible coordinates
    const row = best.sourceLine;

    // Binary search for clicked grapheme using proportional font measurement
    const graphemes = [...graphemeSegmenter.segment(best.text)];
    let clickCol = graphemes.length; // default: click past end of line
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d")!;
      ctx.font = proseFontRender();
      const relX = px - best.x;
      for (let g = 0; g < graphemes.length; g++) {
        const prefix = graphemes.slice(0, g + 1).map(s => s.segment).join("");
        const w = ctx.measureText(prefix).width;
        if (w > relX) {
          // Check if click is closer to this grapheme or the previous one
          const prevW = g > 0 ? ctx.measureText(graphemes.slice(0, g).map(s => s.segment).join("")).width : 0;
          clickCol = (relX - prevW) < (w - relX) ? g : g + 1;
          break;
        }
      }
    }
    const col = best.sourceCol + Math.min(clickCol, graphemes.length);

    // Clamp against actual source line length (grapheme count)
    const state = stateRef.current;
    if (!state) return null;
    const clampedRow = Math.min(Math.max(row, 0), state.doc.lines - 1);
    const lineText = state.doc.line(clampedRow + 1).text;
    const lineGraphemes = [...graphemeSegmenter.segment(lineText)].length;
    const clampedCol = Math.min(col, lineGraphemes);
    return { row: clampedRow, col: clampedCol };
  }

  function onMouseDown(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + (canvas.parentElement?.scrollTop ?? 0);
    const tool = activeToolRef.current;
    // Single hit-test for the whole click handler
    const hit = hitTestFrames(framesRef.current, px, py);
    // Resolve nest parent for draw-on-frame: the SMALLEST enclosing claiming
    // frame at the click. hitTestFrames already returns the min-area child,
    // so when there's a hit, that's our nest target (Figma-style nesting
    // into a rect inside a band). When there's no hit (empty band space),
    // fall back to the band that claims the click row.
    let nestParent: Frame | null = hit;
    if (!nestParent) {
      for (const f of framesRef.current) {
        if (f.isBand
            && py >= f.y && py < f.y + f.h
            && px >= f.x && px < f.x + f.w) {
          nestParent = f;
          break;
        }
      }
    }
    if (tool === "rect" || tool === "line") {
      // Draw activates whether or not we hit a frame. If we hit one, the new
      // frame nests as a child of the smallest enclosing claiming frame
      // (Figma-style: rect-in-band → nest in rect; band space → nest in band).
      drawPreviewRef.current = { startX: px, startY: py, curX: px, curY: py, parentId: nestParent?.id ?? null };
      paint(); return;
    }
    if (tool === "text") {
      const cw = cwRef.current, ch = chRef.current;
      const snappedX = Math.floor(px / cw) * cw, snappedY = Math.floor(py / ch) * ch;
      textPlacementRef.current = { x: snappedX, y: snappedY, chars: "", parentId: nestParent?.id ?? null };
      paint(); return;
    }
    const currentSelectedId = getSelectedId(stateRef.current);
    if (currentSelectedId) {
      const sel = findFrameById(framesRef.current, currentSelectedId);
      // Skip handle hit-test for frames that don't show handles: text-content
      // frames (content-derived size, the 24×24 hit boxes would block the
      // dblclick-to-edit path), and top-level wireframes (shrink-wrapped).
      if (sel && shouldShowResizeHandles(sel.frame, framesRef.current)) {
        const handleHit = hitTestHandle(computeHandleRects(sel.absX, sel.absY, sel.frame.w, sel.frame.h), px, py);
        if (handleHit) {
          dragRef.current = { frameId: sel.frame.id, startX: px, startY: py, startFrameX: sel.absX, startFrameY: sel.absY, startFrameW: sel.frame.w, startFrameH: sel.frame.h, hasMoved: false, resizeHandle: handleHit, mouseDownState: stateRef.current };
          paint(); return;
        }
      }
    }
    // Strategy A (Fix 1 — DEBUG_PLAN.md): a mouse-down on the current
    // selection (or one of its descendants) is the head of a drag of the
    // existing selection. Don't run the selection rule yet — keep the
    // target as-is and remember the hit for deferred drilling. If the
    // gesture turns out to be a discrete click (no movement), onMouseUp
    // runs resolveSelectionTarget THEN, drilling one level. This separates
    // "discrete click drills" from "drag respects selection" (Figma).
    const ctrlHeld = e.ctrlKey || e.metaKey;
    const decision = hit
      ? decideSelectionForMouseDown(hit, currentSelectedId, framesRef.current, ctrlHeld)
      : null;
    const targetId = decision?.frameId ?? null;
    const now = Date.now();
    const last = lastClickRef.current;
    const isDblClick = last !== null && now - last.time < 300 && Math.abs(px - last.px) < 10 && Math.abs(py - last.py) < 10;
    lastClickRef.current = { time: now, px, py };
    if (hit && targetId && decision) {
      if (isDblClick && hit.content?.type === "text") {
        const found = findFrameById(framesRef.current, hit.id);
        if (found) {
          const cw2 = getCharWidth(), text = hit.content.text ?? "";
          const textLen = Math.max(0, Math.min(Math.round((px - found.absX) / cw2), [...text].length));
          stateRef.current = stateRef.current.update({
            effects: [selectFrameEffect.of(hit.id), setTextEditEffect.of({ frameId: hit.id, col: textLen })],
          }).state;
          textEditRef.current = getTextEdit(stateRef.current); // sync for paint
          proseCursorRef.current = null; dragRef.current = null;
          blinkRef.current = true; canvas.focus(); paint(); return;
        }
      }
      // For "applyRule" (fresh click) commit the new selection now. For
      // "preserveSelection" (drag-start of current selection), leave
      // selection unchanged — the dragRef carries the target, and the
      // mouseup branch may drill if no movement occurred.
      if (decision.kind === "applyRule") {
        stateRef.current = stateRef.current.update({ effects: selectFrameEffect.of(targetId) }).state;
      }
      proseCursorRef.current = null; textEditRef.current = null;
      const found = findFrameById(framesRef.current, targetId);
      if (found) {
        dragRef.current = {
          frameId: targetId, startX: px, startY: py,
          startFrameX: found.absX, startFrameY: found.absY,
          startFrameW: found.frame.w, startFrameH: found.frame.h,
          hasMoved: false,
          deferredDrillHit: decision.kind === "preserveSelection" ? hit : undefined,
          mouseDownState: stateRef.current,
        };
      }
      paint();
    } else {
      stateRef.current = stateRef.current.update({ effects: selectFrameEffect.of(null) }).state;
      dragRef.current = null;
      textEditRef.current = null;
      const cursor = proseCursorFromClick(px, py);
      proseCursorRef.current = cursor;
      if (cursor) stateRef.current = moveCursorTo(stateRef.current, cursor);
      blinkRef.current = true; paint();
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + (canvas.parentElement?.scrollTop ?? 0);
    if (drawPreviewRef.current) { drawPreviewRef.current = { ...drawPreviewRef.current, curX: px, curY: py }; paint(); return; }
    const drag = dragRef.current;
    if (!drag) {
      // Dynamic cursor — hover detection when no drag active
      const selectedId = getSelectedId(stateRef.current);
      if (selectedId) {
        const sel = findFrameById(framesRef.current, selectedId);
        if (sel && shouldShowResizeHandles(sel.frame, framesRef.current)) {
          const handle = hitTestHandle(computeHandleRects(sel.absX, sel.absY, sel.frame.w, sel.frame.h), px, py);
          if (handle) {
            setCanvasCursor(RESIZE_CURSOR_MAP[handle]);
          } else {
            setCanvasCursor(hitTestFrames(framesRef.current, px, py) ? "grab" : "text");
          }
        } else if (sel) {
          // Frame doesn't show handles (text label or top-level wireframe).
          setCanvasCursor(hitTestFrames(framesRef.current, px, py) ? "grab" : "text");
        } else { setCanvasCursor("text"); }
      } else {
        setCanvasCursor(hitTestFrames(framesRef.current, px, py) ? "grab" : "text");
      }
      return;
    }
    const dx = px - drag.startX, dy = py - drag.startY;
    if (!drag.hasMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.hasMoved = true;
    if (drag.resizeHandle) {
      setCanvasCursor(RESIZE_CURSOR_MAP[drag.resizeHandle]);
    } else { setCanvasCursor("grabbing"); }
    const found = findFrameById(framesRef.current, drag.frameId);
    if (!found) return;
    if (drag.resizeHandle) {
      const cw = cwRef.current, ch = chRef.current;
      const h = drag.resizeHandle, sw = drag.startFrameW, sh = drag.startFrameH;
      let newW = sw, newH = sh, newDx = 0, newDy = 0;
      if (h === "br") { newW = sw + dx; newH = sh + dy; }
      else if (h === "bl") { newW = sw - dx; newH = sh + dy; newDx = dx; }
      else if (h === "tr") { newW = sw + dx; newH = sh - dy; newDy = dy; }
      else if (h === "tl") { newW = sw - dx; newH = sh - dy; newDx = dx; newDy = dy; }
      else if (h === "bm") { newH = sh + dy; }
      else if (h === "tm") { newH = sh - dy; newDy = dy; }
      else if (h === "mr") { newW = sw + dx; }
      else if (h === "ml") { newW = sw - dx; newDx = dx; }
      const newGridW = Math.max(2, Math.round(newW / cw));
      const newGridH = Math.max(2, Math.round(newH / ch));
      const resized = resizeFrame(found.frame, { gridW: newGridW, gridH: newGridH }, cw, ch);
      const anchorX = drag.startFrameX + (newDx !== 0 ? drag.startFrameW : 0);
      const anchorY = drag.startFrameY + (newDy !== 0 ? drag.startFrameH : 0);
      const newAbsX = newDx !== 0 ? anchorX - resized.w : drag.startFrameX;
      const newAbsY = newDy !== 0 ? anchorY - resized.h : drag.startFrameY;
      const parentOffX = found.absX - found.frame.x, parentOffY = found.absY - found.frame.y;
      const moveDx = newAbsX - parentOffX - found.frame.x;
      const moveDy = newAbsY - parentOffY - found.frame.y;
      const moveGridDCol = Math.round(moveDx / cw);
      const moveGridDRow = Math.round(moveDy / ch);
      const effects = [
        resizeFrameEffect.of({ id: drag.frameId, gridW: newGridW, gridH: newGridH, charWidth: cw, charHeight: ch }),
        moveFrameEffect.of({ id: drag.frameId, dCol: moveGridDCol, dRow: moveGridDRow, charWidth: cw, charHeight: ch }),
      ];
      stateRef.current = stateRef.current.update({
        effects,
        annotations: [Transaction.addToHistory.of(false)],
      }).state;
      syncRefsFromState();
    } else {
      // Compute target position from drag start + mouse delta, snapped to grid
      const cw = cwRef.current, ch = chRef.current;
      const targetCol = Math.round(Math.max(0, drag.startFrameX + dx) / cw);
      const targetRow = Math.round(Math.max(0, drag.startFrameY + dy) / ch);
      const currentCol = Math.round(found.absX / cw);
      const currentRow = Math.round(found.absY / ch);
      const dCol = targetCol - currentCol;
      const dRow = targetRow - currentRow;
      if (dCol !== 0 || dRow !== 0) {
        // Eager-bands drag policy:
        // - For a top-level claiming frame (no parent), unifiedDocSync
        //   handles drag via rotation-only (bounded by surrounding blank
        //   lines around the claim).
        // - For a rect inside a band (parent.isBand), clamp the rect's
        //   parent-relative motion against band bounds first; if the user
        //   pushed past the band edge, escalate the residual to a
        //   moveFrameEffect on the BAND itself — that triggers the band's
        //   own rotation-only logic. If the band has no rotation budget,
        //   the residual is silently dropped (frame stops at band edge,
        //   which propagates "bounded between prose" through to children).
        const containingBand = findContainingBandDeep(framesRef.current, drag.frameId);
        const effects: StateEffect<unknown>[] = [];
        if (containingBand) {
          const child = found.frame;
          const bandRow = getBandRelativeRow(drag.frameId, containingBand.id, framesRef.current);
          const bandCol = getBandRelativeCol(drag.frameId, containingBand.id, framesRef.current);
          const minDRow = -bandRow;
          const maxDRow = containingBand.gridH - child.gridH - bandRow;
          const minDCol = -bandCol;
          const maxDCol = containingBand.gridW - child.gridW - bandCol;
          const clampedDRow = Math.max(minDRow, Math.min(maxDRow, dRow));
          const clampedDCol = Math.max(minDCol, Math.min(maxDCol, dCol));
          const residualDRow = dRow - clampedDRow;
          // Horizontal residual has no rotation analog (no column to swap),
          // so dCol motion past the band's horizontal edge is dropped.
          if (clampedDRow !== 0 || clampedDCol !== 0) {
            effects.push(moveFrameEffect.of({ id: drag.frameId, dCol: clampedDCol, dRow: clampedDRow, charWidth: cw, charHeight: ch }));
          }
          if (clampedDRow !== 0) drag.gestureHadClampedMotion = true;
          // Band slack = vertical room for the rect inside the band.
          // bandSiblings = number of immediate siblings of the dragged
          // rect — counted at its parent (which may be the band itself
          // OR a wireframe wrapper inside the band, e.g., side-by-side
          // rects share a wireframe parent, not the band). Excludes
          // text-content children (labels), which aren't draggable
          // wireframes.
          const bandSlackRows = containingBand.gridH - child.gridH;
          const dragParent = findImmediateParent(framesRef.current, drag.frameId);
          const bandSiblings = dragParent
            ? dragParent.children.filter(c => c.content?.type !== "text").length
            : 1;
          if (shouldEscalateResidual(clampedDRow, residualDRow, drag.gestureHadClampedMotion ?? false, bandSlackRows, bandSiblings)) {
            effects.push(moveFrameEffect.of({ id: containingBand.id, dCol: 0, dRow: residualDRow, charWidth: cw, charHeight: ch }));
          }
        } else {
          effects.push(moveFrameEffect.of({ id: drag.frameId, dCol, dRow, charWidth: cw, charHeight: ch }));
        }
        if (effects.length > 0) {
          stateRef.current = stateRef.current.update({
            effects,
            annotations: [Transaction.addToHistory.of(false)],
          }).state;
          syncRefsFromState();
        }
      }
    }
    doLayout(); paint();
  }

  // Fix 9 helper: compute the cumulative-drag effects from mouseDownState's
  // snapshot vs the current per-tick state. Returns the effects so the caller
  // can either dispatch them alone (commitCumulativeDrag, no-reparent path)
  // OR fold them into the reparent transaction (Bug E fix, drag-and-reparent
  // path). Doing both in one transaction keeps undo atomic — single Cmd+Z
  // reverses the whole gesture. The returned effects are ALSO dispatched
  // against `snapshot`, NOT against the post-tick state, so they don't
  // double-apply if you re-dispatch them; the caller uses snapshot as the
  // base state for whatever transaction it builds.
  function computeCumulativeDragEffects(
    frameId: string,
    snapshot: EditorState,
    isResize: boolean,
  ): StateEffect<unknown>[] {
    const snapFrames = getFrames(snapshot);
    const curFrames = framesRef.current;
    const snapFound = findFrameById(snapFrames, frameId);
    const curFound = findFrameById(curFrames, frameId);
    if (!snapFound || !curFound) return [];
    const cw = cwRef.current, ch = chRef.current;
    const effects: StateEffect<unknown>[] = [];
    const dCol = curFound.frame.gridCol - snapFound.frame.gridCol;
    const dRow = curFound.frame.gridRow - snapFound.frame.gridRow;
    if (dCol !== 0 || dRow !== 0) {
      effects.push(moveFrameEffect.of({ id: frameId, dCol, dRow, charWidth: cw, charHeight: ch }));
    }
    if (isResize) {
      effects.push(resizeFrameEffect.of({ id: frameId, gridW: curFound.frame.gridW, gridH: curFound.frame.gridH, charWidth: cw, charHeight: ch }));
    }
    // Band-row residual: detect if the containing band itself moved.
    const snapBand = findContainingBandDeep(snapFrames, frameId);
    const curBand = findContainingBandDeep(curFrames, frameId);
    if (snapBand && curBand && snapBand.id === curBand.id) {
      const bandDRow = curBand.gridRow - snapBand.gridRow;
      if (bandDRow !== 0) {
        effects.push(moveFrameEffect.of({ id: snapBand.id, dCol: 0, dRow: bandDRow, charWidth: cw, charHeight: ch }));
      }
    }
    return effects;
  }

  // Fix 9: commit cumulative drag as a single history entry, dispatched
  // against the mouseDown snapshot so undo reverts the full gesture.
  function commitCumulativeDrag(frameId: string, snapshot: EditorState, isResize: boolean) {
    const effects = computeCumulativeDragEffects(frameId, snapshot, isResize);
    if (effects.length === 0) return;
    const prev = stateRef.current;
    const tr = snapshot.update({
      effects,
      annotations: [Transaction.addToHistory.of(true)],
    });
    stateRef.current = tr.state;
    if (docDiffersFrom(prev, tr.state)) markDirty();
    syncRefsFromState();
  }

  function onMouseUp(e?: { clientX: number; clientY: number }) {
    if (dragRef.current) {
      // Strategy A (Fix 1): if onMouseDown deferred the drill (mouse-down
      // landed on the current selection or a descendant) AND the gesture
      // had no movement (discrete click), run resolveSelectionTarget now
      // and drill one level. Drag-with-movement skips this branch (drag
      // respects selection). Drilling on click matches Figma exactly.
      if (
        !dragRef.current.hasMoved &&
        !dragRef.current.resizeHandle &&
        dragRef.current.deferredDrillHit
      ) {
        const drillHit = dragRef.current.deferredDrillHit;
        const newTarget = resolveSelectionTarget(
          drillHit, dragRef.current.frameId, framesRef.current, false,
        );
        if (newTarget && newTarget !== dragRef.current.frameId) {
          stateRef.current = stateRef.current.update({
            effects: selectFrameEffect.of(newTarget),
          }).state;
          paint();
        }
      }
      // Reparent decision: compute first so we know whether to fold the
      // cumulative-drag commit into the reparent transaction (Bug E fix).
      // Decision is computed against framesRef.current (post-tick state)
      // because aRow/aCol come from the cursor position at mouseup, and the
      // proseRows guard reads the doc as the user sees it.
      let reparentDecision: ReparentDecision = { kind: "none" };
      let reparentArgs: { aRow: number; aCol: number; cw: number; ch: number; draggedId: string } | null = null;
      if (dragRef.current.hasMoved && e && !dragRef.current.resizeHandle) {
        const canvasEl = canvasRef.current;
        if (canvasEl) {
          const rect = canvasEl.getBoundingClientRect();
          const upPx = e.clientX - rect.left;
          const upPy = e.clientY - rect.top + (canvasEl.parentElement?.scrollTop ?? 0);
          const draggedId = dragRef.current.frameId;
          const docExtentPy = stateRef.current.doc.lines * chRef.current;
          const cw = cwRef.current, ch = chRef.current;
          const docLines = stateRef.current.doc.lines;
          const grabOffsetPx = dragRef.current.startX - dragRef.current.startFrameX;
          const grabOffsetPy = dragRef.current.startY - dragRef.current.startFrameY;
          const { aRow, aCol } = landingGridFromCursor(
            upPx, upPy, grabOffsetPx, grabOffsetPy, cw, ch, docLines,
          );
          const draggedFrame = findFrameInList(framesRef.current, draggedId);
          const draggedGridH = draggedFrame?.gridH ?? 0;
          const proseRows = new Set<number>();
          const docText = stateRef.current.doc;
          for (let i = 1; i <= docText.lines; i++) {
            const ln = docText.line(i);
            if (ln.length > 0) proseRows.add(i - 1);
          }
          reparentDecision = decideReparent(
            framesRef.current, draggedId, upPx, upPy, docExtentPy,
            { aRow, gridH: draggedGridH, proseRows },
            { aRow, gridH: draggedGridH },
          );
          if (reparentDecision.kind !== "none") {
            reparentArgs = { aRow, aCol, cw, ch, draggedId };
          }
        }
      }

      // Bug E fix: when reparent fires, dispatch ONE transaction against
      // mouseDownState containing only the reparent effects (NO cumulative
      // drag effects). The reparent itself positions the dragged frame at
      // (aRow, aCol) — exactly where the user's cursor lands — so the
      // cumulative-drag delta is redundant for the final position.
      // frameInversion captures mouseDownState's frames as the undo
      // snapshot, so a single Cmd+Z reverses the whole gesture atomically.
      //
      // Earlier versions of this fix prepended cumulative-drag effects via
      // applyReparentFrame's `extraEffects` parameter. That broke
      // drag-onto-existing-frame because moveFrameEffect's handler runs
      // mergeOverlappingBands (editorState.ts:206), which collapsed the
      // dragged frame's band into the destination band BEFORE the reparent
      // effect ran — leaving reparent with nothing to do. Skipping the
      // cumulative-drag effects entirely avoids that ordering issue while
      // preserving undo atomicity (single transaction, single history
      // entry, frameInversion captures pre-drag state).
      //
      // When no reparent fires, commit the cumulative drag alone (Fix 9
      // unchanged behavior).
      if (dragRef.current.hasMoved && dragRef.current.mouseDownState) {
        const mouseDownState = dragRef.current.mouseDownState;
        if (reparentDecision.kind !== "none" && reparentArgs) {
          const targetParentId = reparentDecision.kind === "demote"
            ? reparentDecision.targetTopLevelId
            : null;
          applyAndTrack(() => applyReparentFrame(
            mouseDownState,
            reparentArgs.draggedId,
            targetParentId,
            reparentArgs.aRow,
            reparentArgs.aCol,
            reparentArgs.cw,
            reparentArgs.ch,
          ));
          syncRefsFromState();
        } else {
          // Drag-without-reparent: Fix 9's original commit-on-mouseup.
          commitCumulativeDrag(dragRef.current.frameId, dragRef.current.mouseDownState, !!dragRef.current.resizeHandle);
        }
      }
      dragRef.current = null;
      // Repaint after commit-on-mouseup + reparent — these only sync refs,
      // not the canvas. Without this, the post-drag layout shows up only on
      // the next interaction (any click triggers a paint somewhere down its
      // path), producing visible "frozen at last drag tick" until then.
      doLayout(); paint();
    }
    const preview = drawPreviewRef.current;
    if (!preview) return;
    const cw = cwRef.current, ch = chRef.current;
    const tool = activeToolRef.current;
    const x1 = Math.min(preview.startX, preview.curX), y1 = Math.min(preview.startY, preview.curY);
    const x2 = Math.max(preview.startX, preview.curX), y2 = Math.max(preview.startY, preview.curY);
    drawPreviewRef.current = null;
    if (tool === "rect" && x2 - x1 >= cw && y2 - y1 >= ch) {
      const f = createRectFrame({ gridW: Math.max(2, Math.round((x2 - x1) / cw)), gridH: Math.max(2, Math.round((y2 - y1) / ch)), style: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }, charWidth: cw, charHeight: ch });
      const gridR = Math.round(y1 / ch), gridC = Math.round(x1 / cw);
      applyAndTrack(prev => preview.parentId
        ? applyAddChildFrame(prev, f, preview.parentId, gridR, gridC)
        : applyAddTopLevelFrame(prev, f, gridR, gridC));
      syncRefsFromState();
    } else if (tool === "line") {
      const r1 = Math.round(preview.startY / ch), c1 = Math.round(preview.startX / cw), r2 = Math.round(preview.curY / ch), c2 = Math.round(preview.curX / cw);
      if (r1 !== r2 || c1 !== c2) {
        const f = createLineFrame({ r1, c1, r2, c2, charWidth: cw, charHeight: ch });
        applyAndTrack(prev => preview.parentId
          ? applyAddChildFrame(prev, f, preview.parentId, f.gridRow, f.gridCol)
          : applyAddTopLevelFrame(prev, f, f.gridRow, f.gridCol));
        syncRefsFromState();
      }
    }
    setTool("select"); // one-shot: revert to Select after drawing
    doLayout(); paint();
  }

  useEffect(() => {
    // Load persisted theme BEFORE measuring so we don't measure with defaults
    // and then immediately remeasure when the persisted values arrive — that
    // would flicker the layout on every Tauri launch with a customized theme.
    loadTheme().then(() => Promise.all([measureCellSize(), ensureProseFontReady()])).then(() => {
      cwRef.current = getCharWidth(); chRef.current = getCharHeight();
      // Optional fixture loader — `?fixture=wall-stack-vert` swaps DEFAULT_TEXT
      // for a named harness fixture so manual reproduction matches the e2e
      // test setup. No-op when the param is absent or unrecognized.
      const fixtureName = new URLSearchParams(window.location.search).get("fixture");
      const FIXTURES: Record<string, string> = {
        "wall-stack-vert": [
          "Title", "",
          "┌──────────┐",
          "│  Top     │",
          "└──────────┘", "", "", "",
          "┌──────────┐",
          "│  Bottom  │",
          "└──────────┘", "",
          "End",
        ].join("\n"),
      };
      const initialText = (fixtureName && FIXTURES[fixtureName]) || DEFAULT_TEXT;
      loadDocument(initialText); setReady(true);
      // Expose test hooks for Playwright round-trip testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__gridpad = {
        loadDocument: (text: string) => { loadDocument(text); doLayout(); paint(); },
        serializeDocument: () => {
          const state = stateRef.current;
          return serializeUnified(getDoc(state), getFrames(state));
        },
        /** Serialize + update all refs (mirrors backend.saveFile minus file I/O) */
        saveDocument: () => {
          const state = stateRef.current;
          const md = serializeUnified(getDoc(state), getFrames(state));
          stateRef.current = applyClearDirty(stateRef.current);
          syncRefsFromState();
          doLayout(); paint();
          return md;
        },
        /** Get all USER-PERCEIVED frame rects in CSS pixels.
         * Container frames (isBand or content === null && !isBand wireframes)
         * are recursed into — the user sees and interacts with the leaf
         * shapes, not the invisible containers. Coordinates are absolute
         * (offsets accumulated through every container level: band.x +
         * wireframe.x + shape.x).
         */
        getFrameRects: () => {
          const out: Array<{
            id: string; x: number; y: number; w: number; h: number;
            hasChildren: boolean; contentType: string;
          }> = [];
          const collect = (frame: Frame, offX: number, offY: number) => {
            const absX = offX + frame.x;
            const absY = offY + frame.y;
            const isContainer = frame.isBand
              || (frame.content === null && !frame.isBand);
            if (isContainer) {
              for (const c of frame.children) collect(c, absX, absY);
              return;
            }
            out.push({
              id: frame.id,
              x: absX, y: absY, w: frame.w, h: frame.h,
              hasChildren: frame.children.length > 0,
              contentType: frame.content?.type ?? "container",
            });
          };
          for (const f of framesRef.current) collect(f, 0, 0);
          return out;
        },
        /** Get full frame tree with all children, positions, and content */
        getFrameTree: () => {
          const collect = (fs: Frame[], offX: number, offY: number, offRow: number, offCol: number): unknown[] =>
            fs.map(f => ({
              id: f.id,
              absX: offX + f.x, absY: offY + f.y,
              w: f.w, h: f.h,
              gridRow: offRow + f.gridRow,
              gridCol: offCol + f.gridCol,
              gridW: f.gridW,
              gridH: f.gridH,
              contentType: f.content?.type ?? "container",
              text: f.content?.text ?? null,
              dirty: f.dirty,
              childCount: f.children.length,
              children: collect(f.children, offX + f.x, offY + f.y, offRow + f.gridRow, offCol + f.gridCol),
            }));
          return collect(framesRef.current, 0, 0, 0, 0);
        },
        /** Get current prose text from CM doc */
        getProseDoc: () => getDoc(stateRef.current),
        /** Get the selected frame ID (null if nothing selected) */
        getSelectedId: () => getSelectedId(stateRef.current),
        /** Get positioned prose lines from reflowLayout (what's actually rendered) */
        getRenderedLines: () => linesRef.current.map(l => ({
          x: l.x, y: l.y, text: l.text, width: l.width,
          sourceLine: l.sourceLine, sourceCol: l.sourceCol,
        })),
        /** Get measured character dimensions */
        getCharDims: () => ({ cw: cwRef.current, ch: chRef.current }),
        /** Get current text edit state (null if not editing) */
        getTextEdit: () => getTextEdit(stateRef.current),
        /** Debug: test hitTestFrames at a given position */
        hitTest: (px: number, py: number) => {
          const hit = hitTestFrames(framesRef.current, px, py);
          return hit ? { id: hit.id, type: hit.content?.type ?? "container" } : null;
        },
        /** Clear all active interaction state (prose cursor, selection, text edit) */
        clearState: () => {
          stateRef.current = stateRef.current.update({
            effects: [selectFrameEffect.of(null), setTextEditEffect.of(null)],
          }).state;
          proseCursorRef.current = null;
          textEditRef.current = null;
          dragRef.current = null;
          doLayout(); paint();
        },
        /** Get prose cursor position */
        getCursorPosition: () => proseCursorRef.current,
        /** Check if any frame is dirty */
        isDirty: () => framesRef.current.some(f => f.dirty),
        /** Programmatically select a frame by ID and prepare for drag */
        selectFrame: (id: string) => {
          stateRef.current = stateRef.current.update({
            effects: [selectFrameEffect.of(id), setTextEditEffect.of(null)],
          }).state;
          proseCursorRef.current = null;
          textEditRef.current = null;
          syncRefsFromState();
          paint();
        },
      };
    }).catch(err => console.error("Init failed:", err));
  }, []);

  useEffect(() => {
    const fn = () => { if (!stateRef.current) return; sizeRef.current = { w: window.innerWidth, h: window.innerHeight }; doLayout(); paint(); };
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  // A drag can end outside the canvas (release past the top edge, off-window,
  // over the toolbar). The canvas-bound onMouseUp never fires there, leaving
  // the gesture uncommitted: no reparent decision, no history entry (per-tick
  // moves are addToHistory:false, so undo can't revert them), and a live
  // dragRef that corrupts the next gesture. Catch the release at the window
  // level. In-canvas releases fire both paths; onMouseUp is ref-guarded, so
  // the second call no-ops.
  const onMouseUpRef = useRef<(e?: { clientX: number; clientY: number }) => void>(onMouseUp);
  onMouseUpRef.current = onMouseUp;
  useEffect(() => {
    const fn = (ev: MouseEvent) => onMouseUpRef.current(ev);
    window.addEventListener("mouseup", fn);
    return () => window.removeEventListener("mouseup", fn);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (proseCursorRef.current || textEditRef.current) { blinkRef.current = !blinkRef.current; paint(); }
    }, 530);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      if (!stateRef.current) return;
      // Accept either accelerator key: Cmd on Mac, Ctrl elsewhere. Checking
      // both also keeps unhandled chords (e.g. Meta+z on Linux) out of the
      // character-insert paths below, which gate on !mod.
      const mod = e.metaKey || e.ctrlKey;
      // Cmd+, toggles the theme panel — works in any mode (prose, text-edit, idle).
      if (mod && e.key === ",") {
        e.preventDefault();
        setThemePanelOpen(v => !v);
        return;
      }
      if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        applyAndTrack(editorUndo);
        syncRefsFromState();
        proseRef.current = getDoc(stateRef.current);
        preparedRef.current = buildPreparedCache(proseRef.current);
        proseCursorRef.current = getCursor(stateRef.current);
        doLayout(); blinkRef.current = true; paint();
        return;
      }
      if (mod && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        applyAndTrack(editorRedo);
        syncRefsFromState();
        proseRef.current = getDoc(stateRef.current);
        preparedRef.current = buildPreparedCache(proseRef.current);
        proseCursorRef.current = getCursor(stateRef.current);
        doLayout(); blinkRef.current = true; paint();
        return;
      }
      if (mod && e.key === "o") {
        e.preventDefault();
        if (!backend) return;
        const r = await backend.openFile();
        if (r) {
          loadDocument(r.text);
          doLayout(); paint();
          setCurrentPath(r.path);
          markClean(r.path);
        }
        return;
      }
      if (mod && e.shiftKey && e.key === "s") {
        e.preventDefault();
        if (!backend) return;
        const snapshot = stateRef.current;
        const md = serializeUnified(getDoc(snapshot), getFrames(snapshot));
        const newPath = await backend.saveFileAs(md);
        if (newPath !== null) {
          stateRef.current = applyClearDirty(stateRef.current);
          syncRefsFromState();
          setCurrentPath(newPath);
          if (!docDiffersFrom(snapshot, stateRef.current)) {
            markClean(newPath);
          } else {
            pushTitle(newPath, true);
          }
        }
        return;
      }
      if (mod && e.key === "s") {
        e.preventDefault();
        await saveCurrent();
        return;
      }
      // Text placement tool — collect typed chars
      const tp = textPlacementRef.current;
      if (tp) {
        if (e.key === "Escape") { e.preventDefault(); textPlacementRef.current = null; paint(); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          if (tp.chars.length > 0) {
            const cw = cwRef.current, ch = chRef.current;
            const tf = createTextFrame({ text: tp.chars, row: Math.round(tp.y / ch), col: Math.round(tp.x / cw), charWidth: cw, charHeight: ch });
            applyAndTrack(prev => tp.parentId
              ? applyAddChildFrame(prev, tf, tp.parentId, tf.gridRow, tf.gridCol)
              : applyAddTopLevelFrame(prev, tf, tf.gridRow, tf.gridCol));
            syncRefsFromState();
            doLayout();
          }
          setTool("select"); paint(); return; // one-shot: revert to Select
        }
        if (e.key === "Backspace") { e.preventDefault(); const cps = [...tp.chars]; cps.pop(); textPlacementRef.current = { ...tp, chars: cps.join("") }; paint(); return; }
        if (e.key.length === 1 && !mod) { e.preventDefault(); textPlacementRef.current = { ...tp, chars: tp.chars + e.key }; paint(); return; }
        return;
      }
      if (textEditRef.current) {
        const te = textEditRef.current;
        const found = findFrameById(framesRef.current, te.frameId);
        if (!found || found.frame.content?.type !== "text") {
          stateRef.current = stateRef.current.update({ effects: setTextEditEffect.of(null) }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          paint(); return;
        }
        const text = found.frame.content!.text ?? "";
        const codepoints = [...text];
        // Alignment shortcuts (only while editing text inside a rect)
        if (mod && !e.shiftKey) {
          if (e.key === "l" || e.key === "L") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, hAlign: { anchor: "left", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
          if (e.key === "e" || e.key === "E") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, hAlign: { anchor: "center", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
          if (e.key === "r" || e.key === "R") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, hAlign: { anchor: "right", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
        }
        if (mod && e.shiftKey) {
          if (e.key === "t" || e.key === "T") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, vAlign: { anchor: "top", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
          if (e.key === "m" || e.key === "M") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, vAlign: { anchor: "center", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
          if (e.key === "b" || e.key === "B") {
            e.preventDefault();
            stateRef.current = stateRef.current.update({
              effects: setTextAlignEffect.of({ id: te.frameId, vAlign: { anchor: "bottom", offset: 0 }, charWidth: cwRef.current, charHeight: chRef.current }),
            }).state;
            syncRefsFromState();
            blinkRef.current = true; paint(); return;
          }
        }
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({ effects: setTextEditEffect.of(null) }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({
            effects: setTextEditEffect.of({ frameId: te.frameId, col: Math.max(0, te.col - 1) }),
          }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({
            effects: setTextEditEffect.of({ frameId: te.frameId, col: Math.min(codepoints.length, te.col + 1) }),
          }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Home") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({
            effects: setTextEditEffect.of({ frameId: te.frameId, col: 0 }),
          }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "End") {
          e.preventDefault();
          stateRef.current = stateRef.current.update({
            effects: setTextEditEffect.of({ frameId: te.frameId, col: codepoints.length }),
          }).state;
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          if (te.col > 0) {
            const newCp = [...codepoints.slice(0, te.col - 1), ...codepoints.slice(te.col)];
            const newText = newCp.join("");
            const charWidth = getCharWidth();
            stateRef.current = stateRef.current.update({
              effects: [
                editTextFrameEffect.of({ id: te.frameId, text: newText, charWidth }),
                setTextEditEffect.of({ frameId: te.frameId, col: te.col - 1 }),
              ],
              annotations: [Transaction.addToHistory.of(true)],
            }).state;
            syncRefsFromState();
            textEditRef.current = getTextEdit(stateRef.current);
          }
          blinkRef.current = true; paint(); return;
        }
        if (e.key.length === 1 && !mod) {
          e.preventDefault();
          const newCp = [...codepoints.slice(0, te.col), e.key, ...codepoints.slice(te.col)];
          const newText = newCp.join("");
          const charWidth = getCharWidth();
          stateRef.current = stateRef.current.update({
            effects: [
              editTextFrameEffect.of({ id: te.frameId, text: newText, charWidth }),
              setTextEditEffect.of({ frameId: te.frameId, col: te.col + 1 }),
            ],
            annotations: [Transaction.addToHistory.of(true)],
          }).state;
          syncRefsFromState();
          textEditRef.current = getTextEdit(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        return;
      }
      if (proseCursorRef.current) {
        if (e.key === "Escape") { proseCursorRef.current = null; paint(); return; }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          stateRef.current = proseMoveLeft(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          stateRef.current = proseMoveRight(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          stateRef.current = proseMoveUp(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          stateRef.current = proseMoveDown(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Home") {
          e.preventDefault();
          stateRef.current = proseMoveToLineStart(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "End") {
          e.preventDefault();
          stateRef.current = proseMoveToLineEnd(stateRef.current);
          proseCursorRef.current = getCursor(stateRef.current);
          blinkRef.current = true; paint(); return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          const beforeCursor = getCursor(stateRef.current)!;
          applyAndTrack(prev => proseDeleteBefore(prev, beforeCursor));
          // Unified-doc: proseDelete mutates the CM doc; mapPos in framesField
          // shifts every frame's docOffset automatically. No manual frame-shift
          // loop needed. syncRefsFromState rebuilds preparedRef from scratch.
          syncRefsFromState();
          proseCursorRef.current = getCursor(stateRef.current);
          doLayout(); blinkRef.current = true; paint(); return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const c = getCursor(stateRef.current)!;
          applyAndTrack(prev => proseInsert(prev, c, "\n"));
          // Same as Backspace: unified pipeline handles both doc + frame shift.
          syncRefsFromState();
          proseCursorRef.current = getCursor(stateRef.current);
          doLayout(); blinkRef.current = true; paint(); return;
        }
        if (e.key.length === 1 && !mod) {
          e.preventDefault();
          const c = getCursor(stateRef.current)!;
          const key = e.key;
          applyAndTrack(prev => proseInsert(prev, c, key));
          syncRefsFromState();
          proseCursorRef.current = getCursor(stateRef.current);
          doLayout(); blinkRef.current = true; paint(); return;
        }
        return;
      }
      // Global shortcuts (no prose cursor)
      if (e.key === "Escape") {
        stateRef.current = stateRef.current.update({ effects: selectFrameEffect.of(null) }).state;
        paint();
      }
      const deleteSelectedId = getSelectedId(stateRef.current);
      if ((e.key === "Delete" || e.key === "Backspace") && deleteSelectedId) {
        applyAndTrack(prev => applyDeleteFrame(prev, deleteSelectedId));
        syncRefsFromState();
        doLayout(); paint();
      }
      // Z-order shortcuts (top-level frames only)
      const zSelId = getSelectedId(stateRef.current);
      if (zSelId) {
        const topFrame = framesRef.current.find(f => f.id === zSelId);
        if (topFrame) {
          if (e.key === "]" && !mod) {
            e.preventDefault();
            stateRef.current = stateRef.current.update({ effects: setZEffect.of({ id: topFrame.id, z: topFrame.z + 1 }), annotations: [Transaction.addToHistory.of(true)] }).state;
            syncRefsFromState(); doLayout(); paint(); return;
          }
          if (e.key === "[" && !mod) {
            e.preventDefault();
            stateRef.current = stateRef.current.update({ effects: setZEffect.of({ id: topFrame.id, z: Math.max(0, topFrame.z - 1) }), annotations: [Transaction.addToHistory.of(true)] }).state;
            syncRefsFromState(); doLayout(); paint(); return;
          }
          if (e.key === "]" && mod) {
            e.preventDefault();
            const maxZ = Math.max(...framesRef.current.map(f => f.z));
            stateRef.current = stateRef.current.update({ effects: setZEffect.of({ id: topFrame.id, z: maxZ + 1 }), annotations: [Transaction.addToHistory.of(true)] }).state;
            syncRefsFromState(); doLayout(); paint(); return;
          }
          if (e.key === "[" && mod) {
            e.preventDefault();
            stateRef.current = stateRef.current.update({ effects: setZEffect.of({ id: topFrame.id, z: 0 }), annotations: [Transaction.addToHistory.of(true)] }).state;
            syncRefsFromState(); doLayout(); paint(); return;
          }
        }
      }
      if (!mod) {
        if (e.key === "v" || e.key === "V") setTool("select");
        if (e.key === "r" || e.key === "R") setTool("rect");
        if (e.key === "l" || e.key === "L") setTool("line");
        if (e.key === "t" || e.key === "T") setTool("text");
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [backend, currentPath, docDirty]);

  useEffect(() => { if (ready) { doLayout(); paint(); } }, [ready]);

  // Theme subscription. Runs in its own effect (separate from keyboard) so the
  // two unrelated lifecycles don't churn. Reflow work is debounced 100ms
  // trailing-edge so dragging a multiplier slider at 60fps fires one reflow at
  // the end, not 60. The synchronous half of updateTheme (mutate + snapshot +
  // notify) already ran before this listener fires — the debounce only delays
  // the expensive async side-effect.
  useEffect(() => {
    let reflowTimer: ReturnType<typeof setTimeout> | null = null;
    const REFLOW_DEBOUNCE_MS = 100;

    const runReflow = async () => {
      // Await new font(s) before measuring so we don't pick up the system
      // fallback. document.fonts.load is idempotent — already-loaded fonts
      // resolve immediately.
      try {
        await Promise.all([
          document.fonts.load(wireframeFont()),
          ensureProseFontReady(),
        ]);
      } catch { /* tolerate missing fonts; clamps in measureCellSize handle it */ }
      await measureCellSize();
      cwRef.current = getCharWidth();
      chRef.current = getCharHeight();
      // Frames cache pixel x/y/w/h derived from canonical grid coords + the
      // cell size at the time they were created. When ch/cw change, those
      // pixel fields are stale — bands/wireframes still render at the old
      // size while doLayout positions them with the new lineTop. Walk the
      // tree and rebuild pixels from grid coords.
      recomputePixelFields(framesRef.current, cwRef.current, chRef.current);
      // Prepared cache holds word-wrap measurements against the OLD prose font.
      // Skipping this rebuild makes text wrap at stale boundaries on prose
      // font/size changes.
      preparedRef.current = buildPreparedCache(proseRef.current);
      doLayout();
      paint();
    };

    const handle = (kind: ThemeUpdateKind) => {
      if (kind === "css-vars-only") return; // browser handles via :root
      if (kind === "paint") { paint(); return; }
      // reflow — debounce
      if (reflowTimer !== null) clearTimeout(reflowTimer);
      reflowTimer = setTimeout(() => { reflowTimer = null; void runReflow(); }, REFLOW_DEBOUNCE_MS);
    };

    const unsub = subscribeTheme(handle);
    return () => {
      unsub();
      if (reflowTimer !== null) clearTimeout(reflowTimer);
    };
  }, []);

  if (!ready) return <div style={{ background: "var(--theme-bg, #1e1e2e)", width: "100vw", height: "100vh" }} />;

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "auto", background: "#141420" }} onScroll={paint}>
      <div style={{ position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 100, background: "#2b2b33", borderRadius: 10, padding: "4px 8px", boxShadow: "0 2px 12px rgba(0,0,0,0.5)", display: "flex", gap: 4 }}>
        {TOOL_BUTTONS.map(({ tool, label }) => (
          <button key={tool} onClick={() => setTool(tool)} style={{ background: activeTool === tool ? "var(--theme-selection, #4a90e2)" : "transparent", color: "#e0e0e0", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: theme.wireframeFontFamily, fontSize: 13, fontWeight: activeTool === tool ? 600 : 400 }}>
            {label}
          </button>
        ))}
        <div style={{ width: 1, background: "var(--theme-grid-border, #444)", margin: "4px 4px" }} />
        <button
          onClick={() => { const next = !showBandsRef.current; showBandsRef.current = next; setShowBands(next); paint(); }}
          title="Toggle band debug overlay"
          style={{ background: showBands ? "rgb(255, 0, 200)" : "transparent", color: "#e0e0e0", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: theme.wireframeFontFamily, fontSize: 13, fontWeight: showBands ? 600 : 400 }}
        >
          ▦ Bands
        </button>
        <button
          onClick={() => { const next = !showWrappersRef.current; showWrappersRef.current = next; setShowWrappers(next); paint(); }}
          title="Toggle wireframe-wrapper debug overlay"
          style={{ background: showWrappers ? "rgb(0, 200, 200)" : "transparent", color: "#e0e0e0", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: theme.wireframeFontFamily, fontSize: 13, fontWeight: showWrappers ? 600 : 400 }}
        >
          ▢ Wrappers
        </button>
        <button
          onClick={() => setThemePanelOpen(v => !v)}
          title="Theme (⌘,)"
          aria-pressed={themePanelOpen}
          style={{ background: themePanelOpen ? "var(--theme-selection, #4a90e2)" : "transparent", color: "#e0e0e0", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: theme.wireframeFontFamily, fontSize: 13, fontWeight: themePanelOpen ? 600 : 400 }}
        >
          ⚙
        </button>
      </div>
      <ThemePanel open={themePanelOpen} onClose={() => setThemePanelOpen(false)} />
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ display: "block", width: "100%", height: "100%", position: "sticky", top: 0, outline: "none", cursor: canvasCursor }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
      <div data-spacer="" style={{ pointerEvents: "none" }} />
      {showUnsavedModal && pendingPath && (
        <UnsavedChangesModal
          pendingPath={pendingPath}
          onCancel={() => { setShowUnsavedModal(false); setPendingPath(null); }}
          onDiscard={() => {
            const p = pendingPath;
            setShowUnsavedModal(false); setPendingPath(null);
            if (p) void loadFromPath(p);
          }}
          onSaveFirst={async () => {
            const p = pendingPath;
            setShowUnsavedModal(false); setPendingPath(null);
            await saveCurrent();
            if (p) void loadFromPath(p);
          }}
        />
      )}
    </div>
  );
}
