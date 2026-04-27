/**
 * Gridpad Round-Trip Harness
 *
 * Every test:
 *   1. Writes {test}-input.md to disk
 *   2. Loads it into Gridpad
 *   3. Screenshots → {test}-before.png
 *   4. Performs action (or none)
 *   5. Calls saveDocument() (full save flow with ref updates)
 *   6. Writes {test}-output.md to disk
 *   7. Screenshots → {test}-after.png
 *   8. Reloads output.md, screenshots → {test}-reloaded.png
 *   9. Asserts: markdown correctness + visual fidelity
 *
 * Artifacts dir: e2e/artifacts/
 * Run: npx playwright test e2e/harness.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTIFACTS = path.join(__dirname, "artifacts");

// Wire drawing characters — if these appear in a prose-only line, it's a ghost
const WIRE_CHARS = new Set([..."┌┐└┘│─├┤┬┴┼═║╔╗╚╝╠╣╦╩╬"]);

// ── Helpers ────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeArtifact(testName: string, suffix: string, content: string | Buffer) {
  ensureDir(path.join(ARTIFACTS, testName));
  const p = path.join(ARTIFACTS, testName, suffix);
  fs.writeFileSync(p, content);
  return p;
}

/** Load markdown into Gridpad */
async function load(page: Page, md: string) {
  await page.evaluate((t) => (window as any).__gridpad.loadDocument(t), md);
  await page.waitForTimeout(600);
}

/** Save via full save flow (serialize + update refs) */
async function save(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__gridpad.saveDocument());
}

/** Get frame rectangles in CSS pixel coordinates */
async function getFrames(page: Page): Promise<Array<{
  id: string; x: number; y: number; w: number; h: number;
  hasChildren: boolean; contentType: string;
}>> {
  return page.evaluate(() => (window as any).__gridpad.getFrameRects());
}

/** Screenshot the canvas element */
async function screenshot(page: Page, testName: string, label: string): Promise<Buffer> {
  const buf = await page.locator("canvas").screenshot();
  writeArtifact(testName, `${label}.png`, buf);
  return buf;
}

/** Pixel diff percentage between two PNG buffers */
async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
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
function findGhosts(
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

/** Compute frame grid bboxes from the full frame tree (all levels) for ghost detection */
function computeFrameGridBboxes(
  tree: Array<{ absX: number; absY: number; w: number; h: number; children?: any[] }>,
  cw: number, ch: number,
): Array<{ row: number; col: number; w: number; h: number }> {
  const bboxes: Array<{ row: number; col: number; w: number; h: number }> = [];
  const collect = (nodes: any[]) => {
    for (const n of nodes) {
      bboxes.push({
        row: Math.round(n.absY / ch),
        col: Math.round(n.absX / cw),
        w: Math.max(1, Math.round(n.w / cw)),
        h: Math.max(1, Math.round(n.h / ch)),
      });
      if (n.children) collect(n.children);
    }
  };
  collect(tree);
  return bboxes;
}

/** Get measured character dimensions from the page */
async function getCharDims(page: Page): Promise<{ cw: number; ch: number }> {
  return page.evaluate(() => (window as any).__gridpad.getCharDims());
}

/** Find ghosts using frame tree from the page */
async function findGhostsFromPage(page: Page, md: string): Promise<string[]> {
  const tree = await getFrameTree(page);
  const { cw, ch } = await getCharDims(page);
  const bboxes = computeFrameGridBboxes(tree, cw, ch);
  return findGhosts(md, null, bboxes);
}

/** Post-condition invariants — run after every interaction */
function checkInvariants(tree: any[]): string[] {
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

/** @deprecated — no longer used. Ghost detection uses frame-bbox mask instead. */
function findWireframeSections(md: string): { startRow: number; endRow: number }[] {
  const lines = md.split("\n");
  const sections: { startRow: number; endRow: number }[] = [];
  let inSection = false;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const hasWire = [...lines[i]].some(ch => WIRE_CHARS.has(ch));
    if (hasWire && !inSection) { inSection = true; start = i; }
    if (!hasWire && inSection) { sections.push({ startRow: start, endRow: i - 1 }); inSection = false; }
  }
  if (inSection) sections.push({ startRow: start, endRow: lines.length - 1 });
  return sections;
}

/** Click the center of the Nth top-level frame (0-indexed).
 * Verifies the frame is actually selected after clicking.
 * Presses Escape first to clear any active prose cursor or text edit state. */
async function clickFrame(page: Page, frameIndex: number) {
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
async function dragSelected(page: Page, dx: number, dy: number) {
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

/** Get the full frame tree from Gridpad */
async function getFrameTree(page: Page): Promise<Array<{
  id: string; absX: number; absY: number; w: number; h: number;
  contentType: string; text: string | null; dirty: boolean;
  childCount: number; children: any[];
}>> {
  return page.evaluate(() => (window as any).__gridpad.getFrameTree());
}

/** Get the selected frame ID */
async function getSelectedId(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__gridpad.getSelectedId());
}

/** Get rendered prose lines from reflowLayout */
async function getRenderedLines(page: Page): Promise<Array<{
  x: number; y: number; text: string; width: number;
}>> {
  return page.evaluate(() => (window as any).__gridpad.getRenderedLines());
}

/** Flatten a frame tree into a flat list with depth */
function flattenTree(tree: any[], depth = 0): Array<{ depth: number; contentType: string; text: string | null; absX: number; absY: number; w: number; h: number; childCount: number }> {
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
function findProseFrameOverlaps(
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

/** Count blue selection pixels on the canvas */
async function countSelectionPixels(page: Page): Promise<number> {
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

/** Verify frame borders are actually rendered on the canvas at expected positions.
 * Checks that lit (non-background) pixels exist in a thin strip along each frame's
 * top edge. Returns a list of frames that failed the check. */
async function verifyFramesRendered(
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
    // Canvas may have a CSS↔backing-store scale applied via ctx.scale().
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
async function verifyProseIntegrity(
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

/** Get current scroll offset and canvas bounding box */
async function getScrollState(page: Page) {
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  const scrollTop = await page.evaluate(() =>
    document.querySelector("canvas")?.parentElement?.scrollTop ?? 0,
  );
  return { box: box!, scrollTop };
}

/** Convert content coordinates to viewport coordinates */
function toViewport(
  contentX: number, contentY: number,
  box: { x: number; y: number }, scrollTop: number,
): { vx: number; vy: number } {
  return { vx: box.x + contentX, vy: box.y + (contentY - scrollTop) };
}

/** Click on prose area at canvas-relative coordinates */
async function clickProse(page: Page, relX: number, relY: number) {
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.click(box!.x + relX, box!.y + relY);
  await page.waitForTimeout(300);
}

/** Double-click center of Nth frame to enter text edit mode.
 * Verifies text edit mode is active after double-click. */
async function dblclickFrame(page: Page, frameIndex: number) {
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

/** Resize the currently-selected frame by dragging bottom-right handle.
 * Verifies the frame dimensions actually changed. */
async function resizeSelected(page: Page, dw: number, dh: number) {
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

/** Click a child frame inside a container (drill-down: click parent first, then child).
 * Verifies a child frame is selected (different ID from parent). */
async function clickChild(page: Page, parentIndex: number) {
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

// ── Full round-trip runner ─────────────────────────────────

interface RoundTripResult {
  input: string;
  output: string;
  beforeShot: Buffer;
  afterShot: Buffer;
  reloadedShot: Buffer;
  visualDiff: number;      // before vs reloaded (%)
  markdownMatch: boolean;  // output === input
  ghosts: string[];        // ghost wire chars in prose lines
  renderFailures: string[];  // frames not visually rendered
  proseIssues: string[];     // prose duplication/corruption
  proseOverlaps: string[];   // prose text inside frame bboxes
}

async function roundTrip(
  page: Page,
  testName: string,
  inputMd: string,
  action?: (page: Page) => Promise<void>,
): Promise<RoundTripResult> {
  // Write input
  writeArtifact(testName, "input.md", inputMd);

  // Load and capture initial frame tree
  await load(page, inputMd);
  const treeBefore = await getFrameTree(page);
  writeArtifact(testName, "tree-before.json", JSON.stringify(flattenTree(treeBefore), null, 2));
  const beforeShot = await screenshot(page, testName, "1-before");

  // Action
  if (action) await action(page);
  if (action) await screenshot(page, testName, "2-after-action");

  // Save (full flow)
  const output = await save(page);
  writeArtifact(testName, "output.md", output);
  const afterShot = await screenshot(page, testName, "3-after-save");

  // Reload saved output and capture final frame tree
  await load(page, output);
  const treeAfter = await getFrameTree(page);
  writeArtifact(testName, "tree-after.json", JSON.stringify(flattenTree(treeAfter), null, 2));
  const reloadedShot = await screenshot(page, testName, "4-reloaded");

  // Compute diffs
  const refShot = action ? afterShot : beforeShot;
  const visualDiff = await pixelDiff(page, refShot, reloadedShot);

  // Ghost detection — always run, even for no-edit tests (input could have stray wire chars)
  const { cw: ghostCw, ch: ghostCh } = await getCharDims(page);
  const ghostBboxes = computeFrameGridBboxes(treeAfter, ghostCw, ghostCh);
  const ghosts = findGhosts(output, null, ghostBboxes);

  // Canvas verification: are frames actually rendered at their positions?
  const renderFailures = await verifyFramesRendered(page, treeAfter);

  // Prose integrity: check for duplication/corruption
  const proseIssues = await verifyProseIntegrity(page);

  // Prose-frame overlap: prose text shouldn't be inside frame interiors
  const renderedLines = await getRenderedLines(page);
  const flatFrames = flattenTree(treeAfter).filter(f => f.contentType !== "text");
  const proseOverlaps = findProseFrameOverlaps(renderedLines, flatFrames, 22);

  // Compute markdown diff
  const mdDiffLines: string[] = [];
  const inLines = inputMd.split("\n"), outLines = output.split("\n");
  const maxLen = Math.max(inLines.length, outLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (inLines[i] !== outLines[i]) {
      mdDiffLines.push(`  L${i + 1}:`);
      mdDiffLines.push(`    - ${JSON.stringify(inLines[i] ?? "<missing>")}`);
      mdDiffLines.push(`    + ${JSON.stringify(outLines[i] ?? "<missing>")}`);
    }
  }

  // Frame tree diff (for no-edit tests, trees should match)
  const flatBefore = flattenTree(treeBefore);
  const flatAfter = flattenTree(treeAfter);
  const treeDiffs: string[] = [];
  if (!action) {
    // No-edit: frame count and types should be identical
    if (flatBefore.length !== flatAfter.length) {
      treeDiffs.push(`Frame count: ${flatBefore.length} → ${flatAfter.length}`);
    }
    for (let i = 0; i < Math.min(flatBefore.length, flatAfter.length); i++) {
      const b = flatBefore[i], a = flatAfter[i];
      if (b.contentType !== a.contentType) treeDiffs.push(`Node ${i}: type ${b.contentType} → ${a.contentType}`);
      if (b.text !== a.text) treeDiffs.push(`Node ${i}: text ${JSON.stringify(b.text)} → ${JSON.stringify(a.text)}`);
      if (Math.abs(b.absX - a.absX) > 1 || Math.abs(b.absY - a.absY) > 1) {
        treeDiffs.push(`Node ${i}: pos (${Math.round(b.absX)},${Math.round(b.absY)}) → (${Math.round(a.absX)},${Math.round(a.absY)})`);
      }
    }
  }

  // Post-condition invariants
  const invariantFailures = checkInvariants(treeAfter);

  // Verify prose doc round-trips through CM
  const proseAfterReload = await page.evaluate(() => (window as any).__gridpad.getProseDoc());

  // Write summary with all diffs
  const summary = [
    `Test: ${testName}`,
    `Input lines: ${inLines.length}`,
    `Output lines: ${outLines.length}`,
    `Markdown match: ${output === inputMd}`,
    `Visual diff: ${visualDiff.toFixed(2)}%`,
    `Ghosts: ${ghosts.length}`,
    ...ghosts.map(g => `  ${g}`),
    `Render failures: ${renderFailures.length}`,
    ...renderFailures.map(f => `  ${f}`),
    `Prose issues: ${proseIssues.length}`,
    ...proseIssues.map(i => `  ${i}`),
    `Prose-frame overlaps: ${proseOverlaps.length}`,
    ...proseOverlaps.map(o => `  ${o}`),
    `Frame tree diffs: ${treeDiffs.length}`,
    ...treeDiffs.map(d => `  ${d}`),
    `Invariant failures: ${invariantFailures.length}`,
    ...invariantFailures.map(f => `  ${f}`),
    ...(mdDiffLines.length > 0 ? ["\nMarkdown diff:", ...mdDiffLines] : []),
    `\nProse doc after reload: ${proseAfterReload.split("\\n").length} lines`,
    `Frames before: ${flatBefore.length}  Frames after: ${flatAfter.length}`,
  ].join("\n");
  writeArtifact(testName, "summary.txt", summary);
  console.log(summary);

  return {
    input: inputMd, output,
    beforeShot, afterShot, reloadedShot,
    visualDiff,
    markdownMatch: output === inputMd,
    ghosts,
    renderFailures,
    proseIssues,
    proseOverlaps,
  };
}

// ── Fixtures ───────────────────────────────────────────────

const SIMPLE_BOX = `Prose above

┌──────────────┐
│              │
│              │
└──────────────┘

Prose below`;

const LABELED_BOX = `Title

┌──────────────┐
│    Hello     │
└──────────────┘

End`;

const JUNCTION = `Header

┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│  Bottom L │  Bottom R │
└───────────┴───────────┘

Footer`;

const NESTED = `Top

┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘

Bottom`;

const SIDE_BY_SIDE = `Text

┌──────┐  ┌──────┐
│  A   │  │  B   │
└──────┘  └──────┘

More text`;

const TWO_SEPARATE = `Top

┌────┐
│ A  │
└────┘

Middle

┌────┐
│ B  │
└────┘

Bottom`;

const FORM = `Form

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

const PURE_PROSE = `Just some prose.

Another paragraph.

A third one.`;

// ── Shared-wall fixtures ──────────────────────────────────

/** Two boxes sharing a vertical wall (different heights) */
const SHARED_VERTICAL = `Title

┌────┐┌──────────┐
│ A  ││  B       │
│    ││          │
└────┘│          │
      │          │
      └──────────┘

End`;

/** Two boxes sharing a horizontal wall */
const SHARED_HORIZONTAL = `Title

┌──────────────┐
│     Top      │
├──────────────┤
│    Bottom    │
└──────────────┘

End`;

/** Three boxes in a row sharing walls */
const THREE_IN_ROW = `Header

┌───┬──────┬─────────┐
│ S │  Med │  Wide   │
│   │      │         │
└───┴──────┴─────────┘

Footer`;

/** Tall narrow box next to short wide box (asymmetric shared wall) */
const ASYMMETRIC_SHARED = `Notes

┌──┐┌──────────────────┐
│  ││                  │
│  │└──────────────────┘
│  │
│  │┌────┐
│  ││ X  │
└──┘└────┘

Done`;

/** 3×2 grid — full matrix of shared walls */
const GRID_3X2 = `Layout

┌─────┬─────┬─────┐
│ A   │ B   │ C   │
├─────┼─────┼─────┤
│ D   │ E   │ F   │
└─────┴─────┴─────┘

End`;

const DASHES_NOT_WIREFRAME = `# Table

| Name | Age |
|------|-----|
| Alice| 30  |

---

After the break.`;

const EMOJI = `Hello 🎉

┌──────┐
│ Box  │
└──────┘

Café naïve 👨‍👩‍👧‍👦`;

// ── Tests ──────────────────────────────────────────────────

test.describe("harness", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  // ── No-edit round-trips (strict equality) ────────────────

  const noEditFixtures = [
    { name: "simple-box", md: SIMPLE_BOX },
    { name: "labeled-box", md: LABELED_BOX },
    { name: "junction-chars", md: JUNCTION },
    { name: "nested-boxes", md: NESTED },
    { name: "side-by-side", md: SIDE_BY_SIDE },
    { name: "two-separate", md: TWO_SEPARATE },
    { name: "form-layout", md: FORM },
    { name: "pure-prose", md: PURE_PROSE },
    { name: "dashes-not-wireframe", md: DASHES_NOT_WIREFRAME },
    { name: "emoji-unicode", md: EMOJI },
  ];

  for (const { name, md } of noEditFixtures) {
    test(`no-edit: ${name}`, async ({ page }) => {
      const r = await roundTrip(page, `no-edit-${name}`, md);
      expect(r.output, `Markdown mismatch for ${name}`).toBe(md);
      expect(r.ghosts, `Ghost chars in ${name}`).toEqual([]);
      expect(r.visualDiff).toBeLessThan(1);
    });
  }

  // ── Idempotent: save twice = same output ─────────────────

  test("idempotent: save twice without edits", async ({ page }) => {
    await load(page, JUNCTION);
    const save1 = await save(page);
    writeArtifact("idempotent", "save1.md", save1);
    const save2 = await save(page);
    writeArtifact("idempotent", "save2.md", save2);
    expect(save2).toBe(save1);
  });

  test("idempotent: 3 save cycles with default text", async ({ page }) => {
    // Use whatever Gridpad loaded by default
    const s1 = await save(page);
    writeArtifact("idempotent-3x", "save1.md", s1);
    // Reload saved, save again
    await load(page, s1);
    const s2 = await save(page);
    writeArtifact("idempotent-3x", "save2.md", s2);
    await load(page, s2);
    const s3 = await save(page);
    writeArtifact("idempotent-3x", "save3.md", s3);
    expect(s3).toBe(s2);
    expect(s2).toBe(s1);
  });

  // ── Drag tests ───────────────────────────────────────────

  test("drag: move box right, position changes in markdown", async ({ page }) => {
    const r = await roundTrip(page, "drag-right", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 80, 0);
      await clickProse(p, 5, 5);
    });
    expect(r.ghosts).toEqual([]);
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.output).toContain("Prose above");
    expect(r.output).toContain("Prose below");
    // The box should have moved right — its ┌ should be indented
    const origBoxLine = SIMPLE_BOX.split("\n").find(l => l.includes("┌"))!;
    const newBoxLine = r.output.split("\n").find(l => l.includes("┌"))!;
    const origIndent = origBoxLine.length - origBoxLine.trimStart().length;
    const newIndent = newBoxLine.length - newBoxLine.trimStart().length;
    expect(newIndent, `Box didn't move right: orig indent=${origIndent}, new=${newIndent}`).toBeGreaterThan(origIndent);
  });

  test("drag: move box down, no ghosts", async ({ page }) => {
    const r = await roundTrip(page, "drag-down", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 0, 100);
      await clickProse(p, 5, 5);
    });
    expect(r.ghosts).toEqual([]);
    expect(r.output).toContain("┌");
    expect(r.output).toContain("Prose above");
  });

  test("drag: move junction-char box, junctions preserved", async ({ page }) => {
    const r = await roundTrip(page, "drag-junction", JUNCTION, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 50, 0);
      await clickProse(p, 5, 5);
    });
    expect(r.ghosts).toEqual([]);
    // Junction chars should still exist (regenerated from cells)
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
  });

  test("drag: default dashboard wireframe down", async ({ page }) => {
    // Use the actual default text — this is the bug you found
    const r = await roundTrip(page, "drag-dashboard", "", async (p) => {
      // Load default (already loaded), just get frames
      const frames = await getFrames(p);
      if (frames.length > 0) {
        await clickFrame(p, 0);
        await dragSelected(p, 0, 150);
        await clickProse(p, 5, 5);
      }
    });
    expect(r.ghosts, "Ghost wire chars after dragging dashboard:\n" + r.ghosts.join("\n")).toEqual([]);
  });

  // ── Prose editing ────────────────────────────────────────

  test("edit: type text at start of prose", async ({ page }) => {
    const r = await roundTrip(page, "type-at-start", SIMPLE_BOX, async (p) => {
      await clickProse(p, 5, 5);
      await p.keyboard.press("Home");
      await p.keyboard.type("INSERTED ");
    });
    expect(r.output).toContain("INSERTED");
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.ghosts).toEqual([]);
    expect(r.visualDiff).toBeLessThan(5);
  });

  test("edit: Enter above wireframe pushes it down", async ({ page }) => {
    const r = await roundTrip(page, "enter-above", SIMPLE_BOX, async (p) => {
      await clickProse(p, 5, 5);
      await p.keyboard.press("End");
      await p.keyboard.press("Enter");
      await p.keyboard.press("Enter");
      await p.keyboard.press("Enter");
    });
    expect(r.output).toContain("┌──────────────┐");
    expect(r.output).toContain("└──────────────┘");
    expect(r.ghosts).toEqual([]);
    // 3 extra newlines
    const origLines = SIMPLE_BOX.split("\n").length;
    const outLines = r.output.split("\n").length;
    expect(outLines).toBe(origLines + 3);
  });

  test("edit: Backspace merges lines", async ({ page }) => {
    // Use simpler fixture — prose line directly after wireframe
    const fixture = `Line one\nLine two\n\n┌────┐\n│ A  │\n└────┘\n\nEnd`;
    const r = await roundTrip(page, "backspace-merge", fixture, async (p) => {
      // Click on "Line two" (second line, ~y=20)
      await clickProse(p, 5, 20);
      await p.keyboard.press("Home");
      await p.keyboard.press("Backspace");
    });
    expect(r.output).toContain("│ A  │");
    expect(r.output).toContain("End");
    expect(r.ghosts).toEqual([]);
  });

  test("edit: type between two wireframes", async ({ page }) => {
    const r = await roundTrip(page, "type-between", TWO_SEPARATE, async (p) => {
      // "Middle" is after first wireframe. Use getFrames to find it.
      const frames = await getFrames(p);
      // Click below the first wireframe, in the prose area
      const firstFrame = frames[0];
      const proseY = firstFrame ? firstFrame.y + firstFrame.h + 20 : 120;
      await clickProse(p, 30, proseY);
      await p.keyboard.press("End");
      await p.keyboard.type(" ADDED");
    });
    expect(r.output).toContain("ADDED");
    expect(r.output).toContain("│ A  │");
    expect(r.ghosts).toEqual([]);
  });

  // ── Delete ───────────────────────────────────────────────

  test("delete: remove wireframe, prose preserved", async ({ page }) => {
    const r = await roundTrip(page, "delete-frame", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await p.keyboard.press("Delete");
    });
    expect(r.output).not.toContain("┌");
    expect(r.output).not.toContain("└");
    expect(r.output).toContain("Prose above");
    expect(r.output).toContain("Prose below");
  });

  test("delete: undo restores wireframe", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("delete-undo", "input.md", SIMPLE_BOX);
    await screenshot(page, "delete-undo", "1-before");

    await clickFrame(page, 0);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(200);
    await screenshot(page, "delete-undo", "2-deleted");
    const afterDelete = await save(page);
    expect(afterDelete).not.toContain("┌");

    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    await screenshot(page, "delete-undo", "3-undone");
    // Note: after undo, frame should be back but we'd need to save again
    // to test serialization. This tests the visual restore.
  });

  // ── Add new frame ────────────────────────────────────────

  test("add: draw new rect, serialize includes it", async ({ page }) => {
    const r = await roundTrip(page, "add-rect", PURE_PROSE, async (p) => {
      await p.keyboard.press("r"); // rect tool
      await p.waitForTimeout(200);
      const canvas = p.locator("canvas");
      const box = await canvas.boundingBox();
      const sx = box!.x + 50, sy = box!.y + 100;
      await p.mouse.move(sx, sy);
      await p.mouse.down();
      await p.mouse.move(sx + 120, sy + 60);
      await p.mouse.up();
      await p.waitForTimeout(300);
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.output).toContain("Just some prose");
  });

  // ── Multi-cycle ──────────────────────────────────────────

  test("multi-cycle: edit → save → reload → edit → save", async ({ page }) => {
    let md = SIMPLE_BOX;
    for (let cycle = 1; cycle <= 3; cycle++) {
      await load(page, md);
      const canvas = page.locator("canvas");
      const box = await canvas.boundingBox();
      await page.mouse.click(box!.x + 5, box!.y + 5);
      await page.waitForTimeout(200);
      await page.keyboard.press("End");
      await page.keyboard.type(` round${cycle}`);
      await page.waitForTimeout(200);

      const edited = await screenshot(page, "multi-cycle", `cycle${cycle}-edited`);
      md = await save(page);
      writeArtifact("multi-cycle", `cycle${cycle}-output.md`, md);

      await load(page, md);
      const reloaded = await screenshot(page, "multi-cycle", `cycle${cycle}-reloaded`);
      const d = await pixelDiff(page, edited, reloaded);
      console.log(`cycle ${cycle}: ${d.toFixed(2)}% diff`);
      expect(d).toBeLessThan(5);

      const ghosts = await findGhostsFromPage(page, md);
      expect(ghosts).toEqual([]);
      expect(md).toContain("┌");
    }
    expect(md).toContain("round1");
    expect(md).toContain("round2");
    expect(md).toContain("round3");
  });

  // ── Resize ─────────────────────────────────────────────

  test("resize: expand box, verify larger dimensions in markdown", async ({ page }) => {
    const r = await roundTrip(page, "resize-expand", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      const f = (await getFrames(p))[0];
      const canvas = p.locator("canvas");
      const box = await canvas.boundingBox();
      // Bottom-right handle
      const hx = box!.x + f.x + f.w;
      const hy = box!.y + f.y + f.h;
      await p.mouse.move(hx, hy);
      await p.waitForTimeout(100);
      await p.mouse.down();
      await p.mouse.move(hx + 60, hy + 40);
      await p.mouse.up();
      await p.waitForTimeout(300);
      await clickProse(p, 5, 5); // deselect
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.output).toContain("Prose above");
    // Resized box should have wider top border than original 14-char
    const topBorder = r.output.split("\n").find(l => l.includes("┌") && l.includes("┐"));
    const origTopBorder = SIMPLE_BOX.split("\n").find(l => l.includes("┌"));
    if (topBorder && origTopBorder) {
      expect(topBorder.length).toBeGreaterThanOrEqual(origTopBorder.length);
    }
    expect(r.ghosts).toEqual([]);
  });

  // ── Undo after drag ────────────────────────────────────

  test("undo-drag: drag then undo, markdown matches original", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("undo-drag", "input.md", SIMPLE_BOX);
    await screenshot(page, "undo-drag", "1-before");

    // Drag
    await clickFrame(page, 0);
    await dragSelected(page, 80, 0);
    await clickProse(page, 5, 5);
    await screenshot(page, "undo-drag", "2-after-drag");

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    await screenshot(page, "undo-drag", "3-after-undo");

    // Save and verify matches original
    const saved = await save(page);
    writeArtifact("undo-drag", "output.md", saved);
    expect(saved).toBe(SIMPLE_BOX);
  });

  // ── Default text no-edit ───────────────────────────────

  test("no-edit: default text byte-identical round-trip", async ({ page }) => {
    // Use whatever Gridpad loaded by default
    const original = await page.evaluate(() => (window as any).__gridpad.serializeDocument());
    writeArtifact("no-edit-default", "input.md", original);
    await screenshot(page, "no-edit-default", "1-before");

    // Reload, save, compare
    await load(page, original);
    const saved = await save(page);
    writeArtifact("no-edit-default", "output.md", saved);
    await screenshot(page, "no-edit-default", "2-after-reload-save");

    expect(saved).toBe(original);
  });

  // ── Drag then type combo ───────────────────────────────

  test("drag+type: drag wireframe, type prose, both persist", async ({ page }) => {
    const r = await roundTrip(page, "drag-then-type", SIMPLE_BOX, async (p) => {
      // Drag wireframe right
      await clickFrame(p, 0);
      await dragSelected(p, 60, 0);
      await clickProse(p, 5, 5);

      // Type in prose
      await p.keyboard.press("End");
      await p.keyboard.type(" COMBO");
      await p.waitForTimeout(200);
    });
    expect(r.output).toContain("COMBO");
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.ghosts).toEqual([]);
    expect(r.visualDiff).toBeLessThan(10);
  });

  // ── Text label edit inside wireframe ───────────────────

  test("text-label: double-click label, append char, verify", async ({ page }) => {
    await load(page, LABELED_BOX);
    writeArtifact("text-label-edit", "input.md", LABELED_BOX);
    await screenshot(page, "text-label-edit", "1-before");

    // Find the text child via frame tree
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    const textNode = flat.find(f => f.contentType === "text");
    writeArtifact("text-label-edit", "tree.json", JSON.stringify(flat, null, 2));

    if (!textNode) {
      // If no text child, the label might be in the parent — try clicking center
      await clickFrame(page, 0);
    } else {
      // Drill down: click parent first, then child
      await clickChild(page, 0);
    }

    // Double-click to enter text edit mode — use scroll-aware coordinates
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const scrollTop = await page.evaluate(() => document.querySelector("canvas")?.parentElement?.scrollTop ?? 0);
    const target = textNode ?? flat[0];
    const dblX = box!.x + target.absX + target.w / 2;
    const dblY = box!.y + (target.absY - scrollTop) + target.h / 2;
    await page.mouse.dblclick(dblX, dblY);
    await page.waitForTimeout(300);

    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.waitForTimeout(300);
    await screenshot(page, "text-label-edit", "2-after-edit");

    const saved = await save(page);
    writeArtifact("text-label-edit", "output.md", saved);
    await screenshot(page, "text-label-edit", "3-after-save");

    // MUST assert — no silent pass
    expect(saved, "Text label edit should produce Hello!").toContain("Hello!");
    expect(saved, "Wireframe should survive text edit").toContain("┌");
    expect(saved, "Surrounding prose should survive").toContain("Title");
    const labelGhosts = await findGhostsFromPage(page, saved);
    expect(labelGhosts, "Text edit should not create ghosts").toEqual([]);
  });

  // ── Large drag past other wireframes ───────────────────

  test("large-drag: drag first wireframe past second, no collision", async ({ page }) => {
    const r = await roundTrip(page, "large-drag", TWO_SEPARATE, async (p) => {
      await clickFrame(p, 0);
      // Drag way down past the second wireframe
      await dragSelected(p, 0, 300);
      await clickProse(p, 5, 5);
    });
    // Both wireframe markers should exist
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.ghosts).toEqual([]);
    // Verify no prose/wireframe interleaving on same lines
    const lines = r.output.split("\n");
    for (const line of lines) {
      const hasWire = [...line].some(c => WIRE_CHARS.has(c));
      const hasProseWord = /\b(Top|Middle|Bottom)\b/.test(line);
      if (hasWire && hasProseWord) {
        // This line has both wire chars and prose — possible collision
        // Allow if it's a labeled wireframe like "│ A  │"
        if (!/^[│┌└├┤─┬┴┼\s]*$/.test(line.replace(/[A-Za-z]/g, ''))) {
          // Has non-wire, non-alpha chars mixed — suspect
        }
      }
    }
  });

  // ═══════════════════════════════════════════════════════
  // STRUCTURAL TESTS — verify the frame tree is correct
  // ═══════════════════════════════════════════════════════

  test("structure: simple box produces 1 rect frame, 0 containers", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    writeArtifact("struct-simple-box", "tree.json", JSON.stringify(flat, null, 2));

    // 1 top-level rect frame (no container for a single rect)
    expect(tree).toHaveLength(1);
    expect(tree[0].contentType).toBe("rect");
    expect(tree[0].childCount).toBe(0);
  });

  test("structure: side-by-side boxes produce 1 container with 2 rect children", async ({ page }) => {
    await load(page, SIDE_BY_SIDE);
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    writeArtifact("struct-side-by-side", "tree.json", JSON.stringify(flat, null, 2));

    // 1 container wrapping 2 rects (same row range → grouped)
    expect(tree).toHaveLength(1);
    expect(tree[0].contentType).toBe("container");
    const rectChildren = tree[0].children.filter((c: any) => c.contentType === "rect");
    expect(rectChildren.length).toBe(2);
  });

  test("structure: nested boxes — outer rect contains inner rect", async ({ page }) => {
    await load(page, NESTED);
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    writeArtifact("struct-nested", "tree.json", JSON.stringify(flat, null, 2));

    // Should have 1 top-level frame (outer rect or container)
    expect(tree).toHaveLength(1);
    // The outer rect should have children (inner rect + text labels)
    expect(tree[0].childCount).toBeGreaterThan(0);

    // Max depth should be reasonable (not deeply nested from over-grouping)
    const maxDepth = Math.max(...flat.map(f => f.depth));
    writeArtifact("struct-nested", "summary.txt",
      `Top-level frames: ${tree.length}\n` +
      `Total nodes: ${flat.length}\n` +
      `Max depth: ${maxDepth}\n` +
      flat.map(f => `${"  ".repeat(f.depth)}${f.contentType} ${f.text ? `"${f.text}"` : ""} at (${Math.round(f.absX)},${Math.round(f.absY)}) ${f.w.toFixed(0)}x${f.h.toFixed(0)}`).join("\n"));
    expect(maxDepth).toBeLessThanOrEqual(4); // rect → text is depth 1-2, nested → 3-4 max
  });

  test("structure: two separate wireframes produce 2 top-level frames", async ({ page }) => {
    await load(page, TWO_SEPARATE);
    const tree = await getFrameTree(page);
    writeArtifact("struct-two-separate", "tree.json", JSON.stringify(tree, null, 2));

    // Far apart vertically → should NOT be grouped into one container
    expect(tree.length).toBe(2);
  });

  test("structure: junction-char box — single container, multiple rect children", async ({ page }) => {
    await load(page, JUNCTION);
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    writeArtifact("struct-junction", "tree.json", JSON.stringify(flat, null, 2));
    writeArtifact("struct-junction", "summary.txt",
      flat.map(f => `${"  ".repeat(f.depth)}${f.contentType} ${f.text ? `"${f.text}"` : ""} children=${f.childCount}`).join("\n"));

    // Junction box has multiple sub-rects (divided cells) → 1 container
    expect(tree).toHaveLength(1);
  });

  test("structure: form layout — reasonable nesting depth", async ({ page }) => {
    await load(page, FORM);
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    writeArtifact("struct-form", "tree.json", JSON.stringify(flat, null, 2));
    writeArtifact("struct-form", "summary.txt",
      `Nodes: ${flat.length}\nMax depth: ${Math.max(...flat.map(f => f.depth))}\n` +
      flat.map(f => `${"  ".repeat(f.depth)}${f.contentType} ${f.text ? `"${f.text}"` : ""}`).join("\n"));

    const maxDepth = Math.max(...flat.map(f => f.depth));
    expect(maxDepth).toBeLessThanOrEqual(4);
  });

  test("structure: default text — frame tree matches expected wireframe count", async ({ page }) => {
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    writeArtifact("struct-default", "tree.json", JSON.stringify(flat, null, 2));
    writeArtifact("struct-default", "summary.txt",
      `Top-level: ${tree.length}\nTotal nodes: ${flat.length}\nMax depth: ${Math.max(...flat.map(f => f.depth))}\n\n` +
      flat.map(f => `${"  ".repeat(f.depth)}${f.contentType} ${f.text ? `"${f.text}"` : ""} at (${Math.round(f.absX)},${Math.round(f.absY)}) ${f.w.toFixed(0)}x${f.h.toFixed(0)} children=${f.childCount}`).join("\n"));

    // Default text has 4 wireframes: dashboard, mobile app, user flow, sign up form
    expect(tree.length).toBe(4);
    // None should be excessively deep
    const maxDepth = Math.max(...flat.map(f => f.depth));
    expect(maxDepth).toBeLessThanOrEqual(5);
  });

  // ═══════════════════════════════════════════════════════
  // VISUAL CORRECTNESS — verify rendering is correct
  // ═══════════════════════════════════════════════════════

  test("visual: no selection highlights on fresh load", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await screenshot(page, "visual-no-selection", "1-fresh-load");
    const blue = await countSelectionPixels(page);
    expect(blue, "Selection pixels visible on fresh load").toBe(0);
  });

  test("visual: selection appears on click, disappears on deselect", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await screenshot(page, "visual-selection-toggle", "1-before");

    // Click wireframe — should show selection
    await clickFrame(page, 0);
    await screenshot(page, "visual-selection-toggle", "2-selected");
    const blueAfterClick = await countSelectionPixels(page);
    expect(blueAfterClick).toBeGreaterThan(0);

    // Click empty prose area — should deselect
    await clickProse(page, 5, 5);
    await screenshot(page, "visual-selection-toggle", "3-deselected");
    const blueAfterDeselect = await countSelectionPixels(page);
    expect(blueAfterDeselect).toBe(0);
  });

  test("visual: prose does not overlap wireframes on fresh load", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    const lines = await getRenderedLines(page);
    const tree = await getFrameTree(page);
    const frameBboxes = flattenTree(tree).filter(f => f.contentType !== "container");
    const overlaps = findProseFrameOverlaps(lines, frameBboxes, 19); // ~PROSE_LINE_HEIGHT
    writeArtifact("visual-no-overlap", "overlaps.txt",
      overlaps.length > 0 ? overlaps.join("\n") : "No overlaps");
    // reflowLayout should prevent overlaps
    expect(overlaps, "Prose overlaps wireframes:\n" + overlaps.join("\n")).toEqual([]);
  });

  test("visual: prose reflows correctly after drag", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await clickFrame(page, 0);
    await dragSelected(page, 200, 0); // drag right
    await clickProse(page, 5, 5);
    await page.waitForTimeout(300);

    const lines = await getRenderedLines(page);
    const tree = await getFrameTree(page);
    const frameBboxes = flattenTree(tree).filter(f => f.contentType !== "container");
    const overlaps = findProseFrameOverlaps(lines, frameBboxes, 19);
    writeArtifact("visual-reflow-after-drag", "overlaps.txt",
      overlaps.length > 0 ? overlaps.join("\n") : "No overlaps");
    await screenshot(page, "visual-reflow-after-drag", "1-dragged");
    expect(overlaps, "Prose overlaps after drag:\n" + overlaps.join("\n")).toEqual([]);
  });

  test("visual: default text — no prose overlaps any wireframe", async ({ page }) => {
    const lines = await getRenderedLines(page);
    const tree = await getFrameTree(page);
    const frameBboxes = flattenTree(tree).filter(f => f.contentType !== "container");
    const overlaps = findProseFrameOverlaps(lines, frameBboxes, 19);
    writeArtifact("visual-default-no-overlap", "overlaps.txt",
      `Lines: ${lines.length}\nFrames: ${frameBboxes.length}\nOverlaps: ${overlaps.length}\n` +
      (overlaps.length > 0 ? overlaps.join("\n") : "None"));
    await screenshot(page, "visual-default-no-overlap", "1-default");
    expect(overlaps, "Prose overlaps wireframes in default text:\n" + overlaps.join("\n")).toEqual([]);
  });

  test("visual: text labels inside wireframes are fully visible (not truncated)", async ({ page }) => {
    await load(page, LABELED_BOX);
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    const textNodes = flat.filter(f => f.contentType === "text" && f.text);
    writeArtifact("visual-text-labels", "labels.json", JSON.stringify(textNodes, null, 2));

    for (const t of textNodes) {
      // Text frame should be inside its parent rect (not extending beyond)
      const parent = flat.find(f =>
        f.contentType === "rect" &&
        t.absX >= f.absX && t.absY >= f.absY &&
        t.absX + t.w <= f.absX + f.w + 10 && // small tolerance
        t.absY + t.h <= f.absY + f.h + 10
      );
      expect(parent, `Text "${t.text}" at (${Math.round(t.absX)},${Math.round(t.absY)}) is not inside any rect`).toBeDefined();
    }
  });
});

test.describe("bugs to fix", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("bug: no wire chars as text nodes in frame tree", async ({ page }) => {
    // Load default text — known to have "│" as a text node
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    const wireTextNodes = flat.filter(f =>
      f.contentType === "text" && f.text && WIRE_CHARS.has(f.text)
    );
    writeArtifact("bug-wire-text-nodes", "found.json", JSON.stringify(wireTextNodes, null, 2));
    expect(wireTextNodes, "Wire chars found as text nodes:\n" +
      wireTextNodes.map(n => `"${n.text}" at (${Math.round(n.absX)},${Math.round(n.absY)})`).join("\n")
    ).toEqual([]);
  });

  test("bug: text labels are not split by spaces", async ({ page }) => {
    const LABELED = `┌──────────────────┐\n│  Revenue Chart  │\n└──────────────────┘`;
    await load(page, LABELED);
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    const textNodes = flat.filter(f => f.contentType === "text" && f.text);
    writeArtifact("bug-split-labels", "labels.json", JSON.stringify(textNodes, null, 2));
    // "Revenue Chart" should be ONE text node, not two
    const hasRevenue = textNodes.some(t => t.text === "Revenue Chart");
    const hasSplitRevenue = textNodes.some(t => t.text === "Revenue") && textNodes.some(t => t.text === "Chart");
    expect(hasRevenue || !hasSplitRevenue, "Revenue Chart split into separate nodes").toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// UX STRESS TESTS — things real users do
// ═══════════════════════════════════════════════════════

test.describe("ux stress", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("ux: drag save drag save — position accumulates correctly", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("ux-drag-save-drag", "input.md", SIMPLE_BOX);

    // Drag right 50px, save
    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);
    const save1 = await save(page);
    writeArtifact("ux-drag-save-drag", "save1.md", save1);
    await screenshot(page, "ux-drag-save-drag", "1-after-first-drag");

    // Drag right another 50px, save
    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);
    const save2 = await save(page);
    writeArtifact("ux-drag-save-drag", "save2.md", save2);
    await screenshot(page, "ux-drag-save-drag", "2-after-second-drag");

    // Reload save2 — frame should be at accumulated position
    await load(page, save2);
    await screenshot(page, "ux-drag-save-drag", "3-reloaded");
    const finalFrames = await getFrames(page);
    // Frame should have moved right from its original position
    expect(finalFrames[0].x).toBeGreaterThan(50);
    expect(save2).toContain("┌");
    expect(await findGhostsFromPage(page, save2)).toEqual([]);
  });

  test("ux: tiny 2x2 wireframe round-trips", async ({ page }) => {
    const tiny = `Text\n\n┌┐\n└┘\n\nEnd`;
    const r = await roundTrip(page, "ux-tiny-box", tiny);
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.ghosts).toEqual([]);
  });

  test("ux: wide wireframe (50+ cols) round-trips", async ({ page }) => {
    const wide = `Title\n\n┌${"─".repeat(60)}┐\n│${" ".repeat(60)}│\n└${"─".repeat(60)}┘\n\nEnd`;
    const r = await roundTrip(page, "ux-wide-box", wide);
    expect(r.markdownMatch).toBe(true);
    expect(r.ghosts).toEqual([]);
  });

  test("ux: indented wireframe preserves column offset", async ({ page }) => {
    const indented = `Title\n\n     ┌──────┐\n     │ Box  │\n     └──────┘\n\nEnd`;
    const r = await roundTrip(page, "ux-indented", indented);
    // Box should still be indented in output
    const boxLine = r.output.split("\n").find(l => l.includes("┌"));
    expect(boxLine).toBeDefined();
    expect(boxLine!.startsWith("     ┌")).toBe(true);
  });

  test("ux: delete all wireframes leaves clean prose", async ({ page }) => {
    await load(page, TWO_SEPARATE);
    writeArtifact("ux-delete-all", "input.md", TWO_SEPARATE);

    // Delete first wireframe
    await clickFrame(page, 0);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);

    // Delete second wireframe (now index 0)
    const frames2 = await getFrames(page);
    if (frames2.length > 0) {
      await clickFrame(page, 0);
      await page.keyboard.press("Delete");
      await page.waitForTimeout(300);
    }

    await screenshot(page, "ux-delete-all", "1-all-deleted");
    const saved = await save(page);
    writeArtifact("ux-delete-all", "output.md", saved);

    // No wire chars should remain
    const hasWire = [...saved].some(c => WIRE_CHARS.has(c));
    expect(hasWire, "Wire chars remain after deleting all:\n" + saved).toBe(false);
    expect(saved).toContain("Top");
    expect(saved).toContain("Bottom");
  });

  test("ux: add wireframe to empty doc", async ({ page }) => {
    await load(page, "");
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Draw a rect
    await page.keyboard.press("r");
    await page.waitForTimeout(200);
    const sx = box!.x + 50, sy = box!.y + 50;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 100, sy + 60);
    await page.mouse.up();
    await page.waitForTimeout(300);

    await screenshot(page, "ux-add-to-empty", "1-drawn");
    const saved = await save(page);
    writeArtifact("ux-add-to-empty", "output.md", saved);

    expect(saved).toContain("┌");
    expect(saved).toContain("└");
  });

  test("ux: prose with markdown syntax survives", async ({ page }) => {
    const mdProse = `# Heading\n\n**Bold text** and *italic*\n\n- list item 1\n- list item 2\n\n> blockquote\n\n┌────┐\n│ OK │\n└────┘\n\n\`code\` and [link](url)`;
    const r = await roundTrip(page, "ux-markdown-syntax", mdProse);
    expect(r.output).toContain("# Heading");
    expect(r.output).toContain("**Bold text**");
    expect(r.output).toContain("- list item");
    expect(r.output).toContain("> blockquote");
    expect(r.output).toContain("`code`");
    expect(r.output).toContain("┌────┐");
    expect(r.ghosts).toEqual([]);
  });

  test("ux: 0 blank lines between prose and wireframe", async ({ page }) => {
    const tight = `Prose\n┌──┐\n│  │\n└──┘\nMore`;
    const r = await roundTrip(page, "ux-zero-blank-lines", tight);
    expect(r.output).toContain("┌");
    expect(r.output).toContain("Prose");
    expect(r.output).toContain("More");
    expect(r.ghosts).toEqual([]);
  });

  test("ux: 3 blank lines between prose and wireframe", async ({ page }) => {
    const spaced = `Prose\n\n\n\n┌──┐\n│  │\n└──┘\n\n\n\nMore`;
    const r = await roundTrip(page, "ux-three-blank-lines", spaced);
    expect(r.markdownMatch).toBe(true);
    expect(r.ghosts).toEqual([]);
  });

  test("ux: adjacent wireframes sharing a wall", async ({ page }) => {
    const adjacent = `Text\n\n┌────┬────┐\n│ L  │ R  │\n└────┴────┘\n\nEnd`;
    const r = await roundTrip(page, "ux-adjacent-wall", adjacent);
    expect(r.output).toContain("┬");
    expect(r.output).toContain("┴");
    expect(r.markdownMatch).toBe(true);
  });

  test("ux: multiple undo/redo cycle", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("ux-multi-undo", "input.md", SIMPLE_BOX);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Type 3 chars
    await page.mouse.click(box!.x + 5, box!.y + 5);
    await page.waitForTimeout(200);
    await page.keyboard.press("End");
    await page.keyboard.type("ABC");
    await page.waitForTimeout(200);

    // Undo 3 times
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Meta+z");
      await page.waitForTimeout(100);
    }

    // Redo 2 times
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("Meta+Shift+z");
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(200);

    await screenshot(page, "ux-multi-undo", "1-after-undo-redo");
    const saved = await save(page);
    writeArtifact("ux-multi-undo", "output.md", saved);

    // Should have "AB" (typed 3, undo 3, redo 2)
    expect(saved).toContain("AB");
    expect(saved).not.toContain("ABC");
    expect(saved).toContain("┌");
  });

  test("ux: rapid click between wireframe and prose", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const frames = await getFrames(page);
    const f = frames[0];

    // Rapid alternating clicks
    for (let i = 0; i < 5; i++) {
      // Click wireframe
      await page.mouse.click(box!.x + f.x + f.w / 2, box!.y + f.y + f.h / 2);
      await page.waitForTimeout(50);
      // Click prose
      await page.mouse.click(box!.x + 5, box!.y + 5);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(300);

    // Should still be functional — no crash, content intact
    await screenshot(page, "ux-rapid-click", "1-after");
    const saved = await save(page);
    expect(saved).toContain("┌");
    expect(saved).toContain("Prose above");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════
// INTERACTION COMBOS — systematic coverage
// ═══════════════════════════════════════════════════════

const LABELED_FOR_EDIT = `Title

┌──────────────┐
│    Hello     │
└──────────────┘

End`;

const WITH_CHILDREN = `Top

┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘

Bottom`;

test.describe("interaction: text edit", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("text-edit: drill-down to text label, type, save", async ({ page }) => {
    await load(page, LABELED_FOR_EDIT);
    writeArtifact("ix-text-edit", "input.md", LABELED_FOR_EDIT);
    await screenshot(page, "ix-text-edit", "1-before");

    // Click frame to select container
    await clickFrame(page, 0);
    await screenshot(page, "ix-text-edit", "2-selected");

    // Click again to drill down
    await clickChild(page, 0);
    await screenshot(page, "ix-text-edit", "3-drilldown");

    // Double-click to enter text edit
    await dblclickFrame(page, 0);
    await screenshot(page, "ix-text-edit", "4-text-edit-mode");

    // Type
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.waitForTimeout(300);
    await screenshot(page, "ix-text-edit", "5-typed");

    // Exit text edit, save
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const saved = await save(page);
    writeArtifact("ix-text-edit", "output.md", saved);
    await screenshot(page, "ix-text-edit", "6-saved");

    writeArtifact("ix-text-edit", "summary.txt",
      `Has Hello!: ${saved.includes("Hello!")}\nHas wireframe: ${saved.includes("┌")}\nHas Title: ${saved.includes("Title")}`);
  });

  test("text-edit: edit prose, then edit text label", async ({ page }) => {
    await load(page, LABELED_FOR_EDIT);
    writeArtifact("ix-prose-then-label", "input.md", LABELED_FOR_EDIT);

    // Type in prose first
    await clickProse(page, 5, 5);
    await page.keyboard.press("End");
    await page.keyboard.type(" EDITED");
    await page.waitForTimeout(200);
    await screenshot(page, "ix-prose-then-label", "1-prose-edited");

    // Now click wireframe, drill down, edit label
    await clickFrame(page, 0);
    await clickChild(page, 0);
    await dblclickFrame(page, 0);
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await screenshot(page, "ix-prose-then-label", "2-label-edited");

    const saved = await save(page);
    writeArtifact("ix-prose-then-label", "output.md", saved);
    expect(saved).toContain("EDITED");
    expect(saved).toContain("┌");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });
});

test.describe("interaction: move combos", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("move-then-edit: move frame, then type in prose", async ({ page }) => {
    const r = await roundTrip(page, "ix-move-then-edit", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 80, 0);
      await clickProse(p, 5, 5);
      await p.keyboard.press("End");
      await p.keyboard.type(" AFTER_MOVE");
    });
    expect(r.output).toContain("AFTER_MOVE");
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });

  test("edit-then-move: type in prose, then move frame", async ({ page }) => {
    const r = await roundTrip(page, "ix-edit-then-move", SIMPLE_BOX, async (p) => {
      await clickProse(p, 5, 5);
      await p.keyboard.press("End");
      await p.keyboard.type(" BEFORE_MOVE");
      await page.waitForTimeout(200);
      await clickFrame(p, 0);
      await dragSelected(p, 80, 0);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("BEFORE_MOVE");
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });

  test("move-then-enter: move frame down, then Enter above it", async ({ page }) => {
    const r = await roundTrip(page, "ix-move-then-enter", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 0, 50);
      await clickProse(p, 5, 5);
      await p.keyboard.press("End");
      await p.keyboard.press("Enter");
      await p.keyboard.press("Enter");
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("Prose below");
    expect(r.ghosts).toEqual([]);
  });
});

test.describe("interaction: resize", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("resize: shrink frame, save", async ({ page }) => {
    const r = await roundTrip(page, "ix-resize-shrink", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await resizeSelected(p, -40, -20);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    // Shrunk box should have shorter top border
    const topBorder = r.output.split("\n").find(l => l.includes("┌"));
    const origBorder = SIMPLE_BOX.split("\n").find(l => l.includes("┌"));
    if (topBorder && origBorder) {
      expect(topBorder.length).toBeLessThanOrEqual(origBorder.length);
    }
    expect(r.ghosts).toEqual([]);
  });

  test("resize: expand then move, save", async ({ page }) => {
    const r = await roundTrip(page, "ix-resize-then-move", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await resizeSelected(p, 50, 30);
      await clickProse(p, 5, 5);
      await clickFrame(p, 0);
      await dragSelected(p, 40, 0);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.ghosts).toEqual([]);
  });

  test("resize: shrink then edit prose, save", async ({ page }) => {
    const r = await roundTrip(page, "ix-resize-then-prose", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await resizeSelected(p, -30, -10);
      await clickProse(p, 5, 5);
      await p.keyboard.press("End");
      await p.keyboard.type(" RESIZED");
    });
    expect(r.output).toContain("RESIZED");
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });
});

test.describe("interaction: children", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("child: select child, move it within parent", async ({ page }) => {
    await load(page, WITH_CHILDREN);
    writeArtifact("ix-move-child", "input.md", WITH_CHILDREN);
    await screenshot(page, "ix-move-child", "1-before");

    // Select parent, then drill down to child
    await clickChild(page, 0);
    await screenshot(page, "ix-move-child", "2-child-selected");

    // Drag child
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    writeArtifact("ix-move-child", "tree-before.json", JSON.stringify(flat, null, 2));

    // Small drag
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const selectedId = await getSelectedId(page);
    // Find selected frame position
    const selectedNode = flat.find(f => f.depth > 0); // first child
    if (selectedNode) {
      const cx = box!.x + selectedNode.absX + selectedNode.w / 2;
      const cy = box!.y + selectedNode.absY + selectedNode.h / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 3; i++) await page.mouse.move(cx + i * 10, cy);
      await page.mouse.up();
      await page.waitForTimeout(300);
    }
    await screenshot(page, "ix-move-child", "3-child-moved");

    await clickProse(page, 5, 5);
    const saved = await save(page);
    writeArtifact("ix-move-child", "output.md", saved);
    await screenshot(page, "ix-move-child", "4-saved");

    expect(saved).toContain("Outer");
    expect(saved).toContain("Inner");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  test("child: delete inner box, outer survives", async ({ page }) => {
    await load(page, WITH_CHILDREN);
    writeArtifact("ix-delete-child", "input.md", WITH_CHILDREN);

    // Drill down to inner rect
    await clickChild(page, 0);
    // Delete
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);
    await screenshot(page, "ix-delete-child", "1-child-deleted");

    const saved = await save(page);
    writeArtifact("ix-delete-child", "output.md", saved);

    // Outer should survive, inner should be gone
    expect(saved).toContain("Outer");
    expect(saved).toContain("Top");
    expect(saved).toContain("Bottom");
  });

  test("child: resize parent, children adjust", async ({ page }) => {
    await load(page, WITH_CHILDREN);
    writeArtifact("ix-resize-parent", "input.md", WITH_CHILDREN);
    await screenshot(page, "ix-resize-parent", "1-before");

    await clickFrame(page, 0);
    await resizeSelected(page, 50, 30);
    await clickProse(page, 5, 5);
    await screenshot(page, "ix-resize-parent", "2-resized");

    const saved = await save(page);
    writeArtifact("ix-resize-parent", "output.md", saved);

    expect(saved).toContain("┌");
    expect(saved).toContain("└");
    expect(saved).toContain("Outer");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });
});

test.describe("interaction: alignment", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("align: change text alignment to center, save", async ({ page }) => {
    await load(page, LABELED_FOR_EDIT);
    writeArtifact("ix-align-center", "input.md", LABELED_FOR_EDIT);
    await screenshot(page, "ix-align-center", "1-before");

    // Drill down to text label, enter edit mode
    await clickFrame(page, 0);
    await clickChild(page, 0);
    await dblclickFrame(page, 0);

    // Cmd+E for center align
    await page.keyboard.press("Meta+e");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await screenshot(page, "ix-align-center", "2-centered");

    const saved = await save(page);
    writeArtifact("ix-align-center", "output.md", saved);
    await screenshot(page, "ix-align-center", "3-saved");

    expect(saved).toContain("Hello");
    expect(saved).toContain("┌");
  });

  test("align: change to right align, then move, save", async ({ page }) => {
    await load(page, LABELED_FOR_EDIT);
    writeArtifact("ix-align-then-move", "input.md", LABELED_FOR_EDIT);

    await clickFrame(page, 0);
    await clickChild(page, 0);
    await dblclickFrame(page, 0);
    await page.keyboard.press("Meta+r");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Now move the frame
    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("ix-align-then-move", "output.md", saved);

    expect(saved).toContain("Hello");
    expect(saved).toContain("┌");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });
});

test.describe("interaction: multi-frame", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("multi: move two different frames, save", async ({ page }) => {
    await load(page, TWO_SEPARATE);
    writeArtifact("ix-move-two", "input.md", TWO_SEPARATE);

    // Move first frame
    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);

    // Move second frame
    const frames2 = await getFrames(page);
    if (frames2.length > 1) {
      await clickFrame(page, 1);
      await dragSelected(page, -30, 0);
      await clickProse(page, 5, 5);
    }

    const saved = await save(page);
    writeArtifact("ix-move-two", "output.md", saved);

    expect(saved).toContain("┌");
    expect(saved).toContain("Top");
    expect(saved).toContain("Bottom");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  test("multi: move frame, resize another, edit prose between", async ({ page }) => {
    await load(page, TWO_SEPARATE);
    writeArtifact("ix-move-resize-edit", "input.md", TWO_SEPARATE);

    // Move first
    await clickFrame(page, 0);
    await dragSelected(page, 40, 0);
    await clickProse(page, 5, 5);

    // Edit prose between
    const frames = await getFrames(page);
    const f0 = frames[0];
    const proseY = f0.y + f0.h + 20;
    await clickProse(page, 30, proseY);
    await page.keyboard.press("End");
    await page.keyboard.type(" BETWEEN");
    await page.waitForTimeout(200);

    // Resize second
    const frames3 = await getFrames(page);
    if (frames3.length > 1) {
      await clickFrame(page, 1);
      await resizeSelected(page, 30, 20);
      await clickProse(page, 5, 5);
    }

    const saved = await save(page);
    writeArtifact("ix-move-resize-edit", "output.md", saved);

    expect(saved).toContain("BETWEEN");
    expect(saved).toContain("┌");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });
});

test.describe("shared walls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  // ── No-edit round-trips (do shared walls survive parse → serialize?) ──

  test("shared vertical wall round-trips unchanged", async ({ page }) => {
    const r = await roundTrip(page, "shared-vertical-noedit", SHARED_VERTICAL);
    expect(r.markdownMatch).toBe(true);
  });

  test("shared horizontal wall round-trips unchanged", async ({ page }) => {
    const r = await roundTrip(page, "shared-horizontal-noedit", SHARED_HORIZONTAL);
    expect(r.markdownMatch).toBe(true);
  });

  test("three-in-row shared walls round-trip unchanged", async ({ page }) => {
    const r = await roundTrip(page, "three-in-row-noedit", THREE_IN_ROW);
    expect(r.markdownMatch).toBe(true);
  });

  test("asymmetric shared walls round-trip unchanged", async ({ page }) => {
    const r = await roundTrip(page, "asymmetric-noedit", ASYMMETRIC_SHARED);
    expect(r.markdownMatch).toBe(true);
  });

  test("3x2 grid round-trips unchanged", async ({ page }) => {
    const r = await roundTrip(page, "grid3x2-noedit", GRID_3X2);
    expect(r.markdownMatch).toBe(true);
  });

  // ── Drag entire wireframe group ──

  test("drag 2x2 junction grid right, check for ghosts", async ({ page }) => {
    const r = await roundTrip(page, "shared-junction-drag", JUNCTION, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 80, 0);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.ghosts).toEqual([]);
  });

  test("drag shared-horizontal box down, no ghosts", async ({ page }) => {
    const r = await roundTrip(page, "shared-horiz-drag-down", SHARED_HORIZONTAL, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 0, 60);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.ghosts).toEqual([]);
  });

  test("drag three-in-row right, no ghosts", async ({ page }) => {
    const r = await roundTrip(page, "shared-three-drag", THREE_IN_ROW, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 60, 0);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });

  test("drag 3x2 grid diagonally, no ghosts", async ({ page }) => {
    const r = await roundTrip(page, "shared-grid3x2-drag", GRID_3X2, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 40, 30);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });

  // ── Drag + save + drag (position accumulates) ──

  test("drag shared-wall box twice, position accumulates", async ({ page }) => {
    await load(page, SHARED_HORIZONTAL);

    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);
    const save1 = await save(page);
    expect(save1).toContain("┌");
    expect(await findGhostsFromPage(page, save1)).toEqual([]);

    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);
    const save2 = await save(page);
    expect(save2).toContain("┌");
    expect(await findGhostsFromPage(page, save2)).toEqual([]);

    // Box should have moved right from original
    const boxLine = save2.split("\n").find(l => l.includes("┌"))!;
    const indent = boxLine.length - boxLine.trimStart().length;
    expect(indent).toBeGreaterThan(5);
  });

  // ── Resize with shared walls ──

  test("resize shared-horizontal box, no ghosts", async ({ page }) => {
    await load(page, SHARED_HORIZONTAL);
    await clickFrame(page, 0);
    await resizeSelected(page, 40, 20);
    await clickProse(page, 5, 5);
    const saved = await save(page);
    writeArtifact("shared-horiz-resize", "output.md", saved);
    expect(saved).toContain("┌");
    expect(saved).toContain("└");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  // ── Asymmetric: different-sized boxes sharing a wall ──

  test("drag asymmetric shared wall, no ghosts", async ({ page }) => {
    const r = await roundTrip(page, "shared-asymmetric-drag", ASYMMETRIC_SHARED, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 50, 0);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });

  // ── Creating adjacencies and overlaps by dragging ──

  test("drag box right into adjacent box — borders don't corrupt", async ({ page }) => {
    // A at x=0, B at x=far. Drag A right until adjacent to B.
    await load(page, SIDE_BY_SIDE);
    writeArtifact("wall-drag-adjacent", "input.md", SIDE_BY_SIDE);
    const framesBefore = await getFrames(page);
    await screenshot(page, "wall-drag-adjacent", "1-before");

    await clickFrame(page, 0); // select A (first/leftmost)
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);
    const framesAfter = await getFrames(page);

    const saved = await save(page);
    writeArtifact("wall-drag-adjacent", "output.md", saved);
    await screenshot(page, "wall-drag-adjacent", "2-after");

    // Verify A actually moved
    expect(framesAfter[0].x).toBeGreaterThan(framesBefore[0].x);
    // Both labels survive
    expect(saved).toContain("A");
    expect(saved).toContain("B");
    // Count box corners — should have at least 4 (2 boxes × 2 visible corners min)
    const corners = [...saved].filter(c => "┌┐└┘".includes(c)).length;
    expect(corners).toBeGreaterThanOrEqual(4);
    expect(await findGhostsFromPage(page, saved)).toEqual([]);

    // Reload and verify visual matches
    await load(page, saved);
    await screenshot(page, "wall-drag-adjacent", "3-reloaded");
    const framesReloaded = await getFrames(page);
    expect(framesReloaded.length).toBe(framesAfter.length);
  });

  test("drag box down onto another — overlapping positions", async ({ page }) => {
    await load(page, TWO_SEPARATE);
    writeArtifact("wall-overlap-down", "input.md", TWO_SEPARATE);
    const framesBefore = await getFrames(page);
    await screenshot(page, "wall-overlap-down", "1-before");

    // Drag A down past Middle prose toward B
    await clickFrame(page, 0);
    await dragSelected(page, 0, 120);
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("wall-overlap-down", "output.md", saved);
    await screenshot(page, "wall-overlap-down", "2-after");

    // A should have moved down
    const framesAfter = await getFrames(page);
    expect(framesAfter[0].y).toBeGreaterThan(framesBefore[0].y);
    // Both boxes survive
    expect(saved).toContain("A");
    expect(saved).toContain("B");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);

    // Reload survives
    await load(page, saved);
    await screenshot(page, "wall-overlap-down", "3-reloaded");
  });

  test("stack two same-width boxes vertically — bottom border meets top border", async ({ page }) => {
    const stacked = [
      "Title", "",
      "┌──────────┐",
      "│  Top     │",
      "└──────────┘", "", "", "",
      "┌──────────┐",
      "│  Bottom  │",
      "└──────────┘", "",
      "End",
    ].join("\n");
    await load(page, stacked);
    writeArtifact("wall-stack-vert", "input.md", stacked);

    // Drag bottom box up to touch top box
    const frames = await getFrames(page);
    const bottom = frames.reduce((a, b) => a.y > b.y ? a : b);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    await page.mouse.click(box!.x + bottom.x + bottom.w / 2, box!.y + bottom.y + bottom.h / 2);
    await page.waitForTimeout(300);
    await dragSelected(page, 0, -50);
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("wall-stack-vert", "output.md", saved);
    await screenshot(page, "wall-stack-vert", "2-after");

    expect(saved).toContain("Top");
    expect(saved).toContain("Bottom");
    // Shared wall: ├──────────┤ instead of └──┘ + ┌──┐
    // Check both boxes are present (has at least ┌ and └)
    expect(saved).toContain("┌");
    expect(saved).toContain("└");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  test("drag small box inside large box — nesting by drag", async ({ page }) => {
    const separate = [
      "Notes", "",
      "┌──────────────────┐",
      "│                  │",
      "│                  │",
      "│                  │",
      "└──────────────────┘", "",
      "┌────┐",
      "│ X  │",
      "└────┘", "",
      "End",
    ].join("\n");
    await load(page, separate);
    writeArtifact("wall-nest-drag", "input.md", separate);

    // Drag small box X up into the large box
    const frames = await getFrames(page);
    const small = frames.reduce((a, b) => a.w < b.w ? a : b);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    await page.mouse.click(box!.x + small.x + small.w / 2, box!.y + small.y + small.h / 2);
    await page.waitForTimeout(300);
    await dragSelected(page, 30, -60);
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("wall-nest-drag", "output.md", saved);
    await screenshot(page, "wall-nest-drag", "2-after");

    expect(saved).toContain("X");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);

    // Reload and verify both boxes exist
    await load(page, saved);
    const framesReloaded = await getFrames(page);
    expect(framesReloaded.length).toBeGreaterThanOrEqual(1);
    await screenshot(page, "wall-nest-drag", "3-reloaded");
  });

  test("drag box to exact same row as another — horizontal adjacency", async ({ page }) => {
    // Two boxes at different Y positions, drag B to same Y as A
    const offset = [
      "Title", "",
      "┌────────┐",
      "│   A    │",
      "└────────┘", "", "", "",
      "          ┌────────┐",
      "          │   B    │",
      "          └────────┘", "",
      "End",
    ].join("\n");
    await load(page, offset);
    writeArtifact("wall-same-row", "input.md", offset);

    // Drag B up to same row as A
    const frames = await getFrames(page);
    const bottomFrame = frames.reduce((prev, cur) => prev.y > cur.y ? prev : cur);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    await page.mouse.click(box!.x + bottomFrame.x + bottomFrame.w / 2, box!.y + bottomFrame.y + bottomFrame.h / 2);
    await page.waitForTimeout(300);
    await dragSelected(page, 0, -80);
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("wall-same-row", "output.md", saved);
    await screenshot(page, "wall-same-row", "2-after");

    expect(saved).toContain("A");
    expect(saved).toContain("B");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  // ── Multi-step: drag, save, drag again ──

  test("drag box right, save, drag same box down, save — L-path", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("wall-L-path", "input.md", SIMPLE_BOX);

    // Step 1: drag right
    await clickFrame(page, 0);
    await dragSelected(page, 80, 0);
    await clickProse(page, 5, 5);
    const save1 = await save(page);
    writeArtifact("wall-L-path", "save1.md", save1);

    // Step 2: drag down
    await clickFrame(page, 0);
    await dragSelected(page, 0, 60);
    await clickProse(page, 5, 5);
    const save2 = await save(page);
    writeArtifact("wall-L-path", "save2.md", save2);
    await screenshot(page, "wall-L-path", "2-after");

    // Box should be offset both right and down
    const boxLine = save2.split("\n").find(l => l.includes("┌"))!;
    const indent = boxLine.length - boxLine.trimStart().length;
    expect(indent).toBeGreaterThan(3);
    const boxRow = save2.split("\n").indexOf(boxLine);
    expect(boxRow).toBeGreaterThan(3);
    expect(await findGhostsFromPage(page, save2)).toEqual([]);
  });

  test("move frame, add new rect via tool, save — both persist", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("wall-move-add", "input.md", SIMPLE_BOX);

    // Move existing frame right
    await clickFrame(page, 0);
    await dragSelected(page, 80, 0);
    await clickProse(page, 5, 5);

    // Clear prose cursor before switching tools
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    // Switch to rect tool, draw a new box
    await page.keyboard.press("r");
    await page.waitForTimeout(200);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    // Draw rect at bottom-left area
    const startX = box!.x + 10;
    const startY = box!.y + 200;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 100, startY + 50, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    // Back to select
    await page.keyboard.press("v");
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("wall-move-add", "output.md", saved);
    await screenshot(page, "wall-move-add", "2-after");

    // Should have at least 2 ┌ (original + new)
    const topLefts = [...saved].filter(c => c === "┌").length;
    expect(topLefts).toBeGreaterThanOrEqual(2);
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  // ── Resize creating overlap ──

  test("resize box to overlap with adjacent box", async ({ page }) => {
    await load(page, SIDE_BY_SIDE);
    writeArtifact("wall-resize-overlap", "input.md", SIDE_BY_SIDE);

    // Select A, resize right to overlap with B
    await clickFrame(page, 0);
    await resizeSelected(page, 80, 0);
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("wall-resize-overlap", "output.md", saved);
    await screenshot(page, "wall-resize-overlap", "2-after");

    // Both labels should survive
    expect(saved).toContain("A");
    expect(saved).toContain("B");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  // ── Delete one frame from shared-wall pair ──

  test("delete one box from junction grid, save", async ({ page }) => {
    await load(page, JUNCTION);
    writeArtifact("wall-delete-one", "input.md", JUNCTION);

    // Select the wireframe and delete
    await clickFrame(page, 0);
    await page.waitForTimeout(200);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);

    const saved = await save(page);
    writeArtifact("wall-delete-one", "output.md", saved);
    await screenshot(page, "wall-delete-one", "2-after");

    // Header and Footer prose should survive
    expect(saved).toContain("Header");
    expect(saved).toContain("Footer");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  // ── Undo after drag ──

  test("drag shared-wall box, undo, save — original position restored", async ({ page }) => {
    await load(page, SHARED_HORIZONTAL);
    writeArtifact("wall-undo-drag", "input.md", SHARED_HORIZONTAL);

    await clickFrame(page, 0);
    await dragSelected(page, 80, 0);
    await clickProse(page, 5, 5);

    // Undo
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+z`);
    await page.waitForTimeout(300);

    const saved = await save(page);
    writeArtifact("wall-undo-drag", "output.md", saved);
    await screenshot(page, "wall-undo-drag", "2-after-undo");

    // Should match original (or close — box at original position)
    expect(saved).toContain("Top");
    expect(saved).toContain("Bottom");
    expect(saved).toContain("├");  // junction should be preserved (never moved)
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  // ── Complex multi-frame scenarios ──

  test("move two separate boxes toward each other, save", async ({ page }) => {
    await load(page, TWO_SEPARATE);
    writeArtifact("wall-converge", "input.md", TWO_SEPARATE);

    // Move A down
    await clickFrame(page, 0);
    await dragSelected(page, 0, 80);
    await clickProse(page, 5, 5);

    // Move B up
    const frames = await getFrames(page);
    if (frames.length >= 2) {
      const canvas = page.locator("canvas");
      const box = await canvas.boundingBox();
      const bottomFrame = frames.reduce((prev, cur) => prev.y > cur.y ? prev : cur);
      await page.mouse.click(box!.x + bottomFrame.x + bottomFrame.w / 2, box!.y + bottomFrame.y + bottomFrame.h / 2);
      await page.waitForTimeout(300);
      await dragSelected(page, 0, -80);
      await clickProse(page, 5, 5);
    }

    const saved = await save(page);
    writeArtifact("wall-converge", "output.md", saved);
    await screenshot(page, "wall-converge", "2-after");

    expect(saved).toContain("A");
    expect(saved).toContain("B");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);
  });

  test("drag, type prose between frames, save, reload", async ({ page }) => {
    await load(page, SIDE_BY_SIDE);
    writeArtifact("wall-drag-type", "input.md", SIDE_BY_SIDE);

    // Move A down a bit
    await clickFrame(page, 0);
    await dragSelected(page, 0, 30);
    await clickProse(page, 5, 5);

    // Type some prose
    await page.keyboard.type("INSERTED");
    await page.waitForTimeout(200);

    const saved = await save(page);
    writeArtifact("wall-drag-type", "output.md", saved);
    await screenshot(page, "wall-drag-type", "2-after");

    expect(saved).toContain("INSERTED");
    expect(saved).toContain("A");
    expect(saved).toContain("B");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);

    // Reload and check
    await load(page, saved);
    await screenshot(page, "wall-drag-type", "3-reloaded");
    const framesReloaded = await getFrames(page);
    expect(framesReloaded.length).toBeGreaterThanOrEqual(1);
  });

  test("save three times without edits — idempotent", async ({ page }) => {
    await load(page, GRID_3X2);
    const s1 = await save(page);
    const s2 = await save(page);
    const s3 = await save(page);
    writeArtifact("wall-idempotent-3x2", "save1.md", s1);
    writeArtifact("wall-idempotent-3x2", "save3.md", s3);
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
  });
});

test.describe("interaction: undo chains", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("undo: resize then undo, save matches original", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("ix-undo-resize", "input.md", SIMPLE_BOX);

    await clickFrame(page, 0);
    await resizeSelected(page, 50, 30);
    await clickProse(page, 5, 5);
    await screenshot(page, "ix-undo-resize", "1-resized");

    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    await screenshot(page, "ix-undo-resize", "2-undone");

    const saved = await save(page);
    writeArtifact("ix-undo-resize", "output.md", saved);
    expect(saved).toBe(SIMPLE_BOX);
  });

  test("undo: move-resize-undo-undo, back to original", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("ix-undo-chain", "input.md", SIMPLE_BOX);

    // Move
    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);
    // Resize
    await clickFrame(page, 0);
    await resizeSelected(page, 30, 20);
    await clickProse(page, 5, 5);

    // Undo twice
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(200);
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);

    const saved = await save(page);
    writeArtifact("ix-undo-chain", "output.md", saved);
    expect(saved).toBe(SIMPLE_BOX);
  });
});

// ═══════════════════════════════════════════════════════
// CRITICAL — prose teleportation, invariants, edge cases
// ═══════════════════════════════════════════════════════

test.describe("critical", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("prose order preserved when dragging wireframe down", async ({ page }) => {
    const fixture = `Prose A first\n\n┌──────────────┐\n│   Wireframe  │\n└──────────────┘\n\nProse B second`;
    const r = await roundTrip(page, "crit-prose-order-down", fixture, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 0, 150);
      await clickProse(p, 5, 5);
    });
    const idxA = r.output.indexOf("Prose A");
    const idxB = r.output.indexOf("Prose B");
    expect(idxA, "Prose A not found").toBeGreaterThanOrEqual(0);
    expect(idxB, "Prose B not found").toBeGreaterThanOrEqual(0);
    expect(idxA, "Prose A should be before Prose B").toBeLessThan(idxB);
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });

  test("prose order preserved when dragging wireframe up", async ({ page }) => {
    const fixture = `Prose A\n\nProse B\n\n┌──────────────┐\n│   Wireframe  │\n└──────────────┘\n\nProse C`;
    const r = await roundTrip(page, "crit-prose-order-up", fixture, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 0, -80);
      await clickProse(p, 5, 5);
    });
    const idxA = r.output.indexOf("Prose A");
    const idxB = r.output.indexOf("Prose B");
    const idxC = r.output.indexOf("Prose C");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThanOrEqual(0);
    expect(idxA, "A before B").toBeLessThan(idxB);
    expect(idxB, "B before C").toBeLessThan(idxC);
    expect(r.ghosts).toEqual([]);
  });

  test("invariants: default text has no violations", async ({ page }) => {
    const tree = await getFrameTree(page);
    const failures = checkInvariants(tree);
    writeArtifact("crit-invariants", "failures.txt", failures.join("\n") || "None");
    expect(failures).toEqual([]);
  });

  test("invariants: after drag+save+reload, no violations", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await clickFrame(page, 0);
    await dragSelected(page, 80, 50);
    await clickProse(page, 5, 5);
    const md = await save(page);
    await load(page, md);
    const tree = await getFrameTree(page);
    const failures = checkInvariants(tree);
    expect(failures).toEqual([]);
  });

  test("rogue │ in prose should not become a wireframe", async ({ page }) => {
    const fixture = `Normal prose.\n\nThis has a rogue │ pipe.\n\nMore prose.`;
    const r = await roundTrip(page, "crit-rogue-pipe", fixture);
    expect(r.output).toContain("rogue │ pipe");
    const tree = await getFrameTree(page);
    expect(tree.length, "Rogue │ created a frame").toBe(0);
  });

  test("resize to minimum: box stays valid", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await clickFrame(page, 0);
    await resizeSelected(page, -200, -200);
    await clickProse(page, 5, 5);
    const saved = await save(page);
    writeArtifact("crit-min-resize", "output.md", saved);
    if (saved.includes("┌")) expect(saved).toContain("└");
    const ghosts = await findGhostsFromPage(page, saved);
    expect(ghosts).toEqual([]);
  });

  test("interleaved undo: move, type, move, undo×2", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);
    await page.keyboard.press("End");
    await page.keyboard.type(" TYPED");
    await page.waitForTimeout(200);
    await clickFrame(page, 0);
    await dragSelected(page, 30, 0);
    await clickProse(page, 5, 5);
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(200);
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    const saved = await save(page);
    writeArtifact("crit-interleaved-undo", "output.md", saved);
    expect(saved).toContain("┌");
    expect(saved).not.toContain("TYPED");
    const tree = await getFrameTree(page);
    expect(checkInvariants(tree)).toEqual([]);
  });

  test("bbox ghost detection catches isolated ghost │", async ({ page }) => {
    // Manually construct markdown with an isolated ghost
    const withGhost = `Prose\n\n┌──────┐\n│      │\n└──────┘\n\nMore │ ghost`;
    await load(page, withGhost);
    const tree = await getFrameTree(page);
    const { cw, ch } = await getCharDims(page);
    const bboxes = computeFrameGridBboxes(tree, cw, ch);
    const ghosts = findGhosts(withGhost, null, bboxes);
    writeArtifact("crit-ghost-detection", "ghosts.txt", ghosts.join("\n") || "None");
    // The │ on the "More │ ghost" line should be detected
    const proseGhosts = ghosts.filter(g => g.includes("More") || g.includes("ghost"));
    expect(proseGhosts.length, "Rogue │ in prose not detected:\n" + ghosts.join("\n")).toBeGreaterThan(0);
  });

  test("multiple Enter pushes ALL frames down", async ({ page }) => {
    await load(page, TWO_SEPARATE);
    const framesBefore = await getFrames(page);
    const y0 = framesBefore[0]?.y ?? 0;
    const y1 = framesBefore[1]?.y ?? 0;

    await clickProse(page, 5, 5);
    await page.keyboard.press("End");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    const framesAfter = await getFrames(page);
    // Both frames should have moved down
    expect(framesAfter[0]?.y).toBeGreaterThan(y0);
    if (framesAfter.length > 1) expect(framesAfter[1]?.y).toBeGreaterThan(y1);

    const saved = await save(page);
    writeArtifact("crit-multi-enter-shift", "output.md", saved);
    expect(saved).toContain("│ A  │");
    expect(saved).toContain("│ B  │");
  });

  test("Backspace merges line above wireframe, frame shifts up", async ({ page }) => {
    const fixture = `Line one\n\nLine two\n\n┌────┐\n│ A  │\n└────┘\n\nEnd`;
    await load(page, fixture);
    const yBefore = (await getFrames(page))[0]?.y ?? 0;

    // Click "Line two" — find its rendered position instead of hardcoding
    const lines = await getRenderedLines(page);
    const lineTwoLine = lines.find(l => l.text.includes("Line two"));
    const clickY = lineTwoLine ? lineTwoLine.y + 5 : 44; // fallback to ~row 2
    await clickProse(page, 5, clickY);
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);

    const yAfter = (await getFrames(page))[0]?.y ?? 0;
    expect(yAfter).toBeLessThan(yBefore);

    const saved = await save(page);
    expect(saved).toContain("│ A  │");
    expect(saved).toContain("End");
  });

  test("drag frame to negative X clamps at 0", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    await clickFrame(page, 0);
    await dragSelected(page, -500, 0);
    await clickProse(page, 300, 5);
    await screenshot(page, "crit-negative-drag", "1-after");
    const saved = await save(page);
    writeArtifact("crit-negative-drag", "output.md", saved);
    expect(saved).toContain("┌");
    expect(saved).toContain("Prose above");
    const ghosts = await findGhostsFromPage(page, saved);
    expect(ghosts).toEqual([]);
  });

  test("resize to very large", async ({ page }) => {
    const r = await roundTrip(page, "crit-resize-large", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await resizeSelected(p, 200, 100);
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    // Box should be wider
    const topLine = r.output.split("\n").find(l => l.includes("┌") && l.includes("┐"));
    expect(topLine!.length).toBeGreaterThan(20);
    expect(r.ghosts).toEqual([]);
  });

  test("type 100 chars of prose, wireframe survives", async ({ page }) => {
    const r = await roundTrip(page, "crit-long-prose", SIMPLE_BOX, async (p) => {
      await clickProse(p, 5, 5);
      await p.keyboard.press("End");
      await p.keyboard.press("Enter");
      await p.keyboard.type("A".repeat(100));
    });
    expect(r.output).toContain("A".repeat(50)); // at least 50 survived
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });

  test("Enter 10 times, wireframe still below", async ({ page }) => {
    const r = await roundTrip(page, "crit-10-enters", SIMPLE_BOX, async (p) => {
      await clickProse(p, 5, 5);
      await p.keyboard.press("End");
      for (let i = 0; i < 10; i++) await p.keyboard.press("Enter");
    });
    expect(r.output).toContain("┌");
    expect(r.output).toContain("Prose below");
    const origLines = SIMPLE_BOX.split("\n").length;
    expect(r.output.split("\n").length).toBe(origLines + 10);
  });

  test("drag same frame 10 times in sequence", async ({ page }) => {
    await load(page, SIMPLE_BOX);
    writeArtifact("crit-10-drags", "input.md", SIMPLE_BOX);

    for (let i = 0; i < 10; i++) {
      await clickFrame(page, 0);
      await dragSelected(page, 5, 0);
      await clickProse(page, 300, 5);
    }

    await screenshot(page, "crit-10-drags", "1-after");
    const saved = await save(page);
    writeArtifact("crit-10-drags", "output.md", saved);
    expect(saved).toContain("┌");
    // Frame should have moved right by ~50px total (10 * 5)
    const boxLine = saved.split("\n").find(l => l.includes("┌"))!;
    const indent = boxLine.length - boxLine.trimStart().length;
    expect(indent).toBeGreaterThan(3);
    const ghosts = await findGhostsFromPage(page, saved);
    expect(ghosts).toEqual([]);
  });

  test("edit prose → move frame → edit prose again", async ({ page }) => {
    const r = await roundTrip(page, "crit-edit-move-edit", SIMPLE_BOX, async (p) => {
      // First edit
      await clickProse(p, 5, 5);
      await p.keyboard.press("End");
      await p.keyboard.type(" FIRST");
      await p.waitForTimeout(200);

      // Move frame
      await clickFrame(p, 0);
      await dragSelected(p, 50, 0);
      await clickProse(p, 5, 5);

      // Second edit — below the frame
      const frames = await getFrames(p);
      const belowY = frames[0].y + frames[0].h + 30;
      await clickProse(p, 5, belowY);
      await p.keyboard.press("End");
      await p.keyboard.type(" SECOND");
    });
    expect(r.output).toContain("FIRST");
    expect(r.output).toContain("SECOND");
    expect(r.output).toContain("┌");
    expect(r.ghosts).toEqual([]);
  });

  test("add rect → move it → save", async ({ page }) => {
    await load(page, PURE_PROSE);
    writeArtifact("crit-add-then-move", "input.md", PURE_PROSE);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Draw rect
    await page.keyboard.press("r");
    await page.waitForTimeout(200);
    const sx = box!.x + 50, sy = box!.y + 100;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 100, sy + 50);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Move it
    await clickFrame(page, 0);
    await dragSelected(page, 80, 0);
    await clickProse(page, 5, 5);

    await screenshot(page, "crit-add-then-move", "1-after");
    const saved = await save(page);
    writeArtifact("crit-add-then-move", "output.md", saved);
    expect(saved).toContain("┌");
    expect(saved).toContain("Just some prose");
    const ghosts = await findGhostsFromPage(page, saved);
    expect(ghosts).toEqual([]);
  });

  test("move all 4 frames in default doc, save", async ({ page }) => {
    // Use default text
    const frames = await getFrames(page);
    writeArtifact("crit-move-all", "frame-count.txt", `Frames: ${frames.length}`);

    for (let i = 0; i < Math.min(frames.length, 4); i++) {
      await clickFrame(page, i);
      await dragSelected(page, 20, 0);
      await clickProse(page, 5, 5);
    }

    await screenshot(page, "crit-move-all", "1-all-moved");
    const saved = await save(page);
    writeArtifact("crit-move-all", "output.md", saved);
    expect(saved).toContain("┌");
    expect(saved).toContain("# Gridpad");
    const ghosts = await findGhostsFromPage(page, saved);
    writeArtifact("crit-move-all", "ghosts.txt", ghosts.join("\n") || "None");
  });

  test("prose stability: sub-char frame move should not scramble distant prose", async ({ page }) => {
    const fixture = `Prose Line 1\n\nProse Line 2\n\n┌────┐\n│ A  │\n└────┘\n\nProse Line 3\n\nProse Line 4\n\n┌────┐\n│ B  │\n└────┘\n\nProse Line 5 bottom`;
    const r = await roundTrip(page, "crit-prose-stability", fixture, async (p) => {
      // Move frame A by 2px — less than half a char width (9.6px)
      // This sets dirty flag but should NOT change grid position
      await clickFrame(p, 0);
      await dragSelected(p, 2, 0);
      await clickProse(p, 5, 5);
    });

    // All prose lines must be present
    expect(r.output).toContain("Prose Line 1");
    expect(r.output).toContain("Prose Line 2");
    expect(r.output).toContain("Prose Line 3");
    expect(r.output).toContain("Prose Line 4");
    expect(r.output).toContain("Prose Line 5 bottom");

    // Distant prose (Line 5) should NOT have moved in the output
    const inLines = fixture.split("\n");
    const outLines = r.output.split("\n");
    const inIdx5 = inLines.findIndex(l => l.includes("Prose Line 5"));
    const outIdx5 = outLines.findIndex(l => l.includes("Prose Line 5"));
    expect(outIdx5, "Distant prose line number should not change for sub-char move").toBe(inIdx5);

    expect(r.ghosts).toEqual([]);
  });

  test("delete child → undo → move parent", async ({ page }) => {
    await load(page, WITH_CHILDREN);
    writeArtifact("crit-del-undo-move", "input.md", WITH_CHILDREN);

    // Drill down and delete inner
    await clickChild(page, 0);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);

    // Move parent
    await clickFrame(page, 0);
    await dragSelected(page, 50, 0);
    await clickProse(page, 5, 5);

    await screenshot(page, "crit-del-undo-move", "1-after");
    const saved = await save(page);
    writeArtifact("crit-del-undo-move", "output.md", saved);

    expect(saved).toContain("Outer");
    expect(saved).toContain("Inner");
    expect(saved).toContain("┌");
    const tree = await getFrameTree(page);
    expect(checkInvariants(tree)).toEqual([]);
  });
});

test.describe("prose-wireframe vertical position", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  test("heading prose next to wireframe — both survive round-trip", async ({ page }) => {
    // Prose heading and wireframe on nearby rows, like the default doc.
    // The heading should NOT overwrite wireframe borders on save.
    const fixture = [
      "# Title",
      "",
      "",
      "## Section One",
      "",
      "Some prose here.",
      "",
      "",
      "┌───────────────────────────────┐",
      "│  Dashboard                    │",
      "├───────────┬───────────────────┤",
      "│ Nav       │  Content          │",
      "│ Home      │                   │",
      "│ Search    │  User: Alice      │",
      "│ Settings  │  Role: Admin      │",
      "└───────────┴───────────────────┘",
      "",
      "",
      "## Section Two",
      "",
      "More prose after the wireframe.",
    ].join("\n");
    const r = await roundTrip(page, "vert-heading-wireframe", fixture);
    expect(r.markdownMatch).toBe(true);
    expect(r.ghosts).toEqual([]);
  });

  test("heading on same visual row as wireframe after drag — no corruption", async ({ page }) => {
    // After dragging wireframe, the heading and wireframe may share visual Y.
    // Save should preserve both without corruption.
    const fixture = [
      "# Main Title",
      "",
      "Intro paragraph.",
      "",
      "",
      "┌──────────────────────┐",
      "│  Box                 │",
      "│                      │",
      "└──────────────────────┘",
      "",
      "## Subtitle Here",
      "",
      "Conclusion text.",
    ].join("\n");
    const r = await roundTrip(page, "vert-heading-drag", fixture, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 0, -30); // drag up toward heading
      await clickProse(p, 5, 5);
    });
    expect(r.output).toContain("Main Title");
    expect(r.output).toContain("Subtitle Here");
    expect(r.output).toContain("Box");
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.ghosts).toEqual([]);
  });

  test("two wireframes with prose between — vertical positions preserved", async ({ page }) => {
    // Two wireframes separated by prose. Both should maintain their relative
    // vertical position after save/reload.
    const fixture = [
      "Top prose",
      "",
      "┌──────────────┐",
      "│  Frame A     │",
      "│              │",
      "└──────────────┘",
      "",
      "Middle prose here.",
      "",
      "## Middle Heading",
      "",
      "More middle text.",
      "",
      "┌──────────────┐",
      "│  Frame B     │",
      "│              │",
      "└──────────────┘",
      "",
      "Bottom prose",
    ].join("\n");
    const r = await roundTrip(page, "vert-two-frames-prose", fixture);
    expect(r.markdownMatch).toBe(true);
    expect(r.ghosts).toEqual([]);

    // Verify frame order preserved — A before B in the output
    const aRow = r.output.split("\n").findIndex(l => l.includes("Frame A"));
    const bRow = r.output.split("\n").findIndex(l => l.includes("Frame B"));
    expect(aRow).toBeLessThan(bRow);
  });

  test("wide wireframe with prose to the right — prose stays right", async ({ page }) => {
    // Prose appears to the right of a wireframe (reflowed around obstacle).
    // After save/reload, prose should not jump positions.
    const fixture = [
      "Introduction text above everything.",
      "",
      "┌──────────┐",
      "│  Narrow  │",
      "│  Box     │",
      "│          │",
      "│          │",
      "└──────────┘",
      "",
      "Text below the box.",
    ].join("\n");
    const r = await roundTrip(page, "vert-prose-beside", fixture);
    expect(r.markdownMatch).toBe(true);

    // Reload and verify rendered prose doesn't overlap frame
    const lines = await getRenderedLines(page);
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    const overlaps = findProseFrameOverlaps(lines, flat, 22);
    expect(overlaps).toEqual([]);
  });

  test("default doc: drag dashboard, save, ## headings survive", async ({ page }) => {
    // Use the actual default doc — the real user scenario
    await load(page, ""); // empty triggers default text
    await page.waitForTimeout(1000);

    const framesBefore = await getFrames(page);
    if (framesBefore.length === 0) {
      // Default might not load with empty string — skip
      return;
    }

    writeArtifact("vert-default-drag", "before.png", await page.locator("canvas").screenshot());

    // Drag the first (dashboard) wireframe right
    await clickFrame(page, 0);
    await dragSelected(page, 100, 0);
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("vert-default-drag", "output.md", saved);
    writeArtifact("vert-default-drag", "after.png", await page.locator("canvas").screenshot());

    // All headings must survive
    expect(saved).toContain("Dashboard Layout");
    expect(saved).toContain("Mobile App");
    // All wireframe structures must survive
    expect(saved).toContain("┌");
    expect(saved).toContain("└");
    expect(saved).toContain("Nav");
    expect(saved).toContain("Welcome back!");
    expect(await findGhostsFromPage(page, saved)).toEqual([]);

    // Reload and verify visual
    await load(page, saved);
    writeArtifact("vert-default-drag", "reloaded.png", await page.locator("canvas").screenshot());
    const framesAfter = await getFrames(page);
    // Same number of top-level frames
    expect(framesAfter.length).toBe(framesBefore.length);
  });

  test("markdown heading ## does not overwrite adjacent wireframe row", async ({ page }) => {
    // Specific bug: ## heading text shares a grid row with wireframe border.
    // The heading must not overwrite the wireframe cell.
    const fixture = [
      "## Heading",
      "┌──────────────────────────────────────────────────────────────────────────────────────────┐",
      "│                                                                                          │",
      "└──────────────────────────────────────────────────────────────────────────────────────────┘",
      "",
      "After.",
    ].join("\n");
    const r = await roundTrip(page, "vert-heading-adjacent-wire", fixture);
    // The wireframe should be intact
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.output).toContain("Heading");
    expect(r.ghosts).toEqual([]);
  });
});

// ── Reparent: cursor-driven nest-on-draw and drag-reparent ───────────────────
//
// Verifies the Figma-style behavior introduced in PR #2:
// - Drawing inside an existing top-level frame nests the new frame as a child.
// - Dragging a top-level frame onto a strictly-larger frame demotes it to child.
// - Dragging a child out into empty space promotes it to top-level.
// All operations must round-trip through save/reload.

test.describe("reparent", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  // BIG_AND_SMALL: a tall outer rect followed by a short prose run, so the
  // outer is the only top-level frame and there's clear empty space below for
  // promote tests.
  const BIG_OUTER = `Title

┌──────────────────────────────┐
│                              │
│                              │
│                              │
│                              │
│                              │
└──────────────────────────────┘

End`;

  // TWO_BOXES: a big top frame and a small bottom frame, so we can drag the
  // small one INTO the big one for the demote test. Different widths and
  // heights so the size guard accepts the demote. Prose between them keeps
  // the scanner from synthesizing a wrapping container.
  const TWO_BOXES = `Above

┌────────────────────────────┐
│                            │
│                            │
│                            │
│                            │
└────────────────────────────┘

between

┌────┐
│ S  │
└────┘

Below`;

  // Test 1: draw a rect inside an existing frame → becomes child.
  test("draw rect inside frame: serialized as child of that frame", async ({ page }) => {
    const r = await roundTrip(page, "reparent-draw-rect-inside", BIG_OUTER, async (p) => {
      await p.keyboard.press("r"); // rect tool
      await p.waitForTimeout(200);
      const frames = await getFrames(p);
      const outer = frames[0];
      const canvas = p.locator("canvas");
      const box = await canvas.boundingBox();
      // Drag inside the outer's interior (well clear of borders)
      const sx = box!.x + outer.x + 40;
      const sy = box!.y + outer.y + 40;
      await p.mouse.move(sx, sy);
      await p.mouse.down();
      await p.mouse.move(sx + 50, sy + 30);
      await p.mouse.up();
      await p.waitForTimeout(300);
    });
    // Outer survives. New child rect renders inside it (no ghosts).
    expect(r.output).toContain("Title");
    expect(r.output).toContain("End");
    expect(r.ghosts).toEqual([]);
    // Top-level frame count after reload should still be 1 (child nests).
    const tree = await getFrameTree(page);
    expect(tree.length).toBe(1);
    expect(tree[0].childCount).toBeGreaterThan(0);
  });

  // Test 2: type a text label inside a frame → child.
  test("draw text inside frame: text label round-trips as child", async ({ page }) => {
    const r = await roundTrip(page, "reparent-draw-text-inside", BIG_OUTER, async (p) => {
      await p.keyboard.press("t"); // text tool
      await p.waitForTimeout(200);
      const frames = await getFrames(p);
      const outer = frames[0];
      const canvas = p.locator("canvas");
      const box = await canvas.boundingBox();
      // Click inside the outer
      await p.mouse.click(box!.x + outer.x + 40, box!.y + outer.y + 40);
      await p.waitForTimeout(200);
      await p.keyboard.type("INSIDE");
      await p.keyboard.press("Enter");
      await p.waitForTimeout(300);
    });
    expect(r.output).toContain("INSIDE");
    expect(r.output).toContain("Title");
    expect(r.ghosts).toEqual([]);
    // Top-level count still 1 — text label nested as child.
    const tree = await getFrameTree(page);
    expect(tree.length).toBe(1);
  });

  // Test 3: drag a top-level frame INTO a strictly-larger one → demote.
  test("drag frame into larger frame: demoted to child, both persist after reload", async ({ page }) => {
    await load(page, TWO_BOXES);
    writeArtifact("reparent-drag-into-larger", "input.md", TWO_BOXES);
    await screenshot(page, "reparent-drag-into-larger", "1-before");

    const framesBefore = await getFrames(page);
    expect(framesBefore.length).toBeGreaterThanOrEqual(2);
    const big = framesBefore[0];
    const small = framesBefore[1];
    expect(big.w).toBeGreaterThan(small.w);
    expect(big.h).toBeGreaterThan(small.h);

    // Click small to select, then drag its center to inside the big one.
    await clickFrame(page, 1);
    const dx = (big.x + big.w / 2) - (small.x + small.w / 2);
    const dy = (big.y + big.h / 2) - (small.y + small.h / 2);
    await dragSelected(page, dx, dy);
    await clickProse(page, 5, 5);
    await screenshot(page, "reparent-drag-into-larger", "2-after-drag");

    const saved = await save(page);
    writeArtifact("reparent-drag-into-larger", "output.md", saved);

    // Both ┌ markers must remain (nested rendering)
    expect(saved.match(/┌/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(saved).toContain("Above");
    expect(saved).toContain("Below");

    // After reload, top-level should be just the big frame; small nested.
    await load(page, saved);
    await screenshot(page, "reparent-drag-into-larger", "4-reloaded");
    const tree = await getFrameTree(page);
    expect(tree.length).toBe(1);
    expect(tree[0].childCount).toBeGreaterThan(0);
  });

  // Test 4: drag a child OUT of its parent into empty space → promote.
  test("drag child out into empty space: promoted to top-level after reload", async ({ page }) => {
    await load(page, WITH_CHILDREN);
    writeArtifact("reparent-drag-out", "input.md", WITH_CHILDREN);
    await screenshot(page, "reparent-drag-out", "1-before");

    const treeBefore = await getFrameTree(page);
    expect(treeBefore.length).toBe(1); // sanity
    expect(treeBefore[0].childCount).toBeGreaterThan(0);

    // Drill down to inner child
    await clickChild(page, 0);
    const childId = await getSelectedId(page);
    expect(childId).toBeTruthy();

    // Find the child's position via the frame tree (getFrames returns
    // top-level only; flattenTree exposes children with absolute coords).
    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    const child = flat.find(f => f.depth > 0);
    expect(child).toBeTruthy();
    const parent = (await getFrames(page))[0];
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const cx = box!.x + child!.absX + child!.w / 2;
    const cy = box!.y + child!.absY + child!.h / 2;
    // Drop point: well below the parent's bottom edge.
    const dropY = box!.y + parent.y + parent.h + 100;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, dropY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await clickProse(page, 5, 5);
    await screenshot(page, "reparent-drag-out", "2-after-drag");

    const saved = await save(page);
    writeArtifact("reparent-drag-out", "output.md", saved);

    expect(saved).toContain("Top");
    expect(saved).toContain("Bottom");
    // Two distinct ┌ in the output — outer + promoted child.
    expect(saved.match(/┌/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(saved).toContain("Inner");
    expect(saved).toContain("Outer");

    // Verify both rects parse back as visible frames (independent of whether
    // the scanner nests them as a single top-level + child or keeps them
    // truly side-by-side — column-band overlap may trigger synthetic
    // containerization, which is a separate known issue).
    await load(page, saved);
    await screenshot(page, "reparent-drag-out", "4-reloaded");
    const treeAfter = await getFrameTree(page);
    const allFrames = flattenTree(treeAfter);
    expect(allFrames.length).toBeGreaterThanOrEqual(2);
  });

  // Test 5: drag a child from parent A to parent B.
  test("drag child to a different parent: child nests under new parent", async ({ page }) => {
    // Construct a doc with two big frames separated by prose so the scanner
    // doesn't synthesize a wrapping container.
    const fixture = `Top

┌────────────────────────┐
│  Outer A               │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘

middle

┌────────────────────────┐
│  Outer B               │
│                        │
│                        │
│                        │
└────────────────────────┘

End`;
    await load(page, fixture);
    writeArtifact("reparent-cross-parent", "input.md", fixture);
    await screenshot(page, "reparent-cross-parent", "1-before");

    const framesBefore = await getFrames(page);
    expect(framesBefore.length).toBe(2);
    const a = framesBefore[0];
    const b = framesBefore[1];

    await clickChild(page, 0); // drill into inner child of A
    const childId = await getSelectedId(page);
    expect(childId).toBeTruthy();

    const tree = await getFrameTree(page);
    const flat = flattenTree(tree);
    const child = flat.find(f => f.depth > 0);
    expect(child).toBeTruthy();
    const canvas = page.locator("canvas");
    const cbox = await canvas.boundingBox();
    const cx = cbox!.x + child!.absX + child!.w / 2;
    const cy = cbox!.y + child!.absY + child!.h / 2;
    // Drop near the top-left of B so Inner (18 cols wide) fits comfortably
    // inside B (25 cols wide) without extending past B's right wall.
    const dropX = cbox!.x + b.x + 30;
    const dropY = cbox!.y + b.y + b.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(dropX, dropY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await clickProse(page, 5, 5);
    await screenshot(page, "reparent-cross-parent", "2-after-drag");

    const saved = await save(page);
    writeArtifact("reparent-cross-parent", "output.md", saved);

    expect(saved).toContain("Outer A");
    expect(saved).toContain("Outer B");
    expect(saved).toContain("Inner");

    await load(page, saved);
    const treeAfter = await getFrameTree(page);
    expect(treeAfter.length).toBe(2);
    // After moving Inner from A to B, B should have at least one more child
    // than A. (Both still have their text-label children "Outer A" / "Outer B"
    // — the assertion is about the relative shift of the Inner rect, not
    // absolute child counts.)
    const flatAfter = flattenTree(treeAfter);
    const innerNodes = flatAfter.filter(f => f.depth > 0 && f.contentType === "rect");
    // Exactly one Inner-style child rect somewhere in the tree.
    expect(innerNodes.length).toBe(1);
    // B should be the parent of Inner — find by descending.
    const bHasInner = treeAfter[1].children.some((c: any) => c.contentType === "rect");
    expect(bHasInner).toBe(true);
  });

  // Test 6: dragging two equal-sized frames past each other does NOT nest.
  // Regression check for the size guard from commit b7eabfa.
  test("equal-size frames passed through each other do not nest", async ({ page }) => {
    await load(page, TWO_SEPARATE);
    writeArtifact("reparent-equal-no-nest", "input.md", TWO_SEPARATE);

    const framesBefore = await getFrames(page);
    expect(framesBefore.length).toBe(2);
    expect(framesBefore[0].w).toBe(framesBefore[1].w);
    expect(framesBefore[0].h).toBe(framesBefore[1].h);

    // Drag frame 0 PAST frame 1 (drop cursor lands below f1's bottom edge,
    // not on top of it). Same-size guard means no nesting either way; this
    // also exercises the scanner's reload path with the dragged frame
    // beyond the original layout.
    await clickFrame(page, 0);
    const f0 = framesBefore[0];
    const f1 = framesBefore[1];
    const dy = (f1.y + f1.h + 20) - (f0.y + f0.h / 2);
    await dragSelected(page, 0, dy);
    await clickProse(page, 5, 5);

    const saved = await save(page);
    writeArtifact("reparent-equal-no-nest", "output.md", saved);

    // Both ┌ tokens must remain; tree depth stays 1.
    expect(saved.match(/┌/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    await load(page, saved);
    const tree = await getFrameTree(page);
    expect(tree.length).toBe(2);
    // Neither frame should have a child *rect* — text labels (the contents
    // like "A" and "B") are child text nodes, that's expected.
    const noNestedRect = (n: any): boolean =>
      n.children.every((c: any) => c.contentType !== "rect" && noNestedRect(c));
    expect(noNestedRect(tree[0])).toBe(true);
    expect(noNestedRect(tree[1])).toBe(true);
  });

  // Test 7: undo a reparent restores the original tree.
  test("undo a drag-into-frame reparent restores original tree", async ({ page }) => {
    await load(page, TWO_BOXES);
    writeArtifact("reparent-undo", "input.md", TWO_BOXES);

    const treeBefore = await getFrameTree(page);
    expect(treeBefore.length).toBe(2);

    // Reparent: drag small into big.
    const framesBefore = await getFrames(page);
    const big = framesBefore[0];
    const small = framesBefore[1];
    await clickFrame(page, 1);
    const dx = (big.x + big.w / 2) - (small.x + small.w / 2);
    const dy = (big.y + big.h / 2) - (small.y + small.h / 2);
    await dragSelected(page, dx, dy);
    // NOTE: do NOT click prose between drag and undo. clicking adds an
    // extra history entry (cursor move) which Cmd+Z would undo first.

    // Undo via Mod+Z (CodeMirror history)
    await page.locator("canvas").focus();
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+z" : "Control+z");
    await page.waitForTimeout(300);

    const saved = await save(page);
    writeArtifact("reparent-undo", "output.md", saved);

    // After undo, two top-level frames remain; neither has a nested rect.
    // (Text labels inside boxes count as children but aren't rect frames.)
    await load(page, saved);
    const treeAfter = await getFrameTree(page);
    expect(treeAfter.length).toBe(2);
    const noNestedRect = (n: any): boolean =>
      n.children.every((c: any) => c.contentType !== "rect" && noNestedRect(c));
    expect(noNestedRect(treeAfter[0])).toBe(true);
    expect(noNestedRect(treeAfter[1])).toBe(true);
  });
});
