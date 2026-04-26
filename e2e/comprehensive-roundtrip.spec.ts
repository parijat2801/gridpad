/**
 * Comprehensive round-trip tests.
 *
 * Every test: load md → action → serialize → reload → compare markdown + screenshots.
 * Screenshots saved to e2e/screenshots/comprehensive/ for visual review.
 */
import { test, expect, type Page } from "@playwright/test";

const SCREENSHOT_DIR = "e2e/screenshots/comprehensive";

async function loadMd(page: Page, md: string): Promise<void> {
  await page.evaluate((t) => (window as any).__gridpad.loadDocument(t), md);
  await page.waitForTimeout(600);
}

async function serialize(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__gridpad.serializeDocument());
}

async function shot(page: Page, name: string): Promise<Buffer> {
  const buf = await page.locator("canvas").screenshot();
  await page.locator("canvas").screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
  return buf;
}

async function diffPct(page: Page, b1: Buffer, b2: Buffer): Promise<number> {
  return page.evaluate(async ({ a, b }) => {
    const toImg = (d: number[]) => createImageBitmap(new Blob([new Uint8Array(d)], { type: "image/png" }));
    const [i1, i2] = await Promise.all([toImg(a), toImg(b)]);
    const c = document.createElement("canvas");
    c.width = i1.width; c.height = i1.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(i1, 0, 0);
    const d1 = ctx.getImageData(0, 0, c.width, c.height).data;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(i2, 0, 0);
    const d2 = ctx.getImageData(0, 0, c.width, c.height).data;
    let diff = 0;
    for (let i = 0; i < d1.length; i += 4) {
      if (Math.abs(d1[i] - d2[i]) + Math.abs(d1[i+1] - d2[i+1]) + Math.abs(d1[i+2] - d2[i+2]) > 30) diff++;
    }
    return (diff / (d1.length / 4)) * 100;
  }, { a: [...b1], b: [...b2] });
}

// ── Fixtures ───────────────────────────────────────────────

const SINGLE_BOX = `Prose above

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

const NESTED = `Top

┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner           │  │
│  └──────────────────┘  │
└────────────────────────┘

Bottom`;

const TWO_BOXES = `Header

┌────┐
│ A  │
└────┘

Middle

┌────┐
│ B  │
└────┘

Footer`;

const JUNCTION = `Title

┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│  Bottom L │  Bottom R │
└───────────┴───────────┘

End`;

const SIDE_BY_SIDE = `Text

┌──────┐  ┌──────┐
│  A   │  │  B   │
└──────┘  └──────┘

More text`;

const EMPTY_DOC = ``;

const PROSE_WITH_DASHES = `# My Table

| Name | Age |
|------|-----|
| Alice| 30  |

---

Normal prose after a thematic break.`;

const UNICODE_PROSE = `Hello 🎉 World

┌──────┐
│ Box  │
└──────┘

Emoji: 👨‍👩‍👧‍👦 and accents: café naïve`;

// ── Tests ──────────────────────────────────────────────────

test.describe("comprehensive round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
  });

  // ── RESIZE ───────────────────────────────────────────────

  test("resize: drag bottom-right handle to expand box", async ({ page }) => {
    await loadMd(page, SINGLE_BOX);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click wireframe to select
    await page.mouse.click(box!.x + 80, box!.y + 60);
    await page.waitForTimeout(300);

    // Find bottom-right handle (~bottom-right corner of the frame)
    // Frame is at approx y=36 (row 2 * 18.4), height ~3 rows = 55px
    // Bottom-right handle at approx (144, 91)
    const handleX = box!.x + 144;
    const handleY = box!.y + 91;

    // Drag handle down-right
    await page.mouse.move(handleX, handleY);
    await page.waitForTimeout(100);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(handleX + i * 10, handleY + i * 10);
    await page.mouse.up();
    await page.waitForTimeout(500);

    const s1 = await shot(page, "resize-after");
    const saved = await serialize(page);

    // Wireframe chars still present
    expect(saved).toContain("┌");
    expect(saved).toContain("└");
    expect(saved).toContain("Prose above");
    expect(saved).toContain("Prose below");

    // Reload and compare
    await loadMd(page, saved);
    const s2 = await shot(page, "resize-reloaded");
    const d = await diffPct(page, s1, s2);
    console.log(`resize pixel diff: ${d.toFixed(2)}%`);
    expect(d).toBeLessThan(10);
  });

  // ── UNDO/REDO ────────────────────────────────────────────

  test("undo drag: frame returns to original position", async ({ page }) => {
    await loadMd(page, SINGLE_BOX);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const s0 = await shot(page, "undo-before");

    // Select and drag
    await page.mouse.click(box!.x + 80, box!.y + 60);
    await page.waitForTimeout(200);
    const wx = box!.x + 80, wy = box!.y + 60;
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(wx + i * 10, wy);
    await page.mouse.up();
    await page.waitForTimeout(300);
    await shot(page, "undo-after-drag");

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);

    // Click empty space to deselect
    await page.mouse.click(box!.x + 5, box!.y + 300);
    await page.waitForTimeout(200);

    const s1 = await shot(page, "undo-after-undo");
    const saved = await serialize(page);

    // Should match original
    expect(saved).toBe(SINGLE_BOX);

    // Visual should match original
    const d = await diffPct(page, s0, s1);
    console.log(`undo pixel diff: ${d.toFixed(2)}%`);
    expect(d).toBeLessThan(5);
  });

  test("undo delete: frame reappears", async ({ page }) => {
    await loadMd(page, SINGLE_BOX);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Select wireframe
    await page.mouse.click(box!.x + 80, box!.y + 60);
    await page.waitForTimeout(300);

    // Delete
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);
    await shot(page, "undo-delete-after-delete");

    const afterDelete = await serialize(page);
    expect(afterDelete).not.toContain("┌");

    // Undo
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(300);
    await shot(page, "undo-delete-after-undo");

    const afterUndo = await serialize(page);
    expect(afterUndo).toContain("┌");
    expect(afterUndo).toContain("└");
  });

  // ── DELETE FRAME ─────────────────────────────────────────

  test("delete frame: wireframe gone, prose preserved", async ({ page }) => {
    await loadMd(page, SINGLE_BOX);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    await page.mouse.click(box!.x + 80, box!.y + 60);
    await page.waitForTimeout(300);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);

    await shot(page, "delete-frame");
    const saved = await serialize(page);

    expect(saved).not.toContain("┌");
    expect(saved).not.toContain("└");
    expect(saved).toContain("Prose above");
    expect(saved).toContain("Prose below");
  });

  // ── ADD NEW FRAME ────────────────────────────────────────

  test("add new rect: draw tool creates box that serializes", async ({ page }) => {
    await loadMd(page, "Just prose here.\n\nMore prose.");
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Press R for rect tool
    await page.keyboard.press("r");
    await page.waitForTimeout(200);

    // Draw a rect
    const startX = box!.x + 50, startY = box!.y + 80;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 100, startY + 60);
    await page.mouse.up();
    await page.waitForTimeout(500);

    await shot(page, "add-rect-drawn");
    const saved = await serialize(page);

    // Should now contain box chars
    expect(saved).toContain("┌");
    expect(saved).toContain("└");
    expect(saved).toContain("Just prose here.");
  });

  // ── NESTED BOX INTERACTIONS ──────────────────────────────

  test("nested: select outer, then drill down to inner", async ({ page }) => {
    await loadMd(page, NESTED);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // First click selects outer container
    await page.mouse.click(box!.x + 100, box!.y + 80);
    await page.waitForTimeout(300);
    await shot(page, "nested-select-outer");

    // Second click on inner box drills down
    await page.mouse.click(box!.x + 100, box!.y + 80);
    await page.waitForTimeout(300);
    await shot(page, "nested-select-inner");

    // Serialize — both boxes should survive
    const saved = await serialize(page);
    expect(saved).toContain("Outer");
    expect(saved).toContain("Inner");
    expect(saved).toContain("Top");
    expect(saved).toContain("Bottom");
  });

  // ── JUNCTION CHARS ───────────────────────────────────────

  test("junction chars survive no-edit round-trip", async ({ page }) => {
    await loadMd(page, JUNCTION);
    const s1 = await shot(page, "junction-before");

    const saved = await serialize(page);
    expect(saved).toBe(JUNCTION);

    // Verify specific junction chars
    expect(saved).toContain("├");
    expect(saved).toContain("┬");
    expect(saved).toContain("┤");
    expect(saved).toContain("┴");
    expect(saved).toContain("┼");

    await loadMd(page, saved);
    const s2 = await shot(page, "junction-after");
    const d = await diffPct(page, s1, s2);
    console.log(`junction pixel diff: ${d.toFixed(2)}%`);
    expect(d).toBeLessThan(1);
  });

  // ── EMPTY DOCUMENT ───────────────────────────────────────

  test("empty doc: load, click around, serialize stays empty", async ({ page }) => {
    await loadMd(page, EMPTY_DOC);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click a few places
    await page.mouse.click(box!.x + 100, box!.y + 100);
    await page.waitForTimeout(200);
    await page.mouse.click(box!.x + 200, box!.y + 200);
    await page.waitForTimeout(200);

    await shot(page, "empty-doc");
    const saved = await serialize(page);
    expect(saved).toBe("");
  });

  // ── PROSE WITH DASHES (false positive) ───────────────────

  test("markdown table dashes are NOT wireframes", async ({ page }) => {
    await loadMd(page, PROSE_WITH_DASHES);
    await shot(page, "prose-dashes-before");

    const saved = await serialize(page);

    // Table pipes and dashes should be prose, not wireframes
    expect(saved).toContain("|------|-----|");
    expect(saved).toContain("| Alice| 30");
    expect(saved).toContain("---");
    expect(saved).toContain("Normal prose");

    await loadMd(page, saved);
    await shot(page, "prose-dashes-after");
  });

  // ── UNICODE / EMOJI ──────────────────────────────────────

  test("unicode emoji in prose survives round-trip", async ({ page }) => {
    await loadMd(page, UNICODE_PROSE);
    const s1 = await shot(page, "unicode-before");

    const saved = await serialize(page);
    expect(saved).toContain("🎉");
    expect(saved).toContain("👨‍👩‍👧‍👦");
    expect(saved).toContain("café");
    expect(saved).toContain("naïve");
    expect(saved).toContain("┌──────┐");

    await loadMd(page, saved);
    const s2 = await shot(page, "unicode-after");
    const d = await diffPct(page, s1, s2);
    console.log(`unicode pixel diff: ${d.toFixed(2)}%`);
    expect(d).toBeLessThan(1);
  });

  // ── MULTIPLE WIREFRAMES ──────────────────────────────────

  test("two wireframes: edit prose between them, both survive", async ({ page }) => {
    await loadMd(page, TWO_BOXES);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Click on "Middle" text between the boxes
    await page.mouse.click(box!.x + 50, box!.y + 130);
    await page.waitForTimeout(300);
    await page.keyboard.press("End");
    await page.keyboard.type(" EDITED");
    await page.waitForTimeout(300);

    const s1 = await shot(page, "two-boxes-edited");
    const saved = await serialize(page);

    expect(saved).toContain("EDITED");
    expect(saved).toContain("│ A  │");
    expect(saved).toContain("│ B  │");
    expect(saved).toContain("Header");
    expect(saved).toContain("Footer");

    await loadMd(page, saved);
    const s2 = await shot(page, "two-boxes-reloaded");
    const d = await diffPct(page, s1, s2);
    console.log(`two-boxes pixel diff: ${d.toFixed(2)}%`);
    expect(d).toBeLessThan(5);
  });

  // ── SIDE BY SIDE ─────────────────────────────────────────

  test("side-by-side boxes: no-edit round-trip", async ({ page }) => {
    await loadMd(page, SIDE_BY_SIDE);
    const s1 = await shot(page, "side-by-side-before");

    const saved = await serialize(page);
    expect(saved).toBe(SIDE_BY_SIDE);

    await loadMd(page, saved);
    const s2 = await shot(page, "side-by-side-after");
    const d = await diffPct(page, s1, s2);
    console.log(`side-by-side pixel diff: ${d.toFixed(2)}%`);
    expect(d).toBeLessThan(1);
  });

  // ── SAVE MULTIPLE CYCLES ─────────────────────────────────

  test("3 save cycles with edits: each reload matches", async ({ page }) => {
    let md = SINGLE_BOX;

    for (let cycle = 1; cycle <= 3; cycle++) {
      await loadMd(page, md);
      const canvas = page.locator("canvas");
      const box = await canvas.boundingBox();

      // Type something in prose
      await page.mouse.click(box!.x + 5, box!.y + 5);
      await page.waitForTimeout(200);
      await page.keyboard.press("End");
      await page.keyboard.type(` c${cycle}`);
      await page.waitForTimeout(200);

      const edited = await shot(page, `cycle-${cycle}-edited`);
      md = await serialize(page);

      // Reload and verify visual match
      await loadMd(page, md);
      const reloaded = await shot(page, `cycle-${cycle}-reloaded`);
      const d = await diffPct(page, edited, reloaded);
      console.log(`cycle ${cycle} pixel diff: ${d.toFixed(2)}%`);
      expect(d).toBeLessThan(5);

      // Wireframe must survive each cycle
      expect(md).toContain("┌");
      expect(md).toContain("└");
    }

    // Final markdown should have all 3 edits
    expect(md).toContain("c1");
    expect(md).toContain("c2");
    expect(md).toContain("c3");
  });

  // ── TEXT LABEL EDITING ───────────────────────────────────

  test("edit text label inside wireframe", async ({ page }) => {
    await loadMd(page, LABELED_BOX);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();

    // Double-click on "Hello" text inside the wireframe
    // The wireframe is at ~y=36, "Hello" is at ~y=54 (row 3)
    await page.mouse.dblclick(box!.x + 80, box!.y + 54);
    await page.waitForTimeout(300);

    // Type to replace/append
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.waitForTimeout(300);

    await shot(page, "label-edit-after");
    const saved = await serialize(page);

    // "Hello!" should be in the output
    expect(saved).toContain("Hello!");
    expect(saved).toContain("┌");
    expect(saved).toContain("└");
    expect(saved).toContain("Title");
    expect(saved).toContain("End");
  });
});
