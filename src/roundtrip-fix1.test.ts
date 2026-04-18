import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { scan } from "./scanner";
import { detectRegions } from "./regions";

const LOG: string[] = [];
const L = (s: string) => LOG.push(s);

describe("fix 1 investigation", () => {
  it("trace region boundaries for simple box", () => {
    const text = "Prose above\n\n┌──────┐\n│      │\n└──────┘\n\nProse below";
    const lines = text.split("\n");
    L("=== INPUT LINES ===");
    lines.forEach((l, i) => L(`  ${i}: ${JSON.stringify(l)}`));

    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    L("\n=== REGIONS ===");
    for (const r of regions) {
      L(`  ${r.type} rows=[${r.startRow}-${r.endRow}] text=${JSON.stringify(r.text)}`);
    }

    L("\n=== ANALYSIS ===");
    // The input has these lines:
    // 0: "Prose above"
    // 1: ""              ← blank separator
    // 2: "┌──────┐"
    // 3: "│      │"
    // 4: "└──────┘"
    // 5: ""              ← blank separator
    // 6: "Prose below"
    //
    // Prose region should be rows 0-0 (just "Prose above")
    // But detectRegions expands shape ranges by -1/+1 margin (lines 40-42, 63-64)
    // So the wireframe range becomes start=max(0, rectRow-1), end=min(len-1, rectRow+h)
    // If rect starts at row 2 (h=3), range = start=1, end=5
    // That means the blank line at row 1 is INSIDE the wireframe region
    // And the wireframe text starts with the blank line: "\n┌──────┐\n..."

    L(`Prose region 0 endRow: ${regions[0]?.endRow}`);
    L(`Wireframe startRow: ${regions[1]?.startRow}`);
    L(`Expected wireframe startRow: 2 (first box-drawing line)`);
    L(`Actual wireframe text starts with blank: ${regions[1]?.text.startsWith("\n") || regions[1]?.text.startsWith("")}`);
  });

  it("framesToMarkdown join logic", () => {
    // framesToMarkdown joins parts with \n\n
    // If prose text = "Prose above" and wireframe text = "\n┌──────┐\n..."
    // Result = "Prose above" + "\n\n" + "\n┌──────┐\n..." = THREE newlines
    // Expected: "Prose above" + "\n\n" + "┌──────┐\n..." = TWO newlines
    L("\n=== JOIN ANALYSIS ===");
    const proseText = "Prose above";
    const wireText = "\n┌──────┐\n│      │\n└──────┘";
    const joined = [proseText, wireText].join("\n\n");
    L(`Joined: ${JSON.stringify(joined)}`);
    L(`Has triple newline: ${joined.includes("\n\n\n")}`);

    // Fix option: strip leading/trailing blank lines from region.text
    const wireTextFixed = wireText.replace(/^\n+/, "").replace(/\n+$/, "");
    const joinedFixed = [proseText, wireTextFixed].join("\n\n");
    L(`Fixed joined: ${JSON.stringify(joinedFixed)}`);
    L(`Has triple newline: ${joinedFixed.includes("\n\n\n")}`);
  });

  it("write log", () => {
    writeFileSync("/tmp/fix1-debug.log", LOG.join("\n") + "\n");
    expect(true).toBe(true);
  });
});
