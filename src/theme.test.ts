/**
 * theme.test.ts — unit tests for the live-editable theme module.
 *
 * Verifies (per plan step 15):
 *   - updateTheme classifies patches: bgColor→css-vars-only, proseColor→paint,
 *     wireframeFontSize→reflow; mixed patches take the strongest action.
 *   - theme object reflects mutations after updateTheme.
 *   - resetTheme restores defaults.
 *   - subscribe/unsubscribe works (subscribers fire synchronously on update;
 *     unsubscribe stops further notifications).
 *   - getSnapshot returns a fresh frozen reference per update, but the SAME
 *     reference between updates (required by useSyncExternalStore's
 *     tearing-detection contract).
 *
 * jsdom provides document.documentElement.style for CSS-var assertions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  theme,
  updateTheme,
  resetTheme,
  subscribe,
  getSnapshot,
  classifyPatch,
  DEFAULT_THEME,
  type ThemeUpdateKind,
} from "./theme";

afterEach(() => {
  // Restore defaults so tests don't leak state across runs.
  resetTheme();
});

describe("classifyPatch", () => {
  it("classifies bgColor as css-vars-only", () => {
    expect(classifyPatch({ bgColor: "#000000" })).toBe<ThemeUpdateKind>("css-vars-only");
  });

  it("classifies selectionColor as css-vars-only", () => {
    expect(classifyPatch({ selectionColor: "#ff00ff" })).toBe<ThemeUpdateKind>("css-vars-only");
  });

  it("classifies gridBorderColor as css-vars-only", () => {
    expect(classifyPatch({ gridBorderColor: "#222222" })).toBe<ThemeUpdateKind>("css-vars-only");
  });

  it("classifies proseColor as paint (canvas-side, not reflow)", () => {
    expect(classifyPatch({ proseColor: "#ffffff" })).toBe<ThemeUpdateKind>("paint");
  });

  it("classifies wireframeColor as paint", () => {
    expect(classifyPatch({ wireframeColor: "#ffffff" })).toBe<ThemeUpdateKind>("paint");
  });

  it("classifies wireframeFontSize as reflow", () => {
    expect(classifyPatch({ wireframeFontSize: 18 })).toBe<ThemeUpdateKind>("reflow");
  });

  it("classifies wireframeFontFamily as reflow", () => {
    expect(classifyPatch({ wireframeFontFamily: "Monaco" })).toBe<ThemeUpdateKind>("reflow");
  });

  it("classifies proseFontFamily as reflow", () => {
    expect(classifyPatch({ proseFontFamily: "Helvetica" })).toBe<ThemeUpdateKind>("reflow");
  });

  it("classifies proseFontSize as reflow", () => {
    expect(classifyPatch({ proseFontSize: 18 })).toBe<ThemeUpdateKind>("reflow");
  });

  it("classifies proseLineHeight as reflow", () => {
    expect(classifyPatch({ proseLineHeight: 24 })).toBe<ThemeUpdateKind>("reflow");
  });

  it("classifies charWidthMultiplier as reflow", () => {
    expect(classifyPatch({ charWidthMultiplier: 1.1 })).toBe<ThemeUpdateKind>("reflow");
  });

  it("classifies charHeightMultiplier as reflow", () => {
    expect(classifyPatch({ charHeightMultiplier: 1.5 })).toBe<ThemeUpdateKind>("reflow");
  });

  it("mixed patch (reflow + paint + css-vars) takes strongest = reflow", () => {
    expect(
      classifyPatch({ wireframeFontSize: 20, proseColor: "#fff", bgColor: "#000" }),
    ).toBe<ThemeUpdateKind>("reflow");
  });

  it("mixed patch (paint + css-vars) takes strongest = paint", () => {
    expect(classifyPatch({ proseColor: "#fff", bgColor: "#000" })).toBe<ThemeUpdateKind>("paint");
  });

  it("empty patch classifies as css-vars-only (no canvas work needed)", () => {
    expect(classifyPatch({})).toBe<ThemeUpdateKind>("css-vars-only");
  });
});

describe("theme defaults", () => {
  it("DEFAULT_THEME matches today's hardcoded values exactly", () => {
    // Per plan step 13 — these are pinned to current production values so the
    // first launch with no theme.json present produces zero visual change.
    expect(DEFAULT_THEME.proseFontFamily).toBe("Inter");
    expect(DEFAULT_THEME.proseFontSize).toBe(16);
    expect(DEFAULT_THEME.proseLineHeight).toBe(22); // matches textFont.ts:14
    expect(DEFAULT_THEME.proseColor).toBe("#e0e0e0");
    expect(DEFAULT_THEME.wireframeFontFamily).toBe('Menlo, Monaco, "Courier New", monospace');
    expect(DEFAULT_THEME.wireframeFontSize).toBe(16);
    expect(DEFAULT_THEME.wireframeColor).toBe("#e0e0e0");
    expect(DEFAULT_THEME.charWidthMultiplier).toBe(1.0);
    expect(DEFAULT_THEME.charHeightMultiplier).toBe(1.4);
    expect(DEFAULT_THEME.bgColor).toBe("#1e1e2e");
    expect(DEFAULT_THEME.selectionColor).toBe("#4a90e2");
    expect(DEFAULT_THEME.gridBorderColor).toBe("#444");
  });

  it("the live `theme` object starts equal to defaults", () => {
    for (const key of Object.keys(DEFAULT_THEME) as (keyof typeof DEFAULT_THEME)[]) {
      expect(theme[key]).toBe(DEFAULT_THEME[key]);
    }
  });
});

describe("updateTheme — mutation semantics", () => {
  it("Object.assigns the patch synchronously into the live theme", () => {
    updateTheme({ wireframeFontSize: 22 });
    expect(theme.wireframeFontSize).toBe(22);
  });

  it("partial patches don't clobber unrelated fields", () => {
    updateTheme({ proseColor: "#abcdef" });
    expect(theme.proseColor).toBe("#abcdef");
    expect(theme.wireframeFontSize).toBe(DEFAULT_THEME.wireframeFontSize);
    expect(theme.bgColor).toBe(DEFAULT_THEME.bgColor);
  });

  it("returns the classification kind so callers can branch in the subscriber", () => {
    expect(updateTheme({ bgColor: "#101010" })).toBe<ThemeUpdateKind>("css-vars-only");
    expect(updateTheme({ proseColor: "#bababa" })).toBe<ThemeUpdateKind>("paint");
    expect(updateTheme({ wireframeFontSize: 18 })).toBe<ThemeUpdateKind>("reflow");
  });
});

describe("resetTheme", () => {
  it("restores every field to DEFAULT_THEME", () => {
    updateTheme({
      wireframeFontSize: 24,
      proseColor: "#123456",
      bgColor: "#654321",
    });
    resetTheme();
    for (const key of Object.keys(DEFAULT_THEME) as (keyof typeof DEFAULT_THEME)[]) {
      expect(theme[key]).toBe(DEFAULT_THEME[key]);
    }
  });

  it("notifies subscribers", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    listener.mockClear(); // ignore any initial-fire if it happens
    resetTheme();
    expect(listener).toHaveBeenCalled();
    unsub();
  });
});

describe("subscribe / notifyListeners", () => {
  it("calls listeners synchronously inside updateTheme", () => {
    const calls: string[] = [];
    const unsub = subscribe(() => { calls.push("fired"); });
    expect(calls.length).toBe(0); // not called by subscribe itself
    updateTheme({ proseColor: "#aaaaaa" });
    expect(calls).toEqual(["fired"]); // synchronous, exactly once
    unsub();
  });

  it("passes the classification kind to listeners", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    updateTheme({ wireframeFontSize: 20 });
    expect(listener).toHaveBeenCalledWith<["reflow"]>("reflow");
    listener.mockClear();
    updateTheme({ bgColor: "#222222" });
    expect(listener).toHaveBeenCalledWith<["css-vars-only"]>("css-vars-only");
    unsub();
  });

  it("unsubscribe stops further notifications", () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    updateTheme({ proseColor: "#111111" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    updateTheme({ proseColor: "#222222" });
    expect(listener).toHaveBeenCalledTimes(1); // no second call
  });

  it("supports multiple independent subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribe(a);
    const unsubB = subscribe(b);
    updateTheme({ proseColor: "#333333" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    updateTheme({ proseColor: "#444444" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    unsubB();
  });
});

describe("getSnapshot — useSyncExternalStore contract", () => {
  it("returns the SAME reference across calls between updates (tearing-detection)", () => {
    const s1 = getSnapshot();
    const s2 = getSnapshot();
    expect(s2).toBe(s1); // referential equality, not just deep-equal
  });

  it("returns a NEW reference after updateTheme", () => {
    const before = getSnapshot();
    updateTheme({ proseColor: "#555555" });
    const after = getSnapshot();
    expect(after).not.toBe(before);
  });

  it("snapshot reflects the new value after update", () => {
    updateTheme({ wireframeFontSize: 19 });
    const snap = getSnapshot();
    expect(snap.wireframeFontSize).toBe(19);
  });

  it("snapshots are frozen (immutable)", () => {
    const snap = getSnapshot();
    expect(Object.isFrozen(snap)).toBe(true);
  });
});

describe("CSS variables are written to :root on css-vars-only updates", () => {
  it("writes --theme-bg when bgColor changes", () => {
    updateTheme({ bgColor: "#0a0a0a" });
    expect(document.documentElement.style.getPropertyValue("--theme-bg")).toBe("#0a0a0a");
  });

  it("writes --theme-selection when selectionColor changes", () => {
    updateTheme({ selectionColor: "#ff8800" });
    expect(document.documentElement.style.getPropertyValue("--theme-selection")).toBe("#ff8800");
  });

  it("writes --theme-grid-border when gridBorderColor changes", () => {
    updateTheme({ gridBorderColor: "#888888" });
    expect(document.documentElement.style.getPropertyValue("--theme-grid-border")).toBe("#888888");
  });
});
