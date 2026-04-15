/**
 * DemoV2 — Frame-based spatial canvas. Thin shell using frame.ts + frameRenderer.ts.
 * Target: <300 lines. All logic in pure modules.
 */
import { useEffect, useRef, useState } from "react";
import { prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import { type Frame, framesFromRegions, framesToObstacles, hitTestFrames, moveFrame, resizeFrame } from "./frame";
import { renderFrame, renderFrameSelection } from "./frameRenderer";
import { reflowLayout, type PositionedLine } from "./reflowLayout";
import { FG_COLOR, measureCellSize, getCharWidth, getCharHeight, FONT_SIZE, FONT_FAMILY } from "./grid";

const FONT = `${FONT_SIZE}px ${FONT_FAMILY}`;
const LH = Math.ceil(FONT_SIZE * 1.15);
const BG = "#1e1e2e";

// ── Resize handle types ────────────────────────────────────
type ResizeHandle = "tl" | "tm" | "tr" | "ml" | "mr" | "bl" | "bm" | "br";

interface HandleRect { handle: ResizeHandle; x: number; y: number; w: number; h: number; }

const HANDLE_HIT = 12;
const HANDLE_HALF_HIT = HANDLE_HIT / 2;

function computeHandleRects(absX: number, absY: number, fw: number, fh: number): HandleRect[] {
  const pts: [ResizeHandle, number, number][] = [
    ["tl", absX,           absY          ],
    ["tm", absX + fw / 2,  absY          ],
    ["tr", absX + fw,      absY          ],
    ["ml", absX,           absY + fh / 2 ],
    ["mr", absX + fw,      absY + fh / 2 ],
    ["bl", absX,           absY + fh     ],
    ["bm", absX + fw / 2,  absY + fh     ],
    ["br", absX + fw,      absY + fh     ],
  ];
  return pts.map(([handle, cx, cy]) => ({
    handle, x: cx - HANDLE_HALF_HIT, y: cy - HANDLE_HALF_HIT, w: HANDLE_HIT, h: HANDLE_HIT,
  }));
}

function hitTestHandle(rects: HandleRect[], px: number, py: number): ResizeHandle | null {
  for (const r of rects) {
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r.handle;
  }
  return null;
}

const DEFAULT_TEXT = `# Welcome to Gridpad

Open a markdown file with wireframes to see them rendered.
Use Cmd+O to open a file, then drag the wireframe boxes around.

┌─────────────────────────────────────────────────┐
│                   Dashboard                     │
├──────────┬──────────────────────┬───────────────┤
│ Sidebar  │  Main Content        │  Right Panel  │
│          │                      │               │
│          │  ┌────────────────┐  │               │
│          │  │  Card Title    │  │               │
│          │  │  Description   │  │               │
│          │  └────────────────┘  │               │
│          │                      │               │
└──────────┴──────────────────────┴───────────────┘

The text above and below the wireframe is rendered by Pretext.
Try dragging a wireframe — Alt+click to move, text reflows around it.`;

interface DragState {
  frameId: string;
  startX: number;
  startY: number;
  startFrameX: number;
  startFrameY: number;
  startFrameW: number;
  startFrameH: number;
  hasMoved: boolean;
  resizeHandle?: ResizeHandle;
}

export default function DemoV2() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const framesRef = useRef<Frame[]>([]);
  const proseRef = useRef("");
  const preparedRef = useRef<PreparedTextWithSegments | null>(null);
  const linesRef = useRef<PositionedLine[]>([]);
  const selectedRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cwRef = useRef(0);
  const chRef = useRef(0);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });

  // ── Core functions ────────────────────────────────────
  function loadDocument(text: string) {
    const cw = cwRef.current;
    const ch = chRef.current;
    const result = framesFromRegions(detectRegions(scan(text)), cw, ch);
    const frames = result.frames;
    const proseText = (result as { prose: { text: string }[] }).prose.map((p: { text: string }) => p.text).join("\n\n");

    // Prepare prose for Pretext
    if (proseText.length > 0) {
      preparedRef.current = prepareWithSegments(proseText, FONT, { whiteSpace: "pre-wrap" });
    } else {
      preparedRef.current = null;
    }

    // Position frames sequentially: walk regions, accumulate y
    // For prose regions: count source lines × lineHeight (approximate)
    // For wireframe regions: set frame.y = curY, advance by frame.h
    const regions = detectRegions(scan(text));
    let curY = 0;
    let frameIdx = 0;
    for (const r of regions) {
      if (r.type === "prose") {
        curY += r.text.split("\n").length * LH;
      } else {
        if (frameIdx < frames.length) {
          frames[frameIdx].y = curY;
          curY += frames[frameIdx].h;
          frameIdx++;
        }
      }
    }

    proseRef.current = proseText;
    framesRef.current = frames;
    selectedRef.current = null;
    dragRef.current = null;
  }

  function doLayout() {
    if (!preparedRef.current) { linesRef.current = []; return; }
    const obstacles = framesToObstacles(framesRef.current);
    linesRef.current = reflowLayout(preparedRef.current, sizeRef.current.w, LH, obstacles).lines;
  }

  function paint() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cw = cwRef.current;
    const ch = chRef.current;
    const { w } = sizeRef.current;

    // Content height
    let contentH = 100;
    for (const line of linesRef.current) contentH = Math.max(contentH, line.y + LH);
    for (const f of framesRef.current) contentH = Math.max(contentH, f.y + f.h);
    contentH = Math.max(contentH + 40, sizeRef.current.h);

    // DPR
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(contentH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, contentH);

    // Prose
    ctx.font = FONT;
    ctx.fillStyle = FG_COLOR;
    ctx.textBaseline = "top";
    for (const line of linesRef.current) {
      ctx.fillText(line.text, line.x, line.y);
    }

    // Frames
    for (const frame of framesRef.current) {
      renderFrame(ctx, frame, 0, 0, cw, ch);
    }

    // Selection
    if (selectedRef.current) {
      const sel = findFrameById(framesRef.current, selectedRef.current);
      if (sel) {
        renderFrameSelection(ctx, sel.frame, sel.absX, sel.absY);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────
  function findFrameById(frames: Frame[], id: string, px = 0, py = 0): { frame: Frame; absX: number; absY: number } | null {
    for (const f of frames) {
      const ax = px + f.x;
      const ay = py + f.y;
      if (f.id === id) return { frame: f, absX: ax, absY: ay };
      const child = findFrameById(f.children, id, ax, ay);
      if (child) return child;
    }
    return null;
  }

  function replaceFrame(frames: Frame[], id: string, newFrame: Frame): Frame[] {
    return frames.map(f => {
      if (f.id === id) return newFrame;
      if (f.children.length > 0) return { ...f, children: replaceFrame(f.children, id, newFrame) };
      return f;
    });
  }

  // ── Mouse ─────────────────────────────────────────────
  function onMouseDown(e: React.MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + (canvas.parentElement?.scrollTop ?? 0);

    // Check if click hits a resize handle on the selected frame first
    if (selectedRef.current) {
      const sel = findFrameById(framesRef.current, selectedRef.current);
      if (sel) {
        const rects = computeHandleRects(sel.absX, sel.absY, sel.frame.w, sel.frame.h);
        const handleHit = hitTestHandle(rects, px, py);
        if (handleHit) {
          dragRef.current = {
            frameId: sel.frame.id,
            startX: px,
            startY: py,
            startFrameX: sel.absX,
            startFrameY: sel.absY,
            startFrameW: sel.frame.w,
            startFrameH: sel.frame.h,
            hasMoved: false,
            resizeHandle: handleHit,
          };
          paint();
          return;
        }
      }
    }

    const hit = hitTestFrames(framesRef.current, px, py);
    if (hit) {
      selectedRef.current = hit.id;
      const found = findFrameById(framesRef.current, hit.id);
      if (found) {
        dragRef.current = {
          frameId: hit.id,
          startX: px,
          startY: py,
          startFrameX: found.absX,
          startFrameY: found.absY,
          startFrameW: found.frame.w,
          startFrameH: found.frame.h,
          hasMoved: false,
        };
      }
      paint();
    } else {
      selectedRef.current = null;
      dragRef.current = null;
      paint();
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + (canvas.parentElement?.scrollTop ?? 0);

    const dx = px - drag.startX;
    const dy = py - drag.startY;
    if (!drag.hasMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.hasMoved = true;

    const found = findFrameById(framesRef.current, drag.frameId);
    if (!found) return;

    if (drag.resizeHandle) {
      const cw = cwRef.current;
      const ch = chRef.current;
      const h = drag.resizeHandle;
      const sw = drag.startFrameW;
      const sh = drag.startFrameH;

      // Compute new size (and position shift for top/left handles)
      let newW = sw;
      let newH = sh;
      let newDx = 0;
      let newDy = 0;

      if (h === "br") { newW = sw + dx; newH = sh + dy; }
      else if (h === "bl") { newW = sw - dx; newH = sh + dy; newDx = dx; }
      else if (h === "tr") { newW = sw + dx; newH = sh - dy; newDy = dy; }
      else if (h === "tl") { newW = sw - dx; newH = sh - dy; newDx = dx; newDy = dy; }
      else if (h === "bm") { newH = sh + dy; }
      else if (h === "tm") { newH = sh - dy; newDy = dy; }
      else if (h === "mr") { newW = sw + dx; }
      else if (h === "ml") { newW = sw - dx; newDx = dx; }

      const resized = resizeFrame(found.frame, { w: newW, h: newH }, cw, ch);
      // Anchor the fixed corner: compute absolute position after clamp
      const anchorX = drag.startFrameX + (newDx !== 0 ? drag.startFrameW : 0);
      const anchorY = drag.startFrameY + (newDy !== 0 ? drag.startFrameH : 0);
      const newAbsX = newDx !== 0 ? anchorX - resized.w : drag.startFrameX;
      const newAbsY = newDy !== 0 ? anchorY - resized.h : drag.startFrameY;
      // Convert abs position to frame-local (subtract parent offset)
      const parentOffX = found.absX - found.frame.x;
      const parentOffY = found.absY - found.frame.y;
      const finalFrame = moveFrame(resized, {
        dx: newAbsX - parentOffX - resized.x,
        dy: newAbsY - parentOffY - resized.y,
      });
      framesRef.current = replaceFrame(framesRef.current, drag.frameId, finalFrame);
    } else {
      // Compute new position relative to parent
      const newX = Math.max(0, drag.startFrameX + dx - (found.absX - found.frame.x));
      const newY = Math.max(0, drag.startFrameY + dy - (found.absY - found.frame.y));
      const moved = moveFrame(found.frame, { dx: newX - found.frame.x, dy: newY - found.frame.y });
      framesRef.current = replaceFrame(framesRef.current, drag.frameId, moved);
    }

    doLayout();
    paint();
  }

  function onMouseUp() {
    if (dragRef.current) {
      dragRef.current = null;
    }
  }

  // ── Effects ───────────────────────────────────────────
  useEffect(() => {
    measureCellSize().then(() => {
      cwRef.current = getCharWidth();
      chRef.current = getCharHeight();
      loadDocument(DEFAULT_TEXT);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const fn = () => { sizeRef.current = { w: window.innerWidth, h: window.innerHeight }; };
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  useEffect(() => {
    const fn = async (e: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "o") {
        e.preventDefault();
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
          });
          const file = await handle.getFile();
          loadDocument(await file.text());
          doLayout();
          paint();
        } catch { /* cancelled */ }
      }
      if (e.key === "Escape") { selectedRef.current = null; paint(); }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current) {
        framesRef.current = framesRef.current.filter(f => f.id !== selectedRef.current);
        // Also remove from children
        framesRef.current = framesRef.current.map(f => ({
          ...f, children: f.children.filter(c => c.id !== selectedRef.current),
        }));
        selectedRef.current = null;
        doLayout();
        paint();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  useEffect(() => { if (ready) { doLayout(); paint(); } });

  if (!ready) return <div style={{ background: BG, width: "100vw", height: "100vh" }} />;

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "auto", background: "#141420" }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ display: "block", width: sizeRef.current.w, outline: "none", cursor: "default" }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      />
    </div>
  );
}
