/**
 * spatialKeyHandler.ts — pure key-press logic for the spatial canvas.
 *
 * These functions take current state + a key event and return new state
 * (or null to signal "no change"). They have no side effects.
 */

import { insertChar, deleteChar } from "./proseCursor";
import type { ProseCursor } from "./spatialHitTest";

export interface ProseKeyResult {
  /** Updated cursor position */
  cursor: ProseCursor | null;
  /** Updated region text (if text was mutated), or null if unchanged */
  newText: string | null;
  /** Whether to trigger layout rebuild */
  needsLayout: boolean;
  /** Whether to stop the blink */
  stopBlink: boolean;
  /** Whether to consume the event */
  preventDefault: boolean;
  /** Whether to reset the blink */
  resetBlink: boolean;
}

/**
 * Compute the new prose cursor state for a keydown event.
 *
 * @param e           - native KeyboardEvent
 * @param pc          - current prose cursor
 * @param regionText  - the current text of the prose region
 * @returns           - what to apply, or null if the key was not handled
 */
export function handleProseKeyPress(
  e: KeyboardEvent,
  pc: ProseCursor,
  regionText: string,
): ProseKeyResult | null {
  const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
  if (mod) return null;

  const key = e.key;
  const sourceLines = regionText.split("\n");

  if (key === "Escape") {
    return { cursor: null, newText: null, needsLayout: false, stopBlink: true, preventDefault: true, resetBlink: false };
  }

  if (key === "ArrowLeft") {
    let newCursor: ProseCursor;
    if (pc.col > 0) {
      newCursor = { ...pc, col: pc.col - 1 };
    } else if (pc.row > 0) {
      newCursor = { ...pc, row: pc.row - 1, col: (sourceLines[pc.row - 1] ?? "").length };
    } else {
      newCursor = pc;
    }
    return { cursor: newCursor, newText: null, needsLayout: false, stopBlink: false, preventDefault: true, resetBlink: true };
  }

  if (key === "ArrowRight") {
    const line = sourceLines[pc.row] ?? "";
    let newCursor: ProseCursor;
    if (pc.col < line.length) {
      newCursor = { ...pc, col: pc.col + 1 };
    } else if (pc.row < sourceLines.length - 1) {
      newCursor = { ...pc, row: pc.row + 1, col: 0 };
    } else {
      newCursor = pc;
    }
    return { cursor: newCursor, newText: null, needsLayout: false, stopBlink: false, preventDefault: true, resetBlink: true };
  }

  if (key === "ArrowUp") {
    const newCursor = pc.row > 0
      ? { ...pc, row: pc.row - 1, col: Math.min(pc.col, (sourceLines[pc.row - 1] ?? "").length) }
      : pc;
    return { cursor: newCursor, newText: null, needsLayout: false, stopBlink: false, preventDefault: true, resetBlink: true };
  }

  if (key === "ArrowDown") {
    const newCursor = pc.row < sourceLines.length - 1
      ? { ...pc, row: pc.row + 1, col: Math.min(pc.col, (sourceLines[pc.row + 1] ?? "").length) }
      : pc;
    return { cursor: newCursor, newText: null, needsLayout: false, stopBlink: false, preventDefault: true, resetBlink: true };
  }

  if (key === "Backspace") {
    const result = deleteChar(regionText, { row: pc.row, col: pc.col });
    return {
      cursor: { ...pc, row: result.cursor.row, col: result.cursor.col },
      newText: result.text,
      needsLayout: true, stopBlink: false, preventDefault: true, resetBlink: true,
    };
  }

  if (key === "Delete") {
    const line = sourceLines[pc.row] ?? "";
    let delCursor = { row: pc.row, col: pc.col };
    if (pc.col < line.length) delCursor = { row: pc.row, col: pc.col + 1 };
    else if (pc.row < sourceLines.length - 1) delCursor = { row: pc.row + 1, col: 0 };
    else return null; // nothing to delete
    const result = deleteChar(regionText, delCursor);
    return {
      cursor: { ...pc, row: result.cursor.row, col: result.cursor.col },
      newText: result.text,
      needsLayout: true, stopBlink: false, preventDefault: true, resetBlink: true,
    };
  }

  if (key === "Enter") {
    const result = insertChar(regionText, { row: pc.row, col: pc.col }, "\n");
    return {
      cursor: { ...pc, row: result.cursor.row, col: result.cursor.col },
      newText: result.text,
      needsLayout: true, stopBlink: false, preventDefault: true, resetBlink: true,
    };
  }

  if (key.length === 1 && !e.ctrlKey && !e.metaKey) {
    const result = insertChar(regionText, { row: pc.row, col: pc.col }, key);
    return {
      cursor: { ...pc, row: result.cursor.row, col: result.cursor.col },
      newText: result.text,
      needsLayout: true, stopBlink: false, preventDefault: true, resetBlink: true,
    };
  }

  return null;
}

export interface WireframeKeyResult {
  /** Updated col, or null if edit is done (Escape/Enter) */
  col: number | null;
  /** null = done editing (commit), otherwise new content */
  newContent: string | null;
  /** Whether to consume the event */
  preventDefault: boolean;
  /** Whether to reset the blink */
  resetBlink: boolean;
  /** Whether to commit and stop editing (true for Escape/Enter) */
  commit: boolean;
}

/**
 * Compute the new wireframe text edit state for a keydown event.
 *
 * @param e        - native KeyboardEvent
 * @param col      - current cursor column within the label text
 * @param content  - current label content
 * @returns        - what to apply, or null if key was not handled
 */
export function handleWireframeKeyPress(
  e: KeyboardEvent,
  col: number,
  content: string,
): WireframeKeyResult | null {
  const mod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
  if (mod) return null;

  const key = e.key;

  if (key === "Escape" || key === "Enter") {
    return { col: null, newContent: null, preventDefault: true, resetBlink: false, commit: true };
  }

  if (key === "ArrowLeft") {
    return { col: col > 0 ? col - 1 : col, newContent: null, preventDefault: true, resetBlink: true, commit: false };
  }

  if (key === "ArrowRight") {
    return { col: col < content.length ? col + 1 : col, newContent: null, preventDefault: true, resetBlink: true, commit: false };
  }

  if (key === "Backspace") {
    if (col === 0) return null;
    const newContent = content.slice(0, col - 1) + content.slice(col);
    return { col: col - 1, newContent, preventDefault: true, resetBlink: true, commit: false };
  }

  if (key.length === 1 && !e.ctrlKey && !e.metaKey) {
    const newContent = content.slice(0, col) + key + content.slice(col);
    return { col: col + 1, newContent, preventDefault: true, resetBlink: true, commit: false };
  }

  return null;
}
