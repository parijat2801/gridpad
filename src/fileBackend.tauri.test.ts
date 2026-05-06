import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

async function loadTauri() {
  vi.resetModules();
  return await import("./fileBackend.tauri");
}

describe("fileBackend.tauri", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });
  afterEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it("openFile() invokes dialog_open_command and returns its result", async () => {
    invokeMock.mockResolvedValueOnce({ path: "/tmp/x.md", text: "# x" });
    const backend = await loadTauri();
    const r = await backend.openFile();
    expect(invokeMock).toHaveBeenCalledWith("dialog_open_command");
    expect(r).toEqual({ path: "/tmp/x.md", text: "# x" });
  });

  it("openFile() returns null when user cancels (Rust returns None)", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const backend = await loadTauri();
    expect(await backend.openFile()).toBeNull();
  });

  it("saveFile() invokes write_file_command with text", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const backend = await loadTauri();
    await backend.saveFile("hello");
    expect(invokeMock).toHaveBeenCalledWith("write_file_command", { text: "hello" });
  });

  it("saveFileAs() invokes dialog_save_command and returns path", async () => {
    invokeMock.mockResolvedValueOnce("/tmp/new.md");
    const backend = await loadTauri();
    const p = await backend.saveFileAs("contents");
    expect(invokeMock).toHaveBeenCalledWith("dialog_save_command", { text: "contents" });
    expect(p).toBe("/tmp/new.md");
  });

  it("saveFileAs() returns null when user cancels", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const backend = await loadTauri();
    expect(await backend.saveFileAs("x")).toBeNull();
  });

  it("readFileByPath() invokes read_file_command", async () => {
    invokeMock.mockResolvedValueOnce("# content");
    const backend = await loadTauri();
    expect(await backend.readFileByPath("/p")).toBe("# content");
    expect(invokeMock).toHaveBeenCalledWith("read_file_command", { path: "/p" });
  });

  it("readFileByPath() returns null on Err (Rust converts to JS rejection)", async () => {
    invokeMock.mockRejectedValueOnce("ENOENT");
    const backend = await loadTauri();
    expect(await backend.readFileByPath("/missing")).toBeNull();
  });

  it("subscribeToOpenRequest() registers a listener and forwards the path", async () => {
    let captured: ((e: { payload: string }) => void) | null = null;
    const unlistenSpy = vi.fn();
    listenMock.mockImplementationOnce((_event: string, handler: (e: { payload: string }) => void) => {
      captured = handler;
      return Promise.resolve(unlistenSpy);
    });
    // Initial-path drain returns nothing on this test.
    invokeMock.mockResolvedValueOnce(null);

    const backend = await loadTauri();
    const cb = vi.fn();
    const unsub = backend.subscribeToOpenRequest(cb);

    // Allow the async listen() promise to resolve.
    await new Promise(r => setTimeout(r, 0));

    expect(listenMock).toHaveBeenCalledWith("open-path-request", expect.any(Function));
    captured!({ payload: "/tmp/from-os.md" });
    expect(cb).toHaveBeenCalledWith("/tmp/from-os.md");

    // Unsubscribe should call the unlisten fn returned by listen().
    unsub();
    await new Promise(r => setTimeout(r, 0));
    expect(unlistenSpy).toHaveBeenCalled();
  });

  it("subscribeToOpenRequest() unsubscribes safely when cancelled before listen() resolves", async () => {
    // Hold the listen() promise until we explicitly resolve it.
    let resolveListen: (fn: () => void) => void = () => {};
    const unlistenSpy = vi.fn();
    listenMock.mockImplementationOnce(() =>
      new Promise<() => void>(res => { resolveListen = res; })
    );
    invokeMock.mockResolvedValueOnce(null); // get_initial_path drain

    const backend = await loadTauri();
    const unsub = backend.subscribeToOpenRequest(() => {});
    // Unsubscribe before listen() has resolved.
    unsub();
    // Now resolve listen — the impl must call its returned unlisten fn.
    resolveListen(unlistenSpy);
    await new Promise(r => setTimeout(r, 0));
    expect(unlistenSpy).toHaveBeenCalled();
  });

  it("subscribeToOpenRequest() drains pending initial path on subscribe", async () => {
    invokeMock.mockResolvedValueOnce("/tmp/initial.md");
    listenMock.mockResolvedValueOnce(() => {});

    const backend = await loadTauri();
    const cb = vi.fn();
    backend.subscribeToOpenRequest(cb);
    await new Promise(r => setTimeout(r, 0));

    expect(invokeMock).toHaveBeenCalledWith("get_initial_path");
    expect(cb).toHaveBeenCalledWith("/tmp/initial.md");
  });

  it("subscribeToOpenRequest() does not deliver initial path after unsubscribe", async () => {
    // Hold the get_initial_path promise so we can resolve it after unsub.
    let resolveInitial: (v: string | null) => void = () => {};
    invokeMock.mockImplementationOnce(() =>
      new Promise<string | null>(res => { resolveInitial = res; })
    );
    listenMock.mockResolvedValueOnce(() => {});

    const backend = await loadTauri();
    const cb = vi.fn();
    const unsub = backend.subscribeToOpenRequest(cb);
    unsub();
    resolveInitial("/tmp/late.md");
    await new Promise(r => setTimeout(r, 0));

    expect(cb).not.toHaveBeenCalled();
  });

  it("subscribeToOpenRequest() does not deliver event payloads after unsubscribe", async () => {
    // Capture the event handler so we can fire it after unsubscribe.
    let captured: ((e: { payload: string }) => void) | null = null;
    listenMock.mockImplementationOnce((_event: string, handler: (e: { payload: string }) => void) => {
      captured = handler;
      return Promise.resolve(() => {});
    });
    invokeMock.mockResolvedValueOnce(null); // initial-path drain

    const backend = await loadTauri();
    const cb = vi.fn();
    const unsub = backend.subscribeToOpenRequest(cb);
    await new Promise(r => setTimeout(r, 0));
    unsub();
    // Simulate an event arriving in the queue after unsub.
    captured!({ payload: "/tmp/queued.md" });

    expect(cb).not.toHaveBeenCalled();
  });

  it("setTitle() invokes set_window_title", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const backend = await loadTauri();
    backend.setTitle("Doc — Gridpad");
    expect(invokeMock).toHaveBeenCalledWith("set_window_title", { title: "Doc — Gridpad" });
  });
});
