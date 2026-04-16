// src/serialize.test.ts
// Tests for framesToMarkdown.

import { describe, it, expect } from "vitest";
import { framesToMarkdown } from "./serialize";
import { scan } from "./scanner";
import { detectRegions } from "./regions";
import { framesFromRegions } from "./frame";
import type { Region } from "./regions";
import type { Frame } from "./frame";

const CHAR_W = 9.6;
const CHAR_H = 18.4;

// ── pure prose ────────────────────────────────────────────────────────────────

describe("framesToMarkdown — pure prose", () => {
  it("returns joined prose text when there are no wireframe regions", () => {
    const proseText = "Hello world\nSecond line";
    const regions: Region[] = [
      { type: "prose", startRow: 0, endRow: 1, text: proseText },
    ];
    const prose = [{ startRow: 0, text: proseText }];
    const result = framesToMarkdown([], prose, regions, CHAR_W, CHAR_H);
    expect(result).toBe(proseText);
  });

  it("joins multiple prose regions with double newlines", () => {
    const regions: Region[] = [
      { type: "prose", startRow: 0, endRow: 0, text: "Part one" },
      { type: "prose", startRow: 2, endRow: 2, text: "Part two" },
    ];
    const prose = [
      { startRow: 0, text: "Part one" },
      { startRow: 2, text: "Part two" },
    ];
    const result = framesToMarkdown([], prose, regions, CHAR_W, CHAR_H);
    expect(result).toBe("Part one\n\nPart two");
  });
});

// ── prose + wireframe ─────────────────────────────────────────────────────────

describe("framesToMarkdown — prose + wireframe regions", () => {
  it("passes wireframe region text through when no mutations", () => {
    const wireText = "┌──┐\n│  │\n└──┘";
    const text = `Intro text\n\n${wireText}\n\nOutro text`;
    const scanResult = scan(text);
    const regions = detectRegions(scanResult);
    const { frames, prose } = framesFromRegions(regions, CHAR_W, CHAR_H, scanResult);

    const result = framesToMarkdown(frames, prose, regions, CHAR_W, CHAR_H);

    // Prose parts should be present
    expect(result).toContain("Intro text");
    expect(result).toContain("Outro text");
    // Wireframe text should be preserved
    expect(result).toContain("┌");
    expect(result).toContain("└");
  });

  it("preserves round-trip: framesToMarkdown reproduces original regions", () => {
    const wireText = "┌────┐\n│    │\n└────┘";
    const fullText = `Top prose\n\n${wireText}\n\nBottom prose`;
    const scanResult = scan(fullText);
    const regions = detectRegions(scanResult);
    const { frames, prose } = framesFromRegions(regions, CHAR_W, CHAR_H, scanResult);

    const result = framesToMarkdown(frames, prose, regions, CHAR_W, CHAR_H);

    expect(result).toContain("Top prose");
    expect(result).toContain("Bottom prose");
    expect(result).toContain("┌────┐");
  });
});

// ── missing prosePart fallback ────────────────────────────────────────────────

describe("framesToMarkdown — missing prosePart fallback", () => {
  it("falls back to region.text when prose array is shorter than prose regions", () => {
    const originalText = "Original prose text";
    const regions: Region[] = [
      { type: "prose", startRow: 0, endRow: 0, text: originalText },
    ];
    // Pass an empty prose array — simulates rebuildProseParts returning fewer parts
    const prose: { startRow: number; text: string }[] = [];
    const frames: Frame[] = [];

    const result = framesToMarkdown(frames, prose, regions, CHAR_W, CHAR_H);

    // Should fall back to region.text rather than empty string
    expect(result).toBe(originalText);
  });

  it("preserves original region text in fallback, not empty string", () => {
    const regions: Region[] = [
      { type: "prose", startRow: 0, endRow: 2, text: "Preserved content\nLine two" },
    ];
    const result = framesToMarkdown([], [], regions, CHAR_W, CHAR_H);
    expect(result).toBe("Preserved content\nLine two");
    expect(result).not.toBe("");
  });
});
