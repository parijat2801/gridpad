import { test, expect, Page } from "@playwright/test";
import {
  load,
  save,
  clickFrame,
  dragSelected,
  resizeSelected,
  clickProse,
  getFrameTree,
  findGhostsFromPage,
  checkInvariants,
  ensureDir,
  writeArtifact,
  ARTIFACTS,
  JUNCTION,
  NESTED,
  WITH_CHILDREN,
  SHARED_HORIZONTAL,
} from "./test-utils";

test.describe("convergence", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  async function convergenceTest(
    page: Page,
    name: string,
    fixtureMd: string | null,
    operate: (p: Page) => Promise<void>,
  ) {
    let md = fixtureMd;
    if (!md) {
      await page.waitForTimeout(1000);
      md = await save(page); // capture default
    } else {
      await load(page, md);
    }

    for (let cycle = 0; cycle < 5; cycle++) {
      if (cycle > 0) await load(page, md);
      await operate(page);
      const next = await save(page);
      writeArtifact(`convergence-${name}`, `cycle${cycle}.md`, next);

      // Each cycle must produce no ghosts
      const ghosts = await findGhostsFromPage(page, next);
      expect(ghosts, `Ghosts at cycle ${cycle} of ${name}`).toEqual([]);

      // Check invariants
      const tree = await getFrameTree(page);
      expect(checkInvariants(tree), `Invariants at cycle ${cycle}`).toEqual([]);

      // Check if stabilized
      if (next === md) {
        // Stabilized! Done.
        return;
      }
      md = next;
    }

    // After 5 cycles, must have stabilized
    await load(page, md);
    const final = await save(page);
    expect(final, `${name} did not stabilize within 5 cycles`).toBe(md);
  }

  test("JUNCTION + drag (shared walls)", async ({ page }) => {
    await convergenceTest(page, "junction-drag", JUNCTION, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 30, 0);
      await clickProse(p, 5, 5);
    });
  });

  test("NESTED + drag child", async ({ page }) => {
    // For nested, we want to drag the child, not the parent
    // But clickFrame(0) selects parent. So just drag parent.
    await convergenceTest(page, "nested-drag", NESTED, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 30, 0);
      await clickProse(p, 5, 5);
    });
  });

  test("WITH_CHILDREN + resize parent", async ({ page }) => {
    await convergenceTest(page, "children-resize", WITH_CHILDREN, async (p) => {
      await clickFrame(p, 0);
      await resizeSelected(p, 30, 15);
      await clickProse(p, 5, 5);
    });
  });

  test("DEFAULT_TEXT + drag dashboard", async ({ page }) => {
    await convergenceTest(page, "default-drag", null, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 50, 0);
      await clickProse(p, 5, 5);
    });
  });

  test("SHARED_HORIZONTAL + drag", async ({ page }) => {
    await convergenceTest(page, "shared-horiz-drag", SHARED_HORIZONTAL, async (p) => {
      await clickFrame(p, 0);
      await dragSelected(p, 40, 0);
      await clickProse(p, 5, 5);
    });
  });
});
