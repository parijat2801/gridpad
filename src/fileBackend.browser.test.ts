import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Module under test is imported lazily inside each test so we can
// reset the module cache and reset the module-level `fileHandle`.
async function loadBrowser() {
  vi.resetModules();
  return await import("./fileBackend.browser");
}

function makeFileHandle(opts: { name?: string; text?: string } = {}) {
  const writes: string[] = [];
  const handle = {
    name: opts.name ?? "test.md",
    kind: "file",
    getFile: vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(opts.text ?? "hello"),
    }),
    createWritable: vi.fn().mockResolvedValue({
      write: vi.fn().mockImplementation((chunk: string) => { writes.push(chunk); return Promise.resolve(); }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  return { handle, writes };
}

describe("fileBackend.browser", () => {
  beforeEach(() => {
    // Stub File System Access API on window.
    (globalThis as any).window = (globalThis as any).window ?? {};
  });
  afterEach(() => {
    delete (globalThis as any).window.showOpenFilePicker;
    delete (globalThis as any).window.showSaveFilePicker;
  });

  it("openFile() returns { path, text } and stores handle for later saves", async () => {
    const { handle } = makeFileHandle({ name: "doc.md", text: "# Hi" });
    (window as any).showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
    const backend = await loadBrowser();
    const r = await backend.openFile();
    expect(r).toEqual({ path: "doc.md", text: "# Hi" });
  });

  it("openFile() returns null if user cancels (AbortError)", async () => {
    (window as any).showOpenFilePicker = vi.fn().mockRejectedValue(
      new DOMException("User cancelled", "AbortError")
    );
    const backend = await loadBrowser();
    const r = await backend.openFile();
    expect(r).toBeNull();
  });

  it("saveFile() writes to the previously-opened handle", async () => {
    const { handle, writes } = makeFileHandle({ name: "doc.md", text: "" });
    (window as any).showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
    const backend = await loadBrowser();
    await backend.openFile();
    await backend.saveFile("new content");
    expect(writes).toEqual(["new content"]);
  });

  it("saveFile() is a no-op when no file has been opened", async () => {
    const backend = await loadBrowser();
    // Should not throw.
    await expect(backend.saveFile("anything")).resolves.toBeUndefined();
  });

  it("saveFileAs() prompts, writes, and returns the new path", async () => {
    const { handle, writes } = makeFileHandle({ name: "new.md" });
    (window as any).showSaveFilePicker = vi.fn().mockResolvedValue(handle);
    const backend = await loadBrowser();
    const path = await backend.saveFileAs("contents");
    expect(path).toBe("new.md");
    expect(writes).toEqual(["contents"]);
  });

  it("saveFileAs() returns null on user cancel", async () => {
    (window as any).showSaveFilePicker = vi.fn().mockRejectedValue(
      new DOMException("cancel", "AbortError")
    );
    const backend = await loadBrowser();
    expect(await backend.saveFileAs("x")).toBeNull();
  });

  it("subscribeToOpenRequest() returns an unsubscribe function (no-op)", async () => {
    const backend = await loadBrowser();
    const unlisten = backend.subscribeToOpenRequest(() => {});
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
  });

  it("readFileByPath() returns null in browser mode", async () => {
    const backend = await loadBrowser();
    expect(await backend.readFileByPath("/any/path")).toBeNull();
  });

  it("setTitle() is a no-op (does not throw)", async () => {
    const backend = await loadBrowser();
    expect(() => backend.setTitle("anything")).not.toThrow();
  });
});
