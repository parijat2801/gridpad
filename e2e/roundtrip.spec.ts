/**
 * Round-trip fidelity tests.
 *
 * Real test: load markdown → screenshot → serialize → reload serialized → screenshot → compare.
 * Tests both the data (markdown diff) and the visual (pixel comparison).
 */
import { test, expect, type Page } from "@playwright/test";

/** Load a markdown string into Gridpad, wait for render */
async function loadMarkdown(page: Page, md: string): Promise<void> {
  await page.evaluate((text) => {
    (window as any).__gridpad.loadDocument(text);
  }, md);
  await page.waitForTimeout(500);
}

/** Serialize the current Gridpad state back to markdown */
async function serializeMarkdown(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__gridpad.serializeDocument());
}

/** Take a canvas screenshot (just the canvas element, not full page) */
async function canvasScreenshot(page: Page): Promise<Buffer> {
  const canvas = page.locator("canvas");
  return canvas.screenshot();
}

/** Count pixels that differ between two same-size PNG buffers */
async function pixelDiff(page: Page, buf1: Buffer, buf2: Buffer): Promise<{ total: number; diffCount: number; diffPercent: number }> {
  // Use canvas to compare in-browser for simplicity
  return page.evaluate(async ({ b1, b2 }) => {
    const toImg = (data: number[]): Promise<ImageBitmap> => {
      const arr = new Uint8Array(data);
      const blob = new Blob([arr], { type: "image/png" });
      return createImageBitmap(blob);
    };
    const img1 = await toImg(b1);
    const img2 = await toImg(b2);
    const c = document.createElement("canvas");
    c.width = img1.width; c.height = img1.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img1, 0, 0);
    const d1 = ctx.getImageData(0, 0, c.width, c.height).data;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img2, 0, 0);
    const d2 = ctx.getImageData(0, 0, c.width, c.height).data;
    const total = d1.length / 4;
    let diffCount = 0;
    for (let i = 0; i < d1.length; i += 4) {
      const dr = Math.abs(d1[i] - d2[i]);
      const dg = Math.abs(d1[i + 1] - d2[i + 1]);
      const db = Math.abs(d1[i + 2] - d2[i + 2]);
      if (dr + dg + db > 30) diffCount++; // threshold for noise
    }
    return { total, diffCount, diffPercent: (diffCount / total) * 100 };
  }, { b1: [...buf1], b2: [...buf2] });
}

/** Show line-by-line diff between two strings */
function textDiff(a: string, b: string): string[] {
  const al = a.split("\n"), bl = b.split("\n");
  const diffs: string[] = [];
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    if (al[i] !== bl[i]) {
      diffs.push(`Line ${i + 1}:`);
      diffs.push(`  - ${JSON.stringify(al[i] ?? "<missing>")}`);
      diffs.push(`  + ${JSON.stringify(bl[i] ?? "<missing>")}`);
    }
  }
  return diffs;
}

// ── Test fixtures ──────────────────────────────────────────

const SIMPLE_BOX = `Prose above

┌──────────────┐
│              │
└──────────────┘

Prose below`;

const BOX_WITH_LABEL = `Title

┌──────────────┐
│    Hello     │
└──────────────┘

End`;

const JUNCTION_CHARS = `Header

┌───────────┬───────────┐
│  Left     │  Right    │
├───────────┼───────────┤
│  Bottom L │  Bottom R │
└───────────┴───────────┘

Footer`;

const NESTED_BOXES = `Prose

┌────────────────────────┐
│  Outer                 │
│  ┌──────────────────┐  │
│  │  Inner            │  │
│  └──────────────────┘  │
└────────────────────────┘

End`;

const SIDE_BY_SIDE = `Prose

┌──────┐  ┌──────┐
│  A   │  │  B   │
└──────┘  └──────┘

End`;

const MULTI_WIREFRAME = `Top prose

┌────┐
│ A  │
└────┘

Middle prose

┌────┐
│ B  │
└────┘

Bottom prose`;

const PURE_PROSE = `Just some prose.

Another paragraph.

A third one.`;

const FORM_LAYOUT = `Form

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

const fixtures = [
  { name: "simple box", md: SIMPLE_BOX },
  { name: "box with label", md: BOX_WITH_LABEL },
  { name: "junction chars ├┬┤┴┼", md: JUNCTION_CHARS },
  { name: "nested boxes", md: NESTED_BOXES },
  { name: "side-by-side boxes", md: SIDE_BY_SIDE },
  { name: "multiple wireframes", md: MULTI_WIREFRAME },
  { name: "pure prose", md: PURE_PROSE },
  { name: "form layout", md: FORM_LAYOUT },
];

// ── No-edit round-trip tests ───────────────────────────────

test.describe("round-trip: no edits", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
  });

  for (const { name, md } of fixtures) {
    test(`${name} — markdown survives round-trip`, async ({ page }) => {
      // Load fixture
      await loadMarkdown(page, md);
      const screenshotBefore = await canvasScreenshot(page);

      // Serialize (simulates save)
      const serialized = await serializeMarkdown(page);

      // Check markdown fidelity
      const diffs = textDiff(md, serialized);
      if (diffs.length > 0) {
        console.log(`MARKDOWN DIFF for "${name}":\n${diffs.join("\n")}`);
      }
      expect(serialized, `Markdown round-trip failed for "${name}":\n${diffs.join("\n")}`).toBe(md);

      // Reload with serialized markdown
      await loadMarkdown(page, serialized);
      const screenshotAfter = await canvasScreenshot(page);

      // Compare screenshots
      const diff = await pixelDiff(page, screenshotBefore, screenshotAfter);
      console.log(`"${name}" pixel diff: ${diff.diffCount}/${diff.total} (${diff.diffPercent.toFixed(2)}%)`);
      expect(diff.diffPercent).toBeLessThan(1); // <1% pixel difference
    });
  }
});

// ── Round-trip after edits ─────────────────────────────────

test.describe("round-trip: after prose edit", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
  });

  test("type in prose, save, reload — text persists, wireframe intact", async ({ page }) => {
    await loadMarkdown(page, SIMPLE_BOX);

    // Click in prose area (top) and type
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    await page.mouse.click(box!.x + 50, box!.y + 5);
    await page.waitForTimeout(300);
    await page.keyboard.type("EDITED ");
    await page.waitForTimeout(300);

    const screenshotEdited = await canvasScreenshot(page);

    // Serialize
    const saved = await serializeMarkdown(page);
    expect(saved).toContain("EDITED");
    expect(saved).toContain("┌"); // wireframe preserved
    expect(saved).toContain("└");

    // Reload saved markdown
    await loadMarkdown(page, saved);
    const screenshotReloaded = await canvasScreenshot(page);

    // Visual should match
    const diff = await pixelDiff(page, screenshotEdited, screenshotReloaded);
    console.log(`Edit round-trip pixel diff: ${diff.diffPercent.toFixed(2)}%`);
    expect(diff.diffPercent).toBeLessThan(5); // allow small cursor/blink diffs
  });

  test("Enter above wireframe, save, reload — wireframe position correct", async ({ page }) => {
    await loadMarkdown(page, SIMPLE_BOX);

    // Click at start of "Prose above"
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    await page.mouse.click(box!.x + 5, box!.y + 5);
    await page.waitForTimeout(300);

    // Press Enter 2 times
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    // Serialize
    const saved = await serializeMarkdown(page);

    // Wireframe should still be present
    expect(saved).toContain("┌──────────────┐");
    expect(saved).toContain("└──────────────┘");
    expect(saved).toContain("Prose below");

    // Reload and screenshot
    const screenshotAfterEdit = await canvasScreenshot(page);
    await loadMarkdown(page, saved);
    const screenshotReloaded = await canvasScreenshot(page);

    const diff = await pixelDiff(page, screenshotAfterEdit, screenshotReloaded);
    console.log(`Enter round-trip pixel diff: ${diff.diffPercent.toFixed(2)}%`);
    expect(diff.diffPercent).toBeLessThan(5);
  });
});

// ── Round-trip after drag ──────────────────────────────────

test.describe("round-trip: after drag", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
  });

  test("drag wireframe, save, reload — no ghost at old position", async ({ page }) => {
    await loadMarkdown(page, SIMPLE_BOX);

    // Find and click wireframe (it's below the prose)
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const wireY = box!.y + 55; // approx center of the box
    const wireX = box!.x + 80;

    // Select wireframe
    await page.mouse.click(wireX, wireY);
    await page.waitForTimeout(300);

    // Drag right by 50px
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(wireX + i * 10, wireY);
    await page.mouse.up();
    await page.waitForTimeout(300);

    const screenshotDragged = await canvasScreenshot(page);

    // Serialize
    const saved = await serializeMarkdown(page);
    expect(saved).toContain("┌"); // wireframe still exists

    // Reload
    await loadMarkdown(page, saved);
    const screenshotReloaded = await canvasScreenshot(page);

    // Compare — should look the same (no ghost, wireframe at new position)
    const diff = await pixelDiff(page, screenshotDragged, screenshotReloaded);
    console.log(`Drag round-trip pixel diff: ${diff.diffPercent.toFixed(2)}%`);
    // Allow more tolerance since selection handles won't be present after reload
    expect(diff.diffPercent).toBeLessThan(10);
  });
});
