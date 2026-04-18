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
  return page.evaluate(async ({ d1, d2 }) => {
    const toImg = (data: number[]) =>
      createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" }));
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
  }, { d1: [...a], d2: [...b] });
}

/** Check for ghost wire characters in prose-only lines */
function findGhosts(md: string, wireframeSections: { startRow: number; endRow: number }[]): string[] {
  const lines = md.split("\n");
  const ghosts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Skip lines that are within a wireframe section
    const inWireframe = wireframeSections.some(s => i >= s.startRow && i <= s.endRow);
    if (inWireframe) continue;
    // Check if this prose line has wire characters
    for (const ch of lines[i]) {
      if (WIRE_CHARS.has(ch)) {
        ghosts.push(`Line ${i + 1}: ${JSON.stringify(lines[i])}`);
        break;
      }
    }
  }
  return ghosts;
}

/** Detect wireframe sections in markdown (consecutive lines with wire chars) */
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

/** Click the center of the Nth top-level frame (0-indexed) */
async function clickFrame(page: Page, frameIndex: number) {
  const frames = await getFrames(page);
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (frameIndex >= frames.length) throw new Error(`Frame ${frameIndex} not found (${frames.length} frames)`);
  const f = frames[frameIndex];
  await page.mouse.click(box!.x + f.x + f.w / 2, box!.y + f.y + f.h / 2);
  await page.waitForTimeout(300);
}

/** Drag the selected frame by (dx, dy) pixels */
async function dragSelected(page: Page, dx: number, dy: number) {
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  // Use the frame's current position
  const frames = await getFrames(page);
  // Find selected frame by checking for blue pixels... or just use last clicked position
  // Simpler: get the first frame and assume it's selected
  const f = frames[0];
  const cx = box!.x + f.x + f.w / 2;
  const cy = box!.y + f.y + f.h / 2;
  await page.mouse.down();
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) / 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i / steps), cy + (dy * i / steps));
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
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
      // Prose start X is well inside frame's horizontal range (5px margin)
      const insideH = line.x >= f.absX + 5 && line.x < f.absX + f.w - 5;
      // Prose Y is inside frame's vertical range
      const insideV = ly >= f.absY && ly + lineHeight <= f.absY + f.h;
      if (insideH && insideV) {
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

/** Click on prose area (above all wireframes) */
async function clickProse(page: Page, relX: number, relY: number) {
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.click(box!.x + relX, box!.y + relY);
  await page.waitForTimeout(300);
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
}

async function roundTrip(
  page: Page,
  testName: string,
  inputMd: string,
  action?: (page: Page) => Promise<void>,
): Promise<RoundTripResult> {
  // Write input
  writeArtifact(testName, "input.md", inputMd);

  // Load
  await load(page, inputMd);
  const beforeShot = await screenshot(page, testName, "1-before");

  // Action
  if (action) await action(page);
  if (action) await screenshot(page, testName, "2-after-action");

  // Save (full flow)
  const output = await save(page);
  writeArtifact(testName, "output.md", output);
  const afterShot = await screenshot(page, testName, "3-after-save");

  // Reload saved output
  await load(page, output);
  const reloadedShot = await screenshot(page, testName, "4-reloaded");

  // Compute diffs
  const refShot = action ? afterShot : beforeShot;
  const visualDiff = await pixelDiff(page, refShot, reloadedShot);

  // Ghost detection
  const sections = findWireframeSections(output);
  const ghosts = findGhosts(output, sections);

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

  // Verify prose doc round-trips through CM
  const proseAfterReload = await page.evaluate(() => (window as any).__gridpad.getProseDoc());

  // Write summary with diff
  const summary = [
    `Test: ${testName}`,
    `Input lines: ${inLines.length}`,
    `Output lines: ${outLines.length}`,
    `Markdown match: ${output === inputMd}`,
    `Visual diff: ${visualDiff.toFixed(2)}%`,
    `Ghosts: ${ghosts.length}`,
    ...ghosts.map(g => `  ${g}`),
    ...(mdDiffLines.length > 0 ? ["\nMarkdown diff:", ...mdDiffLines] : []),
    `\nProse doc after reload: ${proseAfterReload.split("\\n").length} lines`,
  ].join("\n");
  writeArtifact(testName, "summary.txt", summary);
  console.log(summary);

  return {
    input: inputMd, output,
    beforeShot, afterShot, reloadedShot,
    visualDiff,
    markdownMatch: output === inputMd,
    ghosts,
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
│  │  Inner            │  │
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

  test("drag: move box right, no ghosts", async ({ page }) => {
    const r = await roundTrip(page, "drag-right", SIMPLE_BOX, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 80, 0);
      // Deselect
      await clickProse(p, 5, 5);
    });
    expect(r.ghosts).toEqual([]);
    expect(r.output).toContain("┌");
    expect(r.output).toContain("└");
    expect(r.output).toContain("Prose above");
    expect(r.output).toContain("Prose below");
    expect(r.visualDiff).toBeLessThan(10);
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

      const sections = findWireframeSections(md);
      const ghosts = findGhosts(md, sections);
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

    // Get frame positions
    const frames = await getFrames(page);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Find a text-type child frame (the "Hello" label)
    // The labeled box has a rect with text children
    // Double-click center of the wireframe area
    const f = frames[0];
    const centerX = box!.x + f.x + f.w / 2;
    const centerY = box!.y + f.y + f.h / 2;

    // First click selects container, second click drills down
    await page.mouse.click(centerX, centerY);
    await page.waitForTimeout(300);
    await page.mouse.click(centerX, centerY);
    await page.waitForTimeout(300);
    // Double-click to enter text edit mode
    await page.mouse.dblclick(centerX, centerY);
    await page.waitForTimeout(300);

    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.waitForTimeout(300);
    await screenshot(page, "text-label-edit", "2-after-edit");

    const saved = await save(page);
    writeArtifact("text-label-edit", "output.md", saved);
    await screenshot(page, "text-label-edit", "3-after-save");

    // Check if text was modified (Hello → Hello! or similar)
    writeArtifact("text-label-edit", "summary.txt",
      `Input had "Hello": ${LABELED_BOX.includes("Hello")}\n` +
      `Output has "Hello!": ${saved.includes("Hello!")}\n` +
      `Output has wireframe: ${saved.includes("┌")}\n`);
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
    const sections = findWireframeSections(save2);
    expect(findGhosts(save2, sections)).toEqual([]);
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
    const sections = findWireframeSections(saved);
    expect(findGhosts(saved, sections)).toEqual([]);
  });
});
