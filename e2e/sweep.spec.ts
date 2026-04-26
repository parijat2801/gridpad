/**
 * Matrix sweep: 6 fixtures × 6 operations = 36 tests.
 *
 * Each test loads a fixture, performs an operation, then checks:
 * - No ghost wire characters
 * - Frame tree invariants pass
 * - Serialization converges (reload → save == save)
 * - Frame count is preserved (for non-delete operations)
 */
import { test, expect, type Page } from "@playwright/test";
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
  flattenTree,
  ensureDir,
  writeArtifact,
  ARTIFACTS,
  SIMPLE_BOX,
  LABELED_BOX,
  JUNCTION,
  NESTED,
  WITH_CHILDREN,
  DASHBOARD,
  MOBILE_APP,
  SIGNUP_FORM,
  FLOWCHART,
  MULTI_SECTION,
  KANBAN,
  CRM_WORKSPACE,
  CONTAINER_LIST,
  ADMIN_PANEL,
  CHAT_UI,
  ENTERPRISE_DASHBOARD,
  DECISION_FLOWCHART,
  ARCHITECTURE_DIAGRAM,
  USER_JOURNEY,
} from "./test-utils";

// ── Fixtures ──────────────────────────────────────────────

const FIXTURES: Array<{ name: string; md: string | null }> = [
  { name: "simple-box", md: SIMPLE_BOX },
  { name: "labeled-box", md: LABELED_BOX },
  { name: "junction", md: JUNCTION },
  { name: "nested", md: NESTED },
  { name: "with-children", md: WITH_CHILDREN },
  { name: "dashboard", md: DASHBOARD },
  { name: "mobile-app", md: MOBILE_APP },
  { name: "signup-form", md: SIGNUP_FORM },
  { name: "flowchart", md: FLOWCHART },
  { name: "multi-section", md: MULTI_SECTION },
  { name: "kanban", md: KANBAN },
  { name: "crm-workspace", md: CRM_WORKSPACE },
  { name: "container-list", md: CONTAINER_LIST },
  { name: "admin-panel", md: ADMIN_PANEL },
  { name: "chat-ui", md: CHAT_UI },
  { name: "enterprise-dashboard", md: ENTERPRISE_DASHBOARD },
  { name: "decision-flowchart", md: DECISION_FLOWCHART },
  { name: "architecture-diagram", md: ARCHITECTURE_DIAGRAM },
  { name: "user-journey", md: USER_JOURNEY },
  { name: "default", md: null }, // null = use default text already on page
];

// ── Operations ────────────────────────────────────────────

const OPERATIONS: Array<{ name: string; run: (p: Page) => Promise<void> }> = [
  {
    name: "drag-right-50",
    run: async (p: Page) => {
      await clickFrame(p, 0);
      await dragSelected(p, 50, 0);
      await clickProse(p, 5, 5);
    },
  },
  {
    name: "drag-down-80",
    run: async (p: Page) => {
      await clickFrame(p, 0);
      await dragSelected(p, 0, 80);
      await clickProse(p, 5, 5);
    },
  },
  {
    name: "drag-left-50",
    run: async (p: Page) => {
      await clickFrame(p, 0);
      await dragSelected(p, -50, 0);
      await clickProse(p, 5, 5);
    },
  },
  {
    name: "resize-larger",
    run: async (p: Page) => {
      await clickFrame(p, 0);
      await resizeSelected(p, 40, 20);
      await clickProse(p, 5, 5);
    },
  },
  {
    name: "resize-smaller",
    run: async (p: Page) => {
      await clickFrame(p, 0);
      await resizeSelected(p, -30, -20);
      await clickProse(p, 5, 5);
    },
  },
  {
    name: "type-5-chars",
    run: async (p: Page) => {
      await clickProse(p, 5, 5);
      await p.keyboard.type("SWEEP");
    },
  },
];

// ── Sweep helper ──────────────────────────────────────────

async function sweep(
  page: Page,
  fixtureName: string,
  fixtureMd: string | null,
  op: { name: string; run: (p: Page) => Promise<void> },
): Promise<void> {
  // Load fixture
  if (fixtureMd !== null) {
    await load(page, fixtureMd);
  } else {
    // Default text — page already navigated in beforeEach; just wait for settle
    await page.waitForTimeout(1000);
  }

  // Capture state before operation
  const treeBeforeFlat = flattenTree(await getFrameTree(page));

  // Execute operation
  await op.run(page);

  // Serialize
  const output = await save(page);
  writeArtifact(`sweep-${fixtureName}-${op.name}`, "output.md", output);

  // Check: no ghost wire characters
  const ghosts = await findGhostsFromPage(page, output);
  expect(ghosts, `Ghosts in ${fixtureName}+${op.name}`).toEqual([]);

  // Check: frame tree invariants
  const tree = await getFrameTree(page);
  const invariants = checkInvariants(tree);
  expect(invariants, `Invariants failed for ${fixtureName}+${op.name}`).toEqual([]);

  // Check: serialization convergence (reload → save must be identical)
  await load(page, output);
  const output2 = await save(page);
  expect(output2, `Non-convergent: ${fixtureName}+${op.name}`).toBe(output);

  // Check: frame count preserved (all operations here are non-delete)
  const treeFinalFlat = flattenTree(await getFrameTree(page));
  if (!op.name.includes("delete")) {
    expect(
      treeFinalFlat.length,
      `Frame count changed for ${fixtureName}+${op.name}`,
    ).toBe(treeBeforeFlat.length);
  }
}

// ── Test matrix ───────────────────────────────────────────

test.describe("sweep", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    ensureDir(ARTIFACTS);
  });

  for (const fixture of FIXTURES) {
    for (const op of OPERATIONS) {
      test(`${fixture.name} + ${op.name}`, async ({ page }) => {
        await sweep(page, fixture.name, fixture.md, op);
      });
    }
  }
});
