import { test } from "@playwright/test";

const LABELED_BOX = `Title

┌──────────────┐
│    Hello     │
└──────────────┘

End`;

test("debug bucket F: trace each step of text-label edit", async ({ page }) => {
  page.on("console", msg => {
    if (msg.text().startsWith("[")) console.log("BROWSER:", msg.text());
  });
  await page.goto("http://localhost:5173/");
  await page.waitForFunction(() => (window as any).__gridpad !== undefined);
  await page.evaluate((md) => (window as any).__gridpad.loadDocument(md), LABELED_BOX);
  await page.waitForTimeout(300);

  const dump = async (label: string) => {
    const info = await page.evaluate(() => {
      const g = (window as any).__gridpad;
      const sel = g.getSelectedId();
      const te = g.getTextEdit?.();
      const tree = g.getFrameTree();
      const flat: any[] = [];
      const walk = (n: any, d: number) => {
        flat.push({ depth: d, type: n.contentType, text: n.text, id: n.id });
        for (const c of n.children ?? []) walk(c, d + 1);
      };
      for (const n of tree) walk(n, 0);
      return { sel, te, flat };
    });
    console.log(`\n[${label}]`);
    console.log(`  sel=${info.sel ?? "null"}  te=${JSON.stringify(info.te)}`);
    for (const f of info.flat) {
      const sid = f.id?.replace(/^frame-/, "").split("-")[0];
      console.log(`  ${"  ".repeat(f.depth)}${f.type} id=${sid} text=${JSON.stringify(f.text)}`);
    }
  };

  await dump("initial");

  // Find text label coordinates
  const text = await page.evaluate(() => {
    const tree = (window as any).__gridpad.getFrameTree();
    let found: any = null;
    const walk = (n: any) => {
      if (n.contentType === "text") { found = n; return; }
      for (const c of n.children ?? []) walk(c);
    };
    for (const n of tree) walk(n);
    return found;
  });
  if (!text) { console.log("NO TEXT NODE"); return; }
  console.log(`\nText node: absX=${text.absX} absY=${text.absY} w=${text.w} h=${text.h}`);

  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();

  // Step 1: clickFrame equivalent (click at first leaf center). First leaf via getFrameRects = text label.
  const cx = box!.x + text.absX + text.w / 2;
  const cy = box!.y + text.absY + text.h / 2;
  console.log(`\nClicking at viewport (${cx}, ${cy})`);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await dump("after click 1");

  await page.waitForTimeout(400);

  // Step 2a: explicit down/up sequences for dblclick
  console.log(`\nDown 2 at (${cx}, ${cy})`);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(20);
  await page.mouse.up();
  await page.waitForTimeout(50);
  await dump("after click 2");
  console.log(`\nDown 3 (programmatic dispatch via dispatchEvent)`);
  await page.evaluate(({x, y}) => {
    const canvas = document.querySelector("canvas")!;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    canvas.dispatchEvent(new MouseEvent("mousedown", opts));
    canvas.dispatchEvent(new MouseEvent("mouseup", opts));
  }, { x: cx, y: cy });
  await page.waitForTimeout(300);
  await dump("after click 3 (programmatic)");

  // Step 3: End
  console.log(`\nPress End`);
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  await dump("after End");

  // Step 4: type !
  console.log(`\nType !`);
  await page.keyboard.type("!");
  await page.waitForTimeout(300);
  await dump("after type !");

  // Try entering text-edit programmatically by exposing the effect dispatch
  console.log(`\nProgrammatic: invoke selectFrame + setTextEdit on text frame`);
  const wired = await page.evaluate(({textId}) => {
    const g = (window as any).__gridpad;
    const before = g.getTextEdit?.() ?? null;
    g.selectFrame?.(textId);
    // Some test surfaces may not expose setTextEdit. Try common names.
    let used = "none";
    if (g.setTextEdit) { g.setTextEdit({ frameId: textId, col: 0 }); used = "setTextEdit"; }
    else if (g.startTextEdit) { g.startTextEdit({ frameId: textId, col: 0 }); used = "startTextEdit"; }
    else if (g.enterTextEdit) { g.enterTextEdit({ frameId: textId, col: 0 }); used = "enterTextEdit"; }
    const after = g.getTextEdit?.() ?? null;
    return { before, after, used, hasGetTextEdit: typeof g.getTextEdit };
  }, { textId: text.id });
  console.log(JSON.stringify(wired));

  const saved = await page.evaluate(() => (window as any).__gridpad.saveDocument());
  console.log(`\nSAVED:\n${saved}`);
});
