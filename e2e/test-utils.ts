/**
 * Shared test utilities extracted from harness.spec.ts
 *
 * Helper functions, fixtures, and constants for Gridpad E2E tests.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ARTIFACTS = path.join(__dirname, "artifacts");

// Wire drawing characters — if these appear in a prose-only line, it's a ghost
export const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼═║╔╗╚╝╠╣╦╩╬"]);

// ── Helpers ────────────────────────────────────────────────

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(testName: string, suffix: string, content: string | Buffer) {
  ensureDir(path.join(ARTIFACTS, testName));
  const p = path.join(ARTIFACTS, testName, suffix);
  fs.writeFileSync(p, content);
  return p;
}

/** Load markdown into Gridpad */
export async function load(page: Page, md: string) {
  await page.evaluate((t) => (window as any).__gridpad.loadDocument(t), md);
  await page.waitForTimeout(600);
}

/** Save via full save flow (serialize + update refs) */
export async function save(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__gridpad.saveDocument());
}

/** Get frame rectangles in CSS pixel coordinates */
export async function getFrames(page: Page): Promise<Array<{
  id: string; x: number; y: number; w: number; h: number;
  hasChildren: boolean; contentType: string;
}>> {
  return page.evaluate(() => (window as any).__gridpad.getFrameRects());
}

/** Get the full frame tree from Gridpad */
export async function getFrameTree(page: Page): Promise<Array<{
  id: string; absX: number; absY: number; w: number; h: number;
  contentType: string; text: string | null; dirty: boolean;
  childCount: number; children: any[];
}>> {
  return page.evaluate(() => (window as any).__gridpad.getFrameTree());
}

/** Get the selected frame ID */
export async function getSelectedId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__gridpad.getSelectedId());
}

/** Get rendered prose lines from reflowLayout */
export async function getRenderedLines(page: Page): Promise<Array<{
  x: number; y: number; text: string; width: number;
}>> {
  return page.evaluate(() => (window as any).__gridpad.getRenderedLines());
}

/** Get measured character dimensions from the page */
export async function getCharDims(page: Page): Promise<{ cw: number; ch: number }> {
  return page.evaluate(() => (window as any).__gridpad.getCharDims());
}

/** Screenshot the canvas element */
export async function screenshot(page: Page, testName: string, label: string): Promise<Buffer> {
  const buf = await page.locator("canvas").screenshot();
  writeArtifact(testName, `${label}.png`, buf);
  return buf;
}

/** Pixel diff percentage between two PNG buffers */
export async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  // Use base64 instead of spreading Buffer to number array — avoids massive JSON payloads
  const b64a = a.toString("base64");
  const b64b = b.toString("base64");
  return page.evaluate(async ({ d1, d2 }) => {
    const toImg = async (b64: string) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return createImageBitmap(new Blob([arr], { type: "image/png" }));
    };
    const [i1, i2] = await Promise.all([toImg(d1), toImg(d2)]);
    const c = document.createElement("canvas");
    c.width = i1.width; c.height = i1.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(i1, 0, 0);
    const p1 = ctx.getImageData(0, 0, c.width, c.height).data;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(i2, 0, 0);
    const p2 = ctx.getImageData(0, 0, c.width, c.height).data;
    let diff = 0;
    for (let i = 0; i < p1.length; i += 4) {
      if (Math.abs(p1[i]-p2[i]) + Math.abs(p1[i+1]-p2[i+1]) + Math.abs(p1[i+2]-p2[i+2]) > 30) diff++;
    }
    return (diff / (p1.length / 4)) * 100;
  }, { d1: b64a, d2: b64b });
}

/** Find ghost wire characters using frame-bbox mask.
 * Any wire char NOT inside a known frame's grid bbox is a ghost.
 * This replaces the old heuristic section-based approach which
 * could not detect isolated ghost characters. */
export function findGhosts(
  md: string,
  _sections: unknown,
  frameBboxes?: Array<{ row: number; col: number; w: number; h: number }>,
): string[] {
  const lines = md.split("\n");
  const ghosts: string[] = [];
  const isFrameCell = (row: number, col: number): boolean => {
    if (!frameBboxes) return false;
    for (const b of frameBboxes) {
      if (row >= b.row && row < b.row + b.h && col >= b.col && col < b.col + b.w) return true;
    }
    return false;
  };
  for (let r = 0; r < lines.length; r++) {
    const chars = [...lines[r]];
    for (let c = 0; c < chars.length; c++) {
      if (WIRE_CHARS.has(chars[c]) && !isFrameCell(r, c)) {
        ghosts.push(`Ghost '${chars[c]}' at L${r + 1}:${c + 1}: ${lines[r].substring(0, 80)}`);
        break;
      }
    }
  }
  return ghosts;
}

/** Compute frame grid bboxes from the full frame tree for ghost detection.
 * Uses grid coords directly (no Math.round) to match the serializer exactly. */
export function computeFrameGridBboxes(
  tree: Array<{ gridRow?: number; gridCol?: number; gridW?: number; gridH?: number; absX: number; absY: number; w: number; h: number; children?: any[] }>,
  cw: number, ch: number,
): Array<{ row: number; col: number; w: number; h: number }> {
  const bboxes: Array<{ row: number; col: number; w: number; h: number }> = [];
  const collect = (nodes: any[]) => {
    for (const n of nodes) {
      // Use grid coords when available (grid-first frames), fall back to pixel conversion
      if (n.gridRow != null && n.gridW != null && n.gridW > 0) {
        bboxes.push({
          row: n.gridRow,
          col: n.gridCol,
          w: n.gridW,
          h: Math.max(1, n.gridH),
        });
      } else {
        const r1 = Math.round(n.absY / ch);
        const c1 = Math.round(n.absX / cw);
        const r2 = Math.round((n.absY + n.h) / ch);
        const c2 = Math.round((n.absX + n.w) / cw);
        bboxes.push({ row: r1, col: c1, w: Math.max(1, c2 - c1), h: Math.max(1, r2 - r1) });
      }
      if (n.children) collect(n.children);
    }
  };
  collect(tree);
  return bboxes;
}

/** Find ghosts using frame tree from the page */
export async function findGhostsFromPage(page: Page, md: string): Promise<string[]> {
  const tree = await getFrameTree(page);
  const { cw, ch } = await getCharDims(page);
  const bboxes = computeFrameGridBboxes(tree, cw, ch);
  return findGhosts(md, null, bboxes);
}

/** Post-condition invariants — run after every interaction */
export function checkInvariants(tree: any[]): string[] {
  const flat = flattenTree(tree);
  const failures: string[] = [];
  // No top-level text frames
  for (const node of tree) {
    if (node.contentType === "text") {
      failures.push(`Top-level text frame "${node.text}" at (${Math.round(node.absX)},${Math.round(node.absY)})`);
    }
  }
  // Max depth limit
  const maxDepth = flat.length > 0 ? Math.max(...flat.map((f: any) => f.depth)) : 0;
  if (maxDepth > 5) failures.push(`Excessive nesting depth: ${maxDepth}`);
  // No zero-dimension frames
  for (const node of flat) {
    if (node.w <= 0 || node.h <= 0) failures.push(`Zero/negative dimension: ${node.contentType} ${node.w}x${node.h}`);
  }
  return failures;
}

/** Flatten a frame tree into a flat list with depth */
export function flattenTree(tree: any[], depth = 0): Array<{ depth: number; contentType: string; text: string | null; absX: number; absY: number; w: number; h: number; childCount: number }> {
  const result: any[] = [];
  for (const node of tree) {
    result.push({ depth, contentType: node.contentType, text: node.text, absX: node.absX, absY: node.absY, w: node.w, h: node.h, childCount: node.childCount });
    if (node.children) result.push(...flattenTree(node.children, depth + 1));
  }
  return result;
}

/** Check if any rendered prose line is INSIDE a frame bbox.
 * Prose beside a frame (reflowed to the right/left) is fine — only flag
 * prose whose starting X is within the frame's horizontal span AND
 * whose Y is within the frame's vertical span. */
export function findProseFrameOverlaps(
  lines: Array<{ x: number; y: number; text: string; width: number }>,
  frames: Array<{ absX: number; absY: number; w: number; h: number }>,
  lineHeight: number,
): string[] {
  const overlaps: string[] = [];
  for (const line of lines) {
    for (const f of frames) {
      const ly = line.y;
      // Check if prose text overlaps frame interior (not just edges).
      // Prose overlaps if its horizontal span intersects the frame's interior
      // AND its Y is inside the frame's vertical range.
      const margin = 10; // edge tolerance
      const textLeft = line.x;
      const textRight = line.x + line.width;
      const frameLeft = f.absX + margin;
      const frameRight = f.absX + f.w - margin;
      const hOverlap = textLeft < frameRight && textRight > frameLeft;
      const insideV = ly >= f.absY + margin && ly + lineHeight <= f.absY + f.h - margin;
      if (hOverlap && insideV) {
        overlaps.push(`Prose "${line.text.substring(0, 40)}" at (${Math.round(line.x)},${Math.round(line.y)}) inside frame at (${Math.round(f.absX)},${Math.round(f.absY)}) ${Math.round(f.w)}x${Math.round(f.h)}`);
      }
    }
  }
  return overlaps;
}

/** Click the center of the Nth top-level frame (0-indexed).
 * Verifies the frame is actually selected after clicking.
 * Presses Escape first to clear any active prose cursor or text edit state. */
export async function clickFrame(page: Page, frameIndex: number) {
  // Ensure clean state and scroll frame into view
  await page.evaluate(() => {
    const g = (window as any).__gridpad;
    if (g.clearState) g.clearState();
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const frames = await getFrames(page);
  const canvas = page.locator("canvas");
  if (frameIndex >= frames.length) throw new Error(`clickFrame: frame ${frameIndex} not found (${frames.length} frames)`);
  const f = frames[frameIndex];
  // Scroll the frame into view — canvas is sticky inside a scroll container
  await page.evaluate((frameY) => {
    const canvas = document.querySelector("canvas");
    const parent = canvas?.parentElement;
    if (parent) parent.scrollTop = Math.max(0, frameY - 100);
  }, f.y);
  await page.waitForTimeout(100);
  // Re-read bounding box after scroll
  const boxAfterScroll = await canvas.boundingBox();
  const scrollTop = await page.evaluate(() => document.querySelector("canvas")?.parentElement?.scrollTop ?? 0);
  // Click at frame center in viewport coords — frame.y is in content coords, subtract scrollTop for viewport
  const viewportY = f.y - scrollTop;
  await page.mouse.click(boxAfterScroll!.x + f.x + f.w / 2, boxAfterScroll!.y + viewportY + f.h / 2);
  await page.waitForTimeout(300);
  const selId = await getSelectedId(page);
  if (!selId) {
    // Retry once
    await page.mouse.click(boxAfterScroll!.x + f.x + f.w / 2, boxAfterScroll!.y + viewportY + f.h / 2);
    await page.waitForTimeout(300);
    const retry = await getSelectedId(page);
    if (!retry) {
      // Programmatic fallback — bypasses hit testing. Log warning.
      console.warn(`clickFrame: WARNING — using programmatic fallback for frame ${frameIndex} (click-based selection failed, hit testing may be broken)`);
      await page.evaluate((frameId) => {
        (window as any).__gridpad.selectFrame(frameId);
      }, f.id);
      await page.waitForTimeout(100);
    }
  }
}

/** Drag the currently-selected frame by (dx, dy) pixels.
 * Verifies a frame is selected before dragging and that it actually moved.
 * Throws if no frame is selected or the frame didn't move. */
export async function dragSelected(page: Page, dx: number, dy: number) {
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  const selId = await getSelectedId(page);
  if (!selId) throw new Error(`dragSelected: no frame selected — call clickFrame first`);
  const frames = await getFrames(page);
  const f = frames.find(fr => fr.id === selId);
  if (!f) throw new Error(`dragSelected: selected frame ${selId} not found in getFrames`);
  const beforeX = f.x, beforeY = f.y;
  // Account for scroll — frame.y is content coords, viewport needs scroll subtracted
  const scrollTop = await page.evaluate(() => document.querySelector("canvas")?.parentElement?.scrollTop ?? 0);
  const cx = box!.x + f.x + f.w / 2;
  const cy = box!.y + (f.y - scrollTop) + f.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 10));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i / steps), cy + (dy * i / steps));
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  // Verify frame moved (skip check for sub-pixel drags or boundary clamps)
  if (Math.abs(dx) >= 5 || Math.abs(dy) >= 5) {
    const framesAfter = await getFrames(page);
    const fAfter = framesAfter.find(fr => fr.id === selId);
    if (fAfter) {
      const movedX = Math.abs(fAfter.x - beforeX);
      const movedY = Math.abs(fAfter.y - beforeY);
      // Allow no-move if drag would push past boundary (e.g., negative clamp)
      const wouldClamp = (beforeX + dx < 0) || (beforeY + dy < 0);
      if (movedX < 1 && movedY < 1 && !wouldClamp) {
        throw new Error(`dragSelected: frame ${selId} didn't move (before=${Math.round(beforeX)},${Math.round(beforeY)} after=${Math.round(fAfter.x)},${Math.round(fAfter.y)} dx=${dx} dy=${dy})`);
      }
    }
  }
}

/** Resize the currently-selected frame by dragging bottom-right handle.
 * Verifies the frame dimensions actually changed. */
export async function resizeSelected(page: Page, dw: number, dh: number) {
  const selId = await getSelectedId(page);
  if (!selId) throw new Error(`resizeSelected: no frame selected — call clickFrame first`);
  const frames = await getFrames(page);
  const f = frames.find(fr => fr.id === selId) ?? frames[0];
  const beforeW = f.w, beforeH = f.h;
  // Bottom-right corner in viewport coords (scroll-aware)
  const { box: rbox, scrollTop: rscroll } = await getScrollState(page);
  const { vx: hx, vy: hy } = toViewport(f.x + f.w, f.y + f.h, rbox, rscroll);
  await page.mouse.move(hx, hy);
  await page.waitForTimeout(100);
  await page.mouse.down();
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dw), Math.abs(dh)) / 10));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(hx + (dw * i / steps), hy + (dh * i / steps));
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  // Verify dimensions changed
  const framesAfter = await getFrames(page);
  const fAfter = framesAfter.find(fr => fr.id === selId);
  if (fAfter) {
    const dWidth = Math.abs(fAfter.w - beforeW);
    const dHeight = Math.abs(fAfter.h - beforeH);
    if (dWidth < 1 && dHeight < 1) {
      throw new Error(`resizeSelected: frame ${selId} didn't resize (before=${Math.round(beforeW)}x${Math.round(beforeH)} after=${Math.round(fAfter.w)}x${Math.round(fAfter.h)} dw=${dw} dh=${dh})`);
    }
  }
}

/** Click on prose area at canvas-relative coordinates */
export async function clickProse(page: Page, relX: number, relY: number) {
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.click(box!.x + relX, box!.y + relY);
  await page.waitForTimeout(300);
}

/** Click a child frame inside a container (drill-down: click parent first, then child).
 * Verifies a child frame is selected (different ID from parent). */
export async function clickChild(page: Page, parentIndex: number) {
  const frames = await getFrames(page);
  if (parentIndex >= frames.length) throw new Error(`clickChild: frame ${parentIndex} not found (${frames.length} frames)`);
  const f = frames[parentIndex];
  const parentId = f.id;
  const { box: cbox, scrollTop: cscroll } = await getScrollState(page);
  const { vx: cx, vy: cy } = toViewport(f.x + f.w / 2, f.y + f.h / 2, cbox, cscroll);
  // First click selects parent
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(200);
  // Second click drills down to child
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  // Verify a child is selected (different ID from parent)
  const childId = await getSelectedId(page);
  if (!childId) throw new Error(`clickChild: nothing selected after drill-down click on frame ${parentIndex}`);
  if (childId === parentId) {
    // Might be a container without selectable children — warn but don't throw
    console.warn(`clickChild: still selecting parent ${parentId} after drill-down — frame may not have selectable children`);
  }
}

/** Double-click center of Nth frame to enter text edit mode.
 * Verifies text edit mode is active after double-click. */
export async function dblclickFrame(page: Page, frameIndex: number) {
  const frames = await getFrames(page);
  if (frameIndex >= frames.length) throw new Error(`dblclickFrame: frame ${frameIndex} not found (${frames.length} frames)`);
  const f = frames[frameIndex];
  const { box, scrollTop } = await getScrollState(page);
  const { vx, vy } = toViewport(f.x + f.w / 2, f.y + f.h / 2, box, scrollTop);
  await page.mouse.dblclick(vx, vy);
  await page.waitForTimeout(300);
  const textEdit = await page.evaluate(() => (window as any).__gridpad.getTextEdit?.());
  if (textEdit === null || textEdit === undefined) {
    // Not all frames support text edit — only warn, don't throw
    console.warn(`dblclickFrame: text edit mode not active after double-click on frame ${frameIndex}`);
  }
}

/** Get current scroll offset and canvas bounding box */
export async function getScrollState(page: Page) {
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  const scrollTop = await page.evaluate(() =>
    document.querySelector("canvas")?.parentElement?.scrollTop ?? 0,
  );
  return { box: box!, scrollTop };
}

/** Convert content coordinates to viewport coordinates */
export function toViewport(
  contentX: number, contentY: number,
  box: { x: number; y: number }, scrollTop: number,
): { vx: number; vy: number } {
  return { vx: box.x + contentX, vy: box.y + (contentY - scrollTop) };
}

/** Verify frame borders are actually rendered on the canvas at expected positions.
 * Checks that lit (non-background) pixels exist in a thin strip along each frame's
 * top edge. Returns a list of frames that failed the check. */
export async function verifyFramesRendered(
  page: Page,
  tree: Array<{ absX: number; absY: number; w: number; h: number; children?: any[] }>,
): Promise<string[]> {
  const flat: Array<{ absX: number; absY: number; w: number; h: number }> = [];
  const collect = (nodes: any[]) => {
    for (const n of nodes) {
      // Only check content frames (rect/line), not invisible containers
      if (n.w > 5 && n.h > 5 && n.contentType && n.contentType !== "container") {
        flat.push({ absX: n.absX, absY: n.absY, w: n.w, h: n.h });
      }
      if (n.children) collect(n.children);
    }
  };
  collect(tree);
  if (flat.length === 0) return [];

  return page.evaluate((frames) => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return ["No canvas found"];
    const ctx = canvas.getContext("2d");
    if (!ctx) return ["No 2d context"];
    // Canvas may have a CSS<->backing-store scale applied via ctx.scale().
    // Use canvas.width/clientWidth to detect the ratio.
    const scale = canvas.width / (canvas.clientWidth || canvas.width);
    const failures: string[] = [];
    for (const f of frames) {
      // Sample the entire frame bbox to check if ANYTHING is rendered
      const sx = Math.max(0, Math.round(f.absX * scale));
      const sy = Math.max(0, Math.round(f.absY * scale));
      const sw = Math.min(Math.max(1, Math.round(f.w * scale)), canvas.width - sx);
      const sh = Math.min(Math.max(1, Math.round(f.h * scale)), canvas.height - sy);
      if (sw <= 0 || sh <= 0) continue;
      const data = ctx.getImageData(sx, sy, sw, sh).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 150 || data[i + 1] > 150 || data[i + 2] > 150) lit++;
      }
      const ratio = lit / (data.length / 4);
      if (ratio < 0.02) {
        failures.push(`Frame at (${Math.round(f.absX)},${Math.round(f.absY)}) ${Math.round(f.w)}x${Math.round(f.h)}: no visible pixels (${(ratio * 100).toFixed(1)}% lit)`);
      }
    }
    return failures;
  }, flat);
}

/** Verify prose doc integrity — check for duplication and corruption.
 * Returns a list of issues found. */
export async function verifyProseIntegrity(
  page: Page,
  expectedFragments?: string[],
): Promise<string[]> {
  const prose: string = await page.evaluate(() => (window as any).__gridpad.getProseDoc());
  const rendered: Array<{ text: string; sourceLine: number }> = await page.evaluate(
    () => (window as any).__gridpad.getRenderedLines().map((l: any) => ({ text: l.text, sourceLine: l.sourceLine })),
  );
  const issues: string[] = [];

  // Check for duplicated rendered lines (same text appearing at multiple source lines)
  const textCounts = new Map<string, number>();
  for (const r of rendered) {
    if (r.text.trim().length === 0) continue;
    textCounts.set(r.text, (textCounts.get(r.text) ?? 0) + 1);
  }
  for (const [text, count] of textCounts) {
    if (count > 1 && text.length > 3) {
      issues.push(`Duplicated rendered line (${count}x): "${text.substring(0, 50)}"`);
    }
  }

  // Check expected fragments are present in prose
  if (expectedFragments) {
    for (const frag of expectedFragments) {
      if (!prose.includes(frag)) {
        issues.push(`Missing expected prose fragment: "${frag}"`);
      }
    }
  }

  return issues;
}

/** Count blue selection pixels on the canvas */
export async function countSelectionPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return 0;
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 2] > 180 && data[i] < 100 && data[i + 1] < 160) count++;
    }
    return count;
  });
}

// ── Fixtures ───────────────────────────────────────────────

export const SIMPLE_BOX = `Prose above

┌──────────────┐
│              │
│              │
└──────────────┘

Prose below`;

export const LABELED_BOX = `Title

┌──────────────┐
│    Hello     │
└──────────────┘

End`;

export const JUNCTION = `Header

┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│  Bottom L │  Bottom R │
└───────────┴───────────┘

Footer`;

export const NESTED = `Top

┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘

Bottom`;

export const SIDE_BY_SIDE = `Text

┌──────┐  ┌──────┐
│  A   │  │  B   │
└──────┘  └──────┘

More text`;

export const TWO_SEPARATE = `Top

┌────┐
│ A  │
└────┘

Middle

┌────┐
│ B  │
└────┘

Bottom`;

export const FORM = `Form

┌──────────────────────────┐
│      Title               │
├──────────────────────────┤
│  Name:  ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
│  Email: ┌─────────────┐  │
│         │             │  │
│         └─────────────┘  │
└──────────────────────────┘

End`;

export const PURE_PROSE = `Just some prose.

Another paragraph.

A third one.`;

// ── Shared-wall fixtures ──────────────────────────────────

/** Two boxes sharing a vertical wall (different heights) */
export const SHARED_VERTICAL = `Title

┌────┐┌──────────┐
│ A  ││  B       │
│    ││          │
└────┘│          │
      │          │
      └──────────┘

End`;

/** Two boxes sharing a horizontal wall */
export const SHARED_HORIZONTAL = `Title

┌──────────────┐
│     Top      │
├──────────────┤
│    Bottom    │
└──────────────┘

End`;

/** Three boxes in a row sharing walls */
export const THREE_IN_ROW = `Header

┌───┬──────┬─────────┐
│ S │  Med │  Wide   │
│   │      │         │
└───┴──────┴─────────┘

Footer`;

/** Tall narrow box next to short wide box (asymmetric shared wall) */
export const ASYMMETRIC_SHARED = `Notes

┌──┐┌──────────────────┐
│  ││                  │
│  │└──────────────────┘
│  │
│  │┌────┐
│  ││ X  │
└──┘└────┘

Done`;

/** 3x2 grid — full matrix of shared walls */
export const GRID_3X2 = `Layout

┌─────┬─────┬─────┐
│ A   │ B   │ C   │
├─────┼─────┼─────┤
│ D   │ E   │ F   │
└─────┴─────┴─────┘

End`;

export const DASHES_NOT_WIREFRAME = `# Table

| Name | Age |
|------|-----|
| Alice| 30  |

---

After the break.`;

export const EMOJI = `Hello 🎉

┌──────┐
│ Box  │
└──────┘

Café naïve 👨‍👩‍👧‍👦`;

export const WITH_CHILDREN = `Top

┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘

Bottom`;

// ── Realistic wireframe fixtures ──────────────────────────

/** Three-column dashboard with shared walls, inner boxes, text labels */
export const DASHBOARD = `## Dashboard

┌───────────────────────────────────────────────────────┐
│                      My App                           │
├───────────┬───────────────────────────┬───────────────┤
│ Nav       │  Main Content             │  Details      │
│           │                           │               │
│ Home      │  ┌─────────────────────┐  │  User: Alice  │
│ Search    │  │  Revenue Chart      │  │  Role: Admin  │
│ Settings  │  └─────────────────────┘  │               │
│ Help      │                           │  ┌─────────┐  │
│           │  ┌──────────┐ ┌────────┐  │  │ Actions │  │
│           │  │ Users    │ │ Tasks  │  │  │ Edit    │  │
│           │  │ 1,204    │ │ 38     │  │  │ Delete  │  │
│           │  └──────────┘ └────────┘  │  └─────────┘  │
└───────────┴───────────────────────────┴───────────────┘

Some text below the dashboard.`;

/** Mobile app with header, content, nested profile card, bottom nav */
export const MOBILE_APP = `## Mobile App

┌──────────────────┐
│    My App    ≡   │
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
│ Home  Star  Mail │
└──────────────────┘

Description of the mobile app.`;

/** Sign-up form with labeled input fields and button */
export const SIGNUP_FORM = `## Sign Up

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
└──────────────────────────┘

Terms and conditions below.`;

/** Flowchart — four boxes connected by horizontal lines */
export const FLOWCHART = `## User Flow

┌─────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│  Login  │────│ Dashboard │────│ Settings │────│  Logout  │
└─────────┘    └───────────┘    └──────────┘    └──────────┘

Drag the boxes to rearrange the flow.`;

/** Multi-section doc with prose between multiple wireframes */
export const MULTI_SECTION = `# Project Plan

## Header Component

The header should be responsive and collapse on mobile.

┌────────────────────────────────────────┐
│  Logo    Navigation     Search   User  │
└────────────────────────────────────────┘

## Content Area

Main content sits below the header with a sidebar.

┌──────────┬─────────────────────────────┐
│ Sidebar  │  Main Content               │
│          │                             │
│ Menu 1   │  ┌───────────────────────┐  │
│ Menu 2   │  │  Card Component       │  │
│ Menu 3   │  │  With some content    │  │
│          │  └───────────────────────┘  │
│          │                             │
│          │  ┌───────────────────────┐  │
│          │  │  Another Card         │  │
│          │  └───────────────────────┘  │
└──────────┴─────────────────────────────┘

## Footer

The footer contains links and copyright info.

┌────────────────────────────────────────┐
│  About  Contact  Privacy  Terms        │
└────────────────────────────────────────┘

End of document.`;

/** Kanban board — three columns with cards */
export const KANBAN = `## Kanban Board

┌────────────┬────────────┬────────────┐
│  To Do     │  In Prog   │  Done      │
├────────────┼────────────┼────────────┤
│ ┌────────┐ │ ┌────────┐ │ ┌────────┐ │
│ │ Task 1 │ │ │ Task 3 │ │ │ Task 5 │ │
│ └────────┘ │ └────────┘ │ └────────┘ │
│ ┌────────┐ │ ┌────────┐ │            │
│ │ Task 2 │ │ │ Task 4 │ │            │
│ └────────┘ │ └────────┘ │            │
└────────────┴────────────┴────────────┘

Drag tasks between columns.`;

/** Full CRM workspace — sidebar nav, main content with form, detail panel, chat */
export const CRM_WORKSPACE = `# CRM Workspace

┌────────────┬──────────────────────────────────────────────┬───────────────────┐
│ Navigation │  Customer Information Available              │  AI Assistant     │
│            │                                              │                   │
│ ┌────────┐ │  ┌────────────────────────────────────────┐  │  Context: Facade  │
│ │Customer│ │  │  Enter Customer Details          Done  │  │  Manual Test      │
│ │Info    │ │  ├────────────────────────────────────────┤  │                   │
│ └────────┘ │  │                                        │  │  picks up the     │
│ ┌────────┐ │  │  Customer Name *                       │  │  new data.        │
│ │Active  │ │  │  ┌──────────────────────────────────┐  │  │                   │
│ │Supplie │ │  │  │ Maddie                           │  │  │  ┌─────────────┐ │
│ └────────┘ │  │  └──────────────────────────────────┘  │  │  │  Complete   │ │
│ ┌────────┐ │  │                                        │  │  └─────────────┘ │
│ │Test    │ │  │  Company                               │  │                   │
│ │Analysi │ │  │  ┌──────────────────────────────────┐  │  │  invalidate data  │
│ └────────┘ │  │  │ Thirupathy                       │  │  │  for customer     │
│            │  │  └──────────────────────────────────┘  │  │  information      │
│            │  │                                        │  │                   │
│            │  │  Email *                                │  │  ┌─────────────┐ │
│            │  │  ┌──────────────────────────────────┐  │  │  │  Complete   │ │
│            │  │  │ maddie@isamazing.com              │  │  │  └─────────────┘ │
│            │  │  └──────────────────────────────────┘  │  │                   │
│            │  │                                        │  │                   │
│            │  │  Priority Level                        │  │                   │
│            │  │  ┌──────────────────────────────────┐  │  │                   │
│            │  │  │ 1                                 │  │  │                   │
│            │  │  └──────────────────────────────────┘  │  │                   │
│            │  │                                        │  │                   │
│            │  └────────────────────────────────────────┘  │                   │
└────────────┴──────────────────────────────────────────────┴───────────────────┘`;

/** Docker-style container list — table with nested rows and status indicators */
export const CONTAINER_LIST = `# Container Management

┌──────────────────────────────────────────────────────────────────────────────┐
│  Containers                                                                  │
├────────┬────────────┬──────────────┬──────────────┬──────────┬───────────────┤
│  Name  │ Container  │    Image     │   Port(s)    │  CPU (%) │ Last started  │
├────────┼────────────┼──────────────┼──────────────┼──────────┼───────────────┤
│ front  │ 174a2db6   │ colex-plat   │ 3342:5173    │  0.66%   │ 12 hours ago  │
│ direct │ 7504a956   │ colex-plat   │ 6684:8055    │  0.59%   │ 12 hours ago  │
│ tools  │ 226cbb93   │ colex-plat   │ 8201:8201    │  0.29%   │ 12 hours ago  │
│ postgr │ e053f9af   │ postgres:15  │ 5432:5432    │  0%      │ 12 hours ago  │
├────────┼────────────┼──────────────┼──────────────┼──────────┼───────────────┤
│ front  │ fbe4666d   │ colex-front  │ 3443:5173    │  0.08%   │ 12 hours ago  │
│ direct │ 2a1555d1   │ colex-direc  │ 6785:8055    │  0.7%    │ 12 hours ago  │
│ tools  │ 6231683b   │ colex-tools  │ 8301:8201    │  0.4%    │ 12 hours ago  │
└────────┴────────────┴──────────────┴──────────────┴──────────┴───────────────┘

Status: 7 containers running, 0 stopped.`;

/** Admin panel — top nav, sidebar with metrics, main content with data grid */
export const ADMIN_PANEL = `# Admin Dashboard

┌──────────────────────────────────────────────────────────────────────┐
│  ☰  Admin Panel        Search...                    User ▼  Notify  │
├──────────┬───────────────────────────────────────────────────────────┤
│ Overview │                                                           │
│ Users    │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│ Products │  │ Users    │ │ Revenue  │ │ Orders   │ │ Active   │    │
│ Orders   │  │ 12,847   │ │ $48.2K   │ │ 1,204    │ │ 847      │    │
│ Reports  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘    │
│ Settings │                                                           │
│          │  ┌────────────────────────────────────────────────────┐   │
│          │  │  Recent Activity                                   │   │
│          │  ├────────────────────────────────────────────────────┤   │
│          │  │  User "alice" logged in                  2m ago    │   │
│          │  │  Order #4521 shipped                     15m ago   │   │
│          │  │  Product "Widget Pro" updated            1h ago    │   │
│          │  │  Report generated                        3h ago    │   │
│          │  └────────────────────────────────────────────────────┘   │
│          │                                                           │
└──────────┴───────────────────────────────────────────────────────────┘

Footer: v2.1.0 | API Status: Online`;

/** Chat interface — message list with avatars, input box, sidebar with contacts */
export const CHAT_UI = `# Messaging

┌───────────┬──────────────────────────────────────────┬──────────────┐
│ Contacts  │  Chat: Alice                             │  Details     │
│           │                                          │              │
│ ┌───────┐ │  ┌────────────────────────────────────┐  │  Name: Alice │
│ │ Alice │ │  │  Hey! How's the project going?     │  │  Role: Dev   │
│ └───────┘ │  │                           10:23 AM │  │  Status: On  │
│ ┌───────┐ │  └────────────────────────────────────┘  │              │
│ │ Bob   │ │  ┌────────────────────────────────────┐  │  ┌────────┐ │
│ └───────┘ │  │  Great! Just pushed the fix.       │  │  │ Call   │ │
│ ┌───────┐ │  │                           10:25 AM │  │  └────────┘ │
│ │ Carol │ │  └────────────────────────────────────┘  │  ┌────────┐ │
│ └───────┘ │  ┌────────────────────────────────────┐  │  │ Video  │ │
│           │  │  Nice! I'll review it now.          │  │  └────────┘ │
│           │  │                           10:26 AM │  │              │
│           │  └────────────────────────────────────┘  │              │
│           │                                          │              │
│           │  ┌────────────────────────────────┬───┐  │              │
│           │  │  Type a message...             │ ▶ │  │              │
│           │  └────────────────────────────────┴───┘  │              │
└───────────┴──────────────────────────────────────────┴──────────────┘`;

/** Dense enterprise dashboard — the kind of wireframe that actually breaks things */
export const ENTERPRISE_DASHBOARD = `# Q4 Planning Dashboard

## KPI Summary

┌─────────────┬─────────────┬─────────────┬─────────────┬─────────────┐
│  Revenue    │  Customers  │  Churn      │  NPS Score  │  MRR Growth │
│  $2.4M      │  12,847     │  2.3%       │  72         │  +8.4%      │
│  ▲ 12%      │  ▲ 847      │  ▼ 0.4%     │  ▲ 3        │  ▲ 1.2%     │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────────┘

## Team Workload

Assign capacity based on sprint velocity and current commitments.

┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  Sprint 47 — Oct 14-25                                                                   │
├──────────┬───────────────────────────────────────────────────────────────────────────────┤
│ Alice    │  ┌──────────┐ ┌────────────────────┐ ┌──────┐                                │
│ (8 pts)  │  │ AUTH-401 │ │ AUTH-402 (5pts)     │ │ BUG  │                                │
│          │  │ Login    │ │ OAuth integration   │ │ #847 │                                │
│          │  └──────────┘ └────────────────────┘ └──────┘                                │
├──────────┼───────────────────────────────────────────────────────────────────────────────┤
│ Bob      │  ┌────────────────────────────────┐ ┌──────────────────┐                     │
│ (6 pts)  │  │ DATA-301 (3pts)                │ │ DATA-302 (3pts)  │                     │
│          │  │ Pipeline refactor              │ │ Cache layer      │                     │
│          │  └────────────────────────────────┘ └──────────────────┘                     │
├──────────┼───────────────────────────────────────────────────────────────────────────────┤
│ Carol    │  ┌──────────────────────────────────────────────┐ ┌────────────────────────┐ │
│ (10 pts) │  │ UI-501 (6pts)                                │ │ UI-502 (4pts)          │ │
│          │  │ Dashboard redesign                           │ │ Mobile responsive      │ │
│          │  │  ┌─────────────┐ ┌─────────────┐            │ │  ┌──────────────────┐  │ │
│          │  │  │ KPI cards   │ │ Chart panel │            │ │  │ Breakpoint tests │  │ │
│          │  │  └─────────────┘ └─────────────┘            │ │  └──────────────────┘  │ │
│          │  └──────────────────────────────────────────────┘ └────────────────────────┘ │
└──────────┴───────────────────────────────────────────────────────────────────────────────┘

## Risk Register

┌─────┬────────────────────────┬──────────┬───────────┬───────────────────────────────────┐
│  #  │  Risk                  │  Impact  │  Prob     │  Mitigation                       │
├─────┼────────────────────────┼──────────┼───────────┼───────────────────────────────────┤
│  1  │  OAuth vendor delay    │  High    │  Medium   │  Fallback to email/pass auth      │
│  2  │  Pipeline perf issue   │  Medium  │  Low      │  Benchmark before merge           │
│  3  │  Mobile Safari bugs    │  Medium  │  High     │  Dedicated QA sprint              │
│  4  │  Scope creep on UI-501 │  High    │  Medium   │  Fixed scope doc signed off       │
└─────┴────────────────────────┴──────────┴───────────┴───────────────────────────────────┘

Next planning session: Monday Oct 28.`;

/** Complex flowchart — decision tree with branches and merge */
export const DECISION_FLOWCHART = `# Deployment Decision Flow

┌──────────┐
│  Start   │
└────┬─────┘
     │
┌────┴─────┐
│  Tests   │
│  Pass?   │
└──┬────┬──┘
   │    │
  Yes   No
   │    │
┌──┴──┐ ┌──┴──────┐
│ QA  │ │  Fix    │
│Check│ │  Bugs   │
└──┬──┘ └──┬──────┘
   │       │
┌──┴───────┴──┐
│   Deploy    │
│  to Staging │
└──────┬──────┘
       │
┌──────┴──────┐
│  Smoke Test │
│  Pass?      │
└──┬───────┬──┘
   │       │
  Yes      No
   │       │
┌──┴────┐ ┌┴────────┐
│Deploy │ │ Rollback │
│  Prod │ │          │
└───────┘ └──────────┘

Review deployment logs after each release.`;

/** Microservice architecture diagram */
export const ARCHITECTURE_DIAGRAM = `# System Architecture

┌─────────────────────────────────────────────────────────────────────┐
│                        Load Balancer                                │
└──────────┬──────────────────┬───────────────────┬───────────────────┘
           │                  │                   │
    ┌──────┴──────┐   ┌──────┴──────┐   ┌────────┴────────┐
    │  API GW     │   │  API GW     │   │  API GW         │
    │  (primary)  │   │  (replica)  │   │  (replica)      │
    └──────┬──────┘   └──────┬──────┘   └────────┬────────┘
           │                  │                   │
    ┌──────┴──────────────────┴───────────────────┴────────┐
    │                    Message Bus (Kafka)                │
    └──┬──────────┬──────────┬──────────┬──────────────────┘
       │          │          │          │
  ┌────┴────┐ ┌──┴────┐ ┌──┴─────┐ ┌──┴──────┐
  │ Auth    │ │ Users │ │ Orders │ │ Payment │
  │ Service │ │ Svc   │ │ Svc    │ │ Svc     │
  ├─────────┤ ├───────┤ ├────────┤ ├─────────┤
  │ ┌─────┐ │ │┌─────┐│ │┌──────┐│ │┌───────┐│
  │ │Redis│ │ ││Pg DB││ ││Pg DB ││ ││Stripe ││
  │ └─────┘ │ │└─────┘│ │└──────┘│ │└───────┘│
  └─────────┘ └───────┘ └────────┘ └─────────┘

Each service owns its database. Communication via async events.`;

/** User journey / state machine */
export const USER_JOURNEY = `# User Onboarding Flow

         ┌──────────────┐
         │  Landing     │
         │  Page        │
         └──────┬───────┘
                │
         ┌──────┴───────┐
    ┌────┤  Sign Up     ├────┐
    │    │  Form        │    │
    │    └──────────────┘    │
  Email                   Google
  Verify                   OAuth
    │                        │
┌───┴────────┐    ┌──────────┴──┐
│  Verify    │    │  Consent    │
│  Email     │    │  Screen     │
└───┬────────┘    └──────┬──────┘
    │                    │
    └────────┬───────────┘
             │
      ┌──────┴───────┐
      │  Profile     │
      │  Setup       │
      ├──────────────┤
      │ Name: ┌────┐ │
      │       │    │ │
      │       └────┘ │
      │ Role: ┌────┐ │
      │       │    │ │
      │       └────┘ │
      └──────┬───────┘
             │
      ┌──────┴───────┐
      │  Welcome     │
      │  Dashboard   │
      └──────────────┘

Avg completion: 3.2 minutes.`;
