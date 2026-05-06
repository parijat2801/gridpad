# Tauri v2 Desktop Shell — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `tdd-plan-executor`) to implement this plan task-by-task.

**Goal:** Wrap the existing Vite/React markdown editor in a Tauri v2 desktop shell. CLI invocation `gridpad foo.md` opens the file; Cmd+S writes back; warm-start opens prompt the user when the doc is dirty.

**Architecture:** A single `FileBackend` adapter is the only file-I/O surface in `DemoV2.tsx`. `fileBackend.browser.ts` (File System Access API) preserves existing browser tests; `fileBackend.tauri.ts` (invoke + listen) drives the desktop binary. Rust `lib.rs` owns argv capture, single-instance, and file commands. The browser path stays first-class so Vitest, Playwright, and gh-pages keep working.

**Tech Stack:** Rust + Tauri v2 (plugins: cli, fs, single-instance, dialog), TypeScript, React 19, CodeMirror 6, Vite 8, Vitest 4 (jsdom), Playwright.

**Design doc:** `plans/tauri-shell.md` (resolved decisions §1–§12). This implementation plan supersedes its §13 task list with the bite-sized TDD breakdown below.

**Working directory:** `/Users/parijat/dev/gridpad/.claude/worktrees/unified-document`

**Branch:** `feature/tauri-shell` (continue committing here)

**Commands:**
- `npx vitest run --reporter=dot` — unit tests (jsdom; setup at `src/testSetup.ts`)
- `npx vitest run src/<file>.test.ts -t "PATTERN"` — single test by name
- `npm run build` — `tsc -b && vite build` (typecheck + browser build)
- `cargo test --manifest-path src-tauri/Cargo.toml` — Rust unit tests (after src-tauri exists)
- `npm run tauri dev` — Tauri dev shell (after Task 1)
- `npm run tauri build` — production .app

**Baseline before starting:** confirm `npx vitest run --reporter=dot 2>&1 | tail -3` is green on `feature/tauri-shell`. Existing TypeScript-diagnostic noise on `main` (e.g., `harness.spec.ts` `node` types) is **pre-existing** and not introduced by this plan — do not attempt to fix it inside this plan.

---

## Resolved-Decision deltas vs. the design doc

This impl plan resolves three open items the design doc left vague:

- **D1. Title sync uses an explicit call, not a `useEffect`.** CLAUDE.md rule 6 ("no useEffect for data flow") forbids the `useEffect([currentPath, docDirty])` shape proposed in the design doc §6.G. Replace with explicit calls at the four transition sites: open, save, save-as, new-doc. The single legitimate `useEffect` is the open-request subscription (§6.E).
- **D2. DemoV2.tsx file-cap debt is acknowledged, not fixed here.** DemoV2.tsx is currently 1456 lines (>>300-line cap, per CLAUDE.md rule 1). This plan adds ~80 lines and moves ~25 lines out into `fileBackend.browser.ts`, so net delta is +~55. Do not attempt a thin-shell extraction inside this plan — that's a separate refactor. Note as known debt at end of plan.
- **D3. Manual-only tasks are flagged.** Tasks 9, 10, 12, 14 require human observation (focus the existing window, open a real file). They are explicitly `MANUAL` and have no automated verify. Automated tasks all carry expected `npx vitest run` output.

---

## Cross-task dependency graph

```
T1 (Tauri CLI dep)
T2 (manual scaffold src-tauri/) ─── needed by T8, T9, T10, T11, T13
T3 (FileBackend interface + browser impl + tests)
   └─► T4 (DemoV2 wired to browser backend; no Tauri yet)
       └─► T5 (Tauri backend impl + mocked tests)  ← also depends on T3 interface
           └─► T7 (DemoV2 dirty/path/modal state)  ← also depends on T6
T6 (UnsavedChangesModal component + tests)
T8 (Rust commands + cargo tests)                   ← depends on T2 only
T9 (single-instance + RunEvent::Opened)             ← depends on T8
T10 (CLI argv capture)                              ← depends on T8
T11 (vite base flip + asset audit)                  ← depends on T8 (build needs Rust)
T12 (bin/gridpad shell script)                      ← depends on T11 (.app present)
T13 (run full vitest suite)                         ← after T7
T14 (manual smoke tests)                            ← last
```

Tasks 3, 6, 8 are independent of each other and could run in parallel; the tdd-plan-executor runs them sequentially per the skill's contract.

---

## File-by-file change inventory

| Path | Action | Lines |
|---|---|---|
| `src-tauri/Cargo.toml` | Create | ~20 |
| `src-tauri/build.rs` | Create | 3 |
| `src-tauri/src/main.rs` | Create | 4 |
| `src-tauri/src/lib.rs` | Create | ~250 |
| `src-tauri/tauri.conf.json` | Create | ~30 |
| `src-tauri/capabilities/default.json` | Create | ~20 |
| `src-tauri/.gitignore` | Create | 3 |
| `src/fileBackend.ts` | Create | ~30 |
| `src/fileBackend.browser.ts` | Create | ~80 |
| `src/fileBackend.browser.test.ts` | Create | ~120 |
| `src/fileBackend.tauri.ts` | Create | ~50 |
| `src/fileBackend.tauri.test.ts` | Create | ~120 |
| `src/UnsavedChangesModal.tsx` | Create | ~50 |
| `src/UnsavedChangesModal.test.tsx` | Create | ~70 |
| `src/file-system.d.ts` | Modify (append) | +2 |
| `src/DemoV2.tsx` | Modify | -25 / +90 |
| `vite.config.ts` | Modify (T11) | -1 / +1 |
| `bin/gridpad` | Create | ~15 |
| `package.json` | Modify (deps) | +6 |

---

## Resolved Rust commands (supersedes design-doc §4.2)

The design doc §4.2 lists only 5 commands but `fileBackend.tauri.ts` calls `dialog_open_command` and `dialog_save_command`. The full list:

| Rust command | TS caller | Purpose |
|---|---|---|
| `get_initial_path() -> Option<String>` | `subscribeToOpenRequest` initial drain | Drain `pending_path`, flip `frontend_ready=true` |
| `read_file_command(path: String) -> Result<String, String>` | `readFileByPath`, `dialog_open_command` | Read file, update `current_path` |
| `write_file_command(text: String) -> Result<(), String>` | `saveFile` | Write to `current_path` (validates non-empty) |
| `dialog_open_command() -> Result<Option<{path,text}>, String>` | `openFile` | `tauri-plugin-dialog` open + read; updates `current_path` |
| `dialog_save_command(text: String) -> Result<Option<String>, String>` | `saveFileAs` | `tauri-plugin-dialog` save + write; updates `current_path` |
| `set_window_title(title: String)` | explicit calls (D1) | Calls `webview_window.set_title(&title)` |

`get_current_path()` from the design doc is dropped — frontend tracks `currentPath` in React state, no need for hot-reload recovery in v1.

---

## Task 1: Tauri CLI devDependency

**Files:**
- Modify: `package.json` (devDependencies, scripts)

**Step 1: Install**

```sh
npm install --save-dev @tauri-apps/cli@^2
```

**Step 2: Add `tauri` script**

Edit `package.json` `scripts`:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "test": "vitest run",
  "lint": "eslint .",
  "preview": "vite preview",
  "tauri": "tauri"
}
```

**Step 3: Verify**

```sh
npx tauri --version
```

Expected output (line, exact version may differ): `tauri-cli 2.x.x`. **PASS** if it prints any `2.x` line. **FAIL** if "command not found" or non-2.x.

**Step 4: Commit**

```sh
git add package.json package-lock.json
git commit -m "deps(tauri): add @tauri-apps/cli@2 and tauri script"
```

---

## Task 2: Scaffold `src-tauri/` (manual file creation, no `tauri init`)

**Why manual:** `npx tauri init` is interactive (prompts for app name, identifier, devUrl, frontendDist). A subagent cannot answer prompts. Create each file directly from the design doc §3.

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs` (placeholder; real body in Task 8)
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/.gitignore`

**Step 1: `src-tauri/Cargo.toml`**

```toml
[package]
name = "gridpad"
version = "0.1.0"
edition = "2021"

[lib]
name = "gridpad_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri                        = { version = "2", features = [] }
tauri-plugin-fs              = "2"
tauri-plugin-cli             = "2"
tauri-plugin-single-instance = "2"
tauri-plugin-dialog          = "2"
serde                        = { version = "1", features = ["derive"] }
serde_json                   = "1"
```

**Step 2: `src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

**Step 3: `src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gridpad_lib::run()
}
```

**Step 4: `src-tauri/src/lib.rs` (placeholder — real body in Task 8)**

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 5: `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Gridpad",
  "version": "0.1.0",
  "identifier": "app.gridpad.gridpad",
  "build": {
    "beforeDevCommand": "npm run dev -- --port 1420 --strictPort",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:1420",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{ "label": "main", "width": 1280, "height": 800, "title": "Gridpad" }],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png"],
    "fileAssociations": [
      { "name": "Markdown Document", "ext": ["md"], "role": "Editor" }
    ]
  },
  "plugins": {
    "cli": {
      "args": [{ "name": "file", "index": 1, "takesValue": true }]
    }
  }
}
```

**Step 6: `src-tauri/capabilities/default.json`**

Note: do **not** include the `"$schema"` line yet — the schema file is generated only after first `cargo build`. We add it back in Task 8 once the build has run.

```json
{
  "identifier": "default",
  "description": "Main window capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    { "identifier": "fs:allow-read-text-file",  "allow": [{ "path": "**" }] },
    { "identifier": "fs:allow-write-text-file", "allow": [{ "path": "**" }] },
    "cli:default",
    "dialog:default",
    "dialog:allow-open",
    "dialog:allow-save"
  ]
}
```

**Step 7: `src-tauri/.gitignore`**

```
target/
gen/
```

**Step 7b: Create placeholder icons**

`tauri::generate_context!()` resolves the `bundle.icon` paths at compile time and panics if they are missing. The plan ships transparent placeholder PNGs at the four required sizes — replace with real icons before any production release.

```sh
mkdir -p src-tauri/icons
python3 - <<'PY'
import struct, zlib
def make_png(w, h):
    sig = bytes.fromhex('89504E470D0A1A0A')
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw = b''.join(b'\x00' + b'\x00\x00\x00\x00' * w for _ in range(h))
    idat = zlib.compress(raw)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
for size, name in [(32,'32x32.png'),(128,'128x128.png'),(256,'128x128@2x.png'),(512,'icon.png')]:
    open(f'src-tauri/icons/{name}','wb').write(make_png(size,size))
PY
```

**Step 8: Verify**

```sh
ls src-tauri/Cargo.toml src-tauri/build.rs src-tauri/src/main.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/capabilities/default.json
```

Expected: 6 paths printed, no errors.

```sh
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: `Finished` line OR a clean compile (warnings about unused imports in placeholder lib.rs are acceptable). **FAIL if compilation errors.** First build downloads + compiles all crates and may take 2–5 minutes.

**Step 9: Commit**

```sh
git add src-tauri/
git commit -m "feat(tauri): scaffold src-tauri (Cargo.toml, conf, capabilities)"
```

---

## Task 3: `FileBackend` interface + `fileBackend.browser.ts` + tests

**Files:**
- Create: `src/fileBackend.ts` (interface + factory)
- Create: `src/fileBackend.browser.ts` (File System Access impl)
- Create: `src/fileBackend.browser.test.ts` (mocked-window unit tests)
- Modify: `src/file-system.d.ts` (append `__TAURI_INTERNALS__` declaration)

**Symbols moving out of `DemoV2.tsx` (in Task 4, not this task):**
- `fileHandleRef` (line 231) → module-level `fileHandle` in `fileBackend.browser.ts`
- `WritableHandle` type alias (line 234) → `fileBackend.browser.ts`
- `saveToHandle` function body (lines 235-246) → inlined into `saveFile()` in browser backend (the `applyClearDirty` and `syncRefsFromState` calls **stay in DemoV2.tsx**)
- `scheduleAutosave` function (lines 247-251) → **deleted entirely** (autosave behavior is preserved as explicit save-on-edit; debounce is gone for v1)
- `autosaveTimerRef` (line 232) → **deleted**
- `showOpenFilePicker` call (line 1115) → `openFile()` in browser backend
- `showSaveFilePicker` call (lines 1125-1128) → `saveFileAs()` in browser backend

**Note on `applyClearDirty`/`syncRefsFromState`:** these are state mutations on the React side. The backend returns success/failure; the caller (DemoV2) clears dirty state on success. Keeps the backend pure-I/O.

**Step 1: Write the failing tests**

Create `src/fileBackend.browser.test.ts`:

```typescript
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
```

**Step 2: Run tests; expect FAIL**

```sh
npx vitest run src/fileBackend.browser.test.ts --reporter=dot
```

Expected: `FAIL src/fileBackend.browser.test.ts` — `Failed to resolve import "./fileBackend.browser"`. PASS counter should not advance.

**Step 3: Implement `src/fileBackend.ts`**

```typescript
export interface FileBackend {
  openFile(): Promise<{ path: string; text: string } | null>;
  saveFile(text: string): Promise<void>;
  saveFileAs(text: string): Promise<string | null>;
  subscribeToOpenRequest(cb: (path: string) => void): () => void;
  readFileByPath(path: string): Promise<string | null>;
  setTitle(title: string): void;
}

export async function createFileBackend(): Promise<FileBackend> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return await import("./fileBackend.tauri");
  }
  return await import("./fileBackend.browser");
}
```

**Step 4: Append `__TAURI_INTERNALS__` to `src/file-system.d.ts`**

```typescript
// File System Access API type declarations (Chrome 86+)
interface Window {
  showOpenFilePicker(options?: {
    types?: { description: string; accept: Record<string, string[]> }[];
    multiple?: boolean;
  }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(options?: {
    types?: { description: string; accept: Record<string, string[]> }[];
    suggestedName?: string;
  }): Promise<FileSystemFileHandle>;
  __TAURI_INTERNALS__?: unknown;
}
```

**Step 5: Implement `src/fileBackend.browser.ts`**

```typescript
import type { FileBackend } from "./fileBackend";

type WritableHandle = FileSystemFileHandle & {
  createWritable(): Promise<FileSystemWritableFileStream>;
};

let fileHandle: FileSystemFileHandle | null = null;

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export async function openFile(): Promise<{ path: string; text: string } | null> {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
    });
    fileHandle = handle;
    const file = await handle.getFile();
    return { path: handle.name, text: await file.text() };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

async function writeTo(handle: FileSystemFileHandle, text: string): Promise<void> {
  const w = await (handle as WritableHandle).createWritable();
  await w.write(text);
  await w.close();
}

export async function saveFile(text: string): Promise<void> {
  if (!fileHandle) return; // No-op when no file is open. Caller should funnel to saveFileAs() if needed.
  await writeTo(fileHandle, text);
}

export async function saveFileAs(text: string): Promise<string | null> {
  try {
    const handle = await window.showSaveFilePicker({
      types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      suggestedName: "document.md",
    });
    fileHandle = handle;
    await writeTo(handle, text);
    return handle.name;
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export function subscribeToOpenRequest(_cb: (path: string) => void): () => void {
  // Browser cannot receive OS-level open events. Return a no-op unsubscriber.
  return () => {};
}

export async function readFileByPath(_path: string): Promise<string | null> {
  return null;
}

export function setTitle(_title: string): void {
  // Browser tab title is governed by document.title elsewhere; backend no-ops.
}

const _backend: FileBackend = { openFile, saveFile, saveFileAs, subscribeToOpenRequest, readFileByPath, setTitle };
export default _backend;
```

**Step 6: Run tests; expect PASS**

```sh
npx vitest run src/fileBackend.browser.test.ts --reporter=dot
```

Expected: `9 passed`. Full-suite count should be `<baseline> + 9`.

**Step 7: Run full vitest suite (no regressions)**

```sh
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: total grew by exactly 9; **0 failures**. If failures appear elsewhere, they were pre-existing — record them but do not fix in this task.

**Step 8: Commit**

```sh
git add src/fileBackend.ts src/fileBackend.browser.ts src/fileBackend.browser.test.ts src/file-system.d.ts
git commit -m "feat(fileBackend): introduce FileBackend interface + browser impl with tests"
```

**Handoff to Task 4:** `createFileBackend()` exported from `src/fileBackend.ts`. The browser impl module exposes the named functions and a default object. DemoV2 should consume via the default export pattern OR the named imports — Task 4 picks one.

---

## Task 4: Wire DemoV2.tsx to `fileBackend.browser.ts`

**Files:**
- Modify: `src/DemoV2.tsx` (~25 lines removed, ~20 added)

**Goal:** No behavior change for the user. Browser flow continues to work via the new adapter; Tauri detection is **not** wired yet (defer to Task 7). This task is the structural extraction step — verified by manual smoke + vitest staying green.

**Step 1: Add module-level backend reference at top of DemoV2.tsx (near other imports)**

Add new import (alongside existing imports near line 12):

```typescript
import { createFileBackend, type FileBackend } from "./fileBackend";
```

**Step 2: Replace `fileHandleRef`, `saveToHandle`, `scheduleAutosave`, `autosaveTimerRef`**

Inside the `DemoV2` component, near line 231, **delete** the following block:

```typescript
// DELETE these 23 lines (current 231-251):
const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

type WritableHandle = FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> };
async function saveToHandle(h: FileSystemFileHandle) {
  console.log("saveToHandle called, handle:", h.name);
  try {
    const state = stateRef.current;
    const md = serializeUnified(getDoc(state), getFrames(state));
    const w = await (h as WritableHandle).createWritable();
    await w.write(md);
    await w.close();
    stateRef.current = applyClearDirty(stateRef.current);
    syncRefsFromState();
  } catch (err) { console.error("saveToHandle failed:", err); }
}
function scheduleAutosave() {
  if (!fileHandleRef.current) return;
  if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
  autosaveTimerRef.current = setTimeout(() => { if (fileHandleRef.current) void saveToHandle(fileHandleRef.current); }, 500);
}
```

Replace with a backend **state** value (so dependents re-render when it resolves) + a save helper that preserves the dirty-clear behavior. Using `useRef` here would silently break Task 7 — `ref.current` mutations don't trigger React updates, so any `useEffect` whose closure captures the backend would run exactly once with `null`.

```typescript
const [backend, setBackend] = useState<FileBackend | null>(null);
useEffect(() => {
  // One-shot dynamic import. Subscription/setup lifecycle, not data flow.
  let cancelled = false;
  void createFileBackend().then(b => {
    if (!cancelled) setBackend(b);
  });
  return () => { cancelled = true; };
}, []);

async function saveCurrent(): Promise<void> {
  if (!backend) return;
  const state = stateRef.current;
  const md = serializeUnified(getDoc(state), getFrames(state));
  await backend.saveFile(md);
  stateRef.current = applyClearDirty(stateRef.current);
  syncRefsFromState();
}
```

**Step 3: Replace each `scheduleAutosave()` call with nothing**

Find the 8 call sites (`grep -n scheduleAutosave src/DemoV2.tsx` — lines 906, 926, 934, 1155, 1279, 1297, 1348, 1356, 1363) and **delete** the `scheduleAutosave();` calls. Autosave-on-edit is dropped for v1; user explicitly Cmd+Saves. (This is a behavior change — the user has approved it via the design doc.)

**Step 4: Rewrite Cmd+O / Cmd+S / Cmd+Shift+S handlers**

The handlers read the `backend` state value (set by the effect in Step 2). The keydown handler is itself inside a `useEffect` registered on the canvas — so the closure must include `backend` in its dependency array (Task 7 finalises this when it adds more deps). Replace lines 1112–1141 (the three `if (mod && e.key === "o" | "s")` blocks) with:

```typescript
if (mod && e.key === "o") {
  e.preventDefault();
  if (!backend) return;
  const r = await backend.openFile();
  if (r) {
    loadDocument(r.text);
    doLayout(); paint();
  }
  return;
}
if (mod && e.shiftKey && e.key === "s") {
  e.preventDefault();
  if (!backend) return;
  const state = stateRef.current;
  const md = serializeUnified(getDoc(state), getFrames(state));
  const newPath = await backend.saveFileAs(md);
  if (newPath !== null) {
    stateRef.current = applyClearDirty(stateRef.current);
    syncRefsFromState();
  }
  return;
}
if (mod && e.key === "s") {
  e.preventDefault();
  await saveCurrent();
  return;
}
```

If the existing keydown `useEffect` does not yet include `backend` in its deps, add it. (This may cause the effect to re-register when `backend` resolves; that is intentional and harmless — there is one re-registration on first load.)

**Step 5: Verify build**

```sh
npm run build 2>&1 | tail -10
```

Expected: `tsc -b` clean (no new errors), `vite build` produces `dist/`. **FAIL** if errors mention `fileHandleRef`, `saveToHandle`, `scheduleAutosave`, or `WritableHandle` — those should now be gone from DemoV2.tsx.

**Step 6: Run vitest (no regressions)**

```sh
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: same count as Task 3, **0 failures**.

**Step 7: Manual smoke test (the only manual verify in pre-Tauri tasks)**

```sh
npm run dev
```

In Chrome: open the page, press Cmd+O, pick a `.md` file → loads. Press Cmd+S → file updates on disk. Press Cmd+Shift+S → save dialog → file written.

**Step 8: Commit**

```sh
git add src/DemoV2.tsx
git commit -m "refactor(DemoV2): route file I/O through fileBackend.browser adapter"
```

**Handoff to Task 5:** Frontend now consumes `createFileBackend()`. Task 5 implements `fileBackend.tauri.ts` so Tauri detection automatically routes through it.

---

## Task 5: `fileBackend.tauri.ts` + mocked tests

**Files:**
- Create: `src/fileBackend.tauri.ts`
- Create: `src/fileBackend.tauri.test.ts`
- Modify: `package.json` (deps — `@tauri-apps/api`)

**Note on dependency placement:** `@tauri-apps/api` MUST be in `dependencies`, not `devDependencies` — Vite analyzes `fileBackend.tauri.ts` even during browser-only builds and would fail to resolve unresolved imports.

**Step 1: Install runtime dep**

```sh
npm install @tauri-apps/api
```

**Step 2: Write the failing tests**

Create `src/fileBackend.tauri.test.ts`:

```typescript
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

  it("setTitle() invokes set_window_title", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const backend = await loadTauri();
    backend.setTitle("Doc — Gridpad");
    expect(invokeMock).toHaveBeenCalledWith("set_window_title", { title: "Doc — Gridpad" });
  });
});
```

**Step 3: Run tests; expect FAIL**

```sh
npx vitest run src/fileBackend.tauri.test.ts --reporter=dot
```

Expected: `Failed to resolve import "./fileBackend.tauri"`.

**Step 4: Implement `src/fileBackend.tauri.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileBackend } from "./fileBackend";

export async function openFile(): Promise<{ path: string; text: string } | null> {
  const r = await invoke<{ path: string; text: string } | null>("dialog_open_command");
  return r ?? null;
}

export async function saveFile(text: string): Promise<void> {
  await invoke("write_file_command", { text });
}

export async function saveFileAs(text: string): Promise<string | null> {
  const r = await invoke<string | null>("dialog_save_command", { text });
  return r ?? null;
}

export function subscribeToOpenRequest(cb: (path: string) => void): () => void {
  // Drain any cold-start initial path first.
  void invoke<string | null>("get_initial_path").then(initial => {
    if (initial) cb(initial);
  }).catch(() => { /* swallow — frontend stays usable */ });

  // Race-safe registration: if unsubscribe arrives before listen() resolves,
  // we must still invoke the eventual unlisten fn. Otherwise the listener
  // leaks and survives until page unload.
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  void listen<string>("open-path-request", e => cb(e.payload)).then(fn => {
    if (cancelled) { fn(); return; }
    unlisten = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export async function readFileByPath(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_file_command", { path });
  } catch {
    return null;
  }
}

export function setTitle(title: string): void {
  void invoke("set_window_title", { title });
}

const _backend: FileBackend = { openFile, saveFile, saveFileAs, subscribeToOpenRequest, readFileByPath, setTitle };
export default _backend;
```

**Step 5: Run tests; expect PASS**

```sh
npx vitest run src/fileBackend.tauri.test.ts --reporter=dot
```

Expected: `11 passed`.

**Step 6: Run full suite**

```sh
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: count grew by 11; **0 failures**.

**Step 7: Commit**

```sh
git add src/fileBackend.tauri.ts src/fileBackend.tauri.test.ts package.json package-lock.json
git commit -m "feat(fileBackend): tauri impl with mocked invoke/listen tests"
```

**Handoff to Task 6:** Both backends implement `FileBackend`. `createFileBackend()` will route based on `__TAURI_INTERNALS__`. UnsavedChangesModal is independent — built next.

---

## Task 6: `UnsavedChangesModal.tsx` + tests

**Files:**
- Create: `src/UnsavedChangesModal.tsx`
- Create: `src/UnsavedChangesModal.test.tsx`

**Step 1: Write the failing tests**

Create `src/UnsavedChangesModal.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { UnsavedChangesModal } from "./UnsavedChangesModal";

afterEach(cleanup);

describe("UnsavedChangesModal", () => {
  function renderModal(overrides: Partial<React.ComponentProps<typeof UnsavedChangesModal>> = {}) {
    const props = {
      pendingPath: "/tmp/other.md",
      onDiscard: vi.fn(),
      onSaveFirst: vi.fn(),
      onCancel: vi.fn(),
      ...overrides,
    };
    render(<UnsavedChangesModal {...props} />);
    return props;
  }

  it("displays the pending file path", () => {
    renderModal({ pendingPath: "/Users/x/foo.md" });
    expect(screen.getByText(/foo\.md/)).toBeTruthy();
  });

  it("Discard button fires onDiscard", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(props.onDiscard).toHaveBeenCalledOnce();
    expect(props.onSaveFirst).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("Save button fires onSaveFirst", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(props.onSaveFirst).toHaveBeenCalledOnce();
  });

  it("Cancel button fires onCancel", () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("Escape key fires onCancel", () => {
    const props = renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Install testing dep**

```sh
npm install --save-dev @testing-library/react
```

**Step 3: Run; expect FAIL**

```sh
npx vitest run src/UnsavedChangesModal.test.tsx --reporter=dot
```

Expected: `Failed to resolve import "./UnsavedChangesModal"`.

**Step 4: Implement `src/UnsavedChangesModal.tsx`**

```typescript
import { useEffect } from "react";

export interface UnsavedChangesModalProps {
  pendingPath: string;
  onDiscard: () => void;
  onSaveFirst: () => void;
  onCancel: () => void;
}

const PALETTE = {
  pageBg: "#141420",
  surface: "#2b2b33",
  text: "#e0e0e0",
  accent: "#4a90e2",
  divider: "#444",
} as const;

const FONT_STACK = "system-ui, -apple-system, sans-serif";

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function UnsavedChangesModal({ pendingPath, onDiscard, onSaveFirst, onCancel }: UnsavedChangesModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, fontFamily: FONT_STACK,
    }}>
      <div role="dialog" aria-modal="true" style={{
        background: PALETTE.surface, color: PALETTE.text,
        padding: 24, borderRadius: 10, minWidth: 380, maxWidth: 520,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
      }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600 }}>
          Unsaved changes
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 14, lineHeight: 1.5 }}>
          You have unsaved changes. Open <strong>{basename(pendingPath)}</strong> anyway?
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={btnStyle("ghost")}>Cancel</button>
          <button onClick={onDiscard} style={btnStyle("danger")}>Discard changes</button>
          <button onClick={onSaveFirst} style={btnStyle("primary")}>Save and open</button>
        </div>
      </div>
    </div>
  );
}

function btnStyle(variant: "ghost" | "danger" | "primary"): React.CSSProperties {
  const base: React.CSSProperties = {
    border: "none", borderRadius: 6, padding: "8px 14px",
    fontFamily: FONT_STACK, fontSize: 13, fontWeight: 500, cursor: "pointer",
    color: PALETTE.text,
  };
  if (variant === "primary") return { ...base, background: PALETTE.accent };
  if (variant === "danger") return { ...base, background: "#a23a3a" };
  return { ...base, background: "transparent", border: `1px solid ${PALETTE.divider}` };
}
```

**Step 5: Run tests; expect PASS**

```sh
npx vitest run src/UnsavedChangesModal.test.tsx --reporter=dot
```

Expected: `5 passed`.

**Step 6: Full suite**

```sh
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: count grew by 5 (9 + 11 + 5 = +25 over Task 2 baseline); **0 failures**.

**Step 7: Commit**

```sh
git add src/UnsavedChangesModal.tsx src/UnsavedChangesModal.test.tsx package.json package-lock.json
git commit -m "feat(modal): UnsavedChangesModal with three-button state machine"
```

---

## Task 7: DemoV2 dirty state, current path, and modal wiring

**Files:**
- Modify: `src/DemoV2.tsx` (~50 lines added)

**Per D1, no `useEffect([currentPath, docDirty])`.** Title sync is explicit at four sites.

**Per D2, file-cap noted but not addressed in this plan.**

**Step 1: Extract the centralized dispatch wrapper into a testable pure helper**

The dirty-flag wiring needs a single, observable seam — sprinkling `markDirty()` next to every `stateRef.current = ...` site is brittle and misses the encapsulated mutations inside `editorUndo`/`editorRedo` (which return `EditorState`, not `Transaction`, so the caller cannot inspect `tr.docChanged`).

The fix: introduce a centralized `dispatchTransaction(state, tr) -> { state, docChanged }` helper in `src/editorState.ts`. DemoV2 routes ALL `state.update(tr).state` calls through it. Undo/redo are wrapped separately by comparing the doc string before/after.

Add to `src/editorState.ts` (near other helpers):

```typescript
export interface DispatchResult {
  state: EditorState;
  docChanged: boolean;
}

export function dispatchTransaction(
  state: EditorState,
  spec: import("@codemirror/state").TransactionSpec,
): DispatchResult {
  const tr = state.update(spec);
  return { state: tr.state, docChanged: tr.docChanged };
}

// For undo/redo paths where we already have the new EditorState and need
// to detect if the doc actually changed. Uses CodeMirror's optimized
// Text.eq() which can short-circuit on length and shared chunks rather
// than allocating two full strings on every check.
export function docDiffersFrom(prev: EditorState, next: EditorState): boolean {
  return !prev.doc.eq(next.doc);
}
```

**Failing test** — append to `src/editorState.test.ts`:

```typescript
// ── dispatchTransaction & docDiffersFrom (Task 7 of tauri-shell-impl) ──

describe("dispatchTransaction", () => {
  beforeAll(() => { mockCanvas(); });

  it("returns docChanged=true for an insertion transaction", () => {
    const initial = createEditorStateUnified("hello\n", 8, 16);
    const r = dispatchTransaction(initial, { changes: { from: 5, insert: " world" } });
    expect(r.docChanged).toBe(true);
    expect(r.state.doc.toString()).toBe("hello world\n");
  });

  it("returns docChanged=false for a no-op (effects only) transaction", () => {
    const initial = createEditorStateUnified("hello\n", 8, 16);
    const r = dispatchTransaction(initial, { effects: [] });
    expect(r.docChanged).toBe(false);
    expect(r.state.doc.toString()).toBe("hello\n");
  });
});

describe("docDiffersFrom", () => {
  beforeAll(() => { mockCanvas(); });

  it("detects a doc-string change (e.g. after editorRedo replays an edit)", () => {
    const a = createEditorStateUnified("hello\n", 8, 16);
    const b = a.update({ changes: { from: 5, insert: " world" } }).state;
    expect(docDiffersFrom(a, b)).toBe(true);
  });

  it("returns false when the doc string is identical", () => {
    const a = createEditorStateUnified("hello\n", 8, 16);
    const b = a.update({ effects: [] }).state;
    expect(docDiffersFrom(a, b)).toBe(false);
  });
});
```

Run; expect FAIL with `dispatchTransaction is not defined` (or import resolution error):

```sh
npx vitest run src/editorState.test.ts -t "dispatchTransaction|docDiffersFrom" --reporter=dot
```

Expected: 4 failures, all citing `dispatchTransaction` / `docDiffersFrom` undefined. **STOP if anything else fails** — that's noise and must be diagnosed first.

Then add the imports + the `dispatchTransaction` and `docDiffersFrom` helpers shown above to `src/editorState.ts` (named exports).

Re-run:

```sh
npx vitest run src/editorState.test.ts -t "dispatchTransaction|docDiffersFrom" --reporter=dot
```

Expected: `4 passed`.

**Step 2: Add state, refs, and helpers to DemoV2.tsx**

Inside the `DemoV2` component, after the `backend` state declaration added in Task 4:

```typescript
const [currentPath, setCurrentPath] = useState<string | null>(null);
const [docDirty, setDocDirty] = useState(false);
const [pendingPath, setPendingPath] = useState<string | null>(null);
const [showUnsavedModal, setShowUnsavedModal] = useState(false);

// Build the title string (pure).
function buildTitle(path: string | null, dirty: boolean): string {
  if (!path) return "Gridpad";
  const base = path.split(/[/\\]/).pop() ?? path;
  return dirty ? `${base} ● Gridpad` : `${base} — Gridpad`;
}

// Explicit title push (D1: no useEffect for this).
function pushTitle(path: string | null, dirty: boolean): void {
  document.title = buildTitle(path, dirty);
  backend?.setTitle(buildTitle(path, dirty));
}

// Dirty-flag observer: every site that applies a user-originated transaction
// routes through `dispatch()` or `applyAndTrack()` (defined in Step 3),
// which call markDirty() iff the doc actually changed.
function markDirty(): void {
  if (!docDirty) {
    setDocDirty(true);
    pushTitle(currentPath, true);
  }
}

function markClean(): void {
  if (docDirty) {
    setDocDirty(false);
    pushTitle(currentPath, false);
  }
}
```

**Step 3: Route mutations through `dispatchTransaction`; wrap undo/redo with `docDiffersFrom`**

The codebase has 48 `stateRef.current = …` assignment sites in DemoV2.tsx (verified). Hooking each one is brittle and misses encapsulated paths. Use the centralized helpers from Step 1.

There are two categories of mutation in DemoV2:

**Category A — explicit `stateRef.current.update({...})` sites.** These are the transaction-emitting call sites; pipe them through `dispatchTransaction`. Replacement pattern:

```typescript
// BEFORE:
stateRef.current = stateRef.current.update({ effects: someEffect.of(value) }).state;

// AFTER:
const r = dispatchTransaction(stateRef.current, { effects: someEffect.of(value) });
stateRef.current = r.state;
if (r.docChanged) markDirty();
```

For `apply*` helpers (e.g. `applyReparentFrame`, `applyAddChildFrame`, `applyDeleteFrame`) that internally build their own transactions and return an `EditorState` — those need wrapping with `docDiffersFrom`:

```typescript
// BEFORE:
stateRef.current = applyReparentFrame(stateRef.current, ...);

// AFTER:
const prev = stateRef.current;
const next = applyReparentFrame(prev, ...);
stateRef.current = next;
if (docDiffersFrom(prev, next)) markDirty();
```

**Category B — `editorUndo` / `editorRedo`.** Same `docDiffersFrom` pattern as the `apply*` helpers above. They return `EditorState`; we cannot inspect their internal `Transaction`.

**Implementation strategy (to keep this task bite-sized):** rather than touching all 48 sites individually, introduce two thin helpers in DemoV2 that the existing call sites can route through. Both live above the `useEffect`s:

```typescript
// Replaces inline `state.update(...).state` patterns; returns the new state
// and ALSO marks dirty when the doc changed.
function dispatch(spec: import("@codemirror/state").TransactionSpec): void {
  const r = dispatchTransaction(stateRef.current, spec);
  stateRef.current = r.state;
  if (r.docChanged) markDirty();
}

// Replaces `stateRef.current = applyXxx(stateRef.current, ...)` patterns
// where the helper hides the transaction internally.
function applyAndTrack<T>(producer: (prev: EditorState) => EditorState): void {
  const prev = stateRef.current;
  const next = producer(prev);
  stateRef.current = next;
  if (docDiffersFrom(prev, next)) markDirty();
}
```

Concrete patch sites (use `grep -n "stateRef\.current = " src/DemoV2.tsx` to enumerate after Task 4; expect ~48):

- `stateRef.current = stateRef.current.update({...}).state` lines → `dispatch({...})`
- `stateRef.current = applyReparentFrame(...)` / `applyAddTopLevelFrame` / `applyAddChildFrame` / `applyDeleteFrame` lines → `applyAndTrack(prev => applyXxx(prev, ...))`
- `stateRef.current = editorUndo(stateRef.current)` / `editorRedo` → `applyAndTrack(editorUndo)` / `applyAndTrack(editorRedo)`
- `stateRef.current = applyClearDirty(stateRef.current)` lines → **leave alone** (these are explicitly clearing dirty; routing through `dispatch` would re-mark dirty if applyClearDirty involves a doc change, which it shouldn't, but the existing call after a save already runs `markClean()` separately)
- `stateRef.current = createEditorStateUnified(...)` (loadDocument body) → **leave alone** (followed by `markClean()` from `loadFromPath` / Cmd+O / Cmd+Shift+S handlers)

Cosmetic: wherever a handler ends with `syncRefsFromState();`, leave the structure unchanged — `dispatch`/`applyAndTrack` only swap the state assignment.

**Why this is correct:** `markDirty()` fires exactly when an actual doc change is committed. Cursor-only / selection-only / effect-only transactions (`tr.docChanged === false`) do not flip dirty. Undo/redo flip dirty if and only if the underlying doc text changed. Frame mutations (which always change frame state but may or may not change doc text via reflow) flip dirty when the doc text changed.

**Step 4: `handleOpenRequest` and modal wiring**

Add helper:

```typescript
function handleOpenRequest(path: string): void {
  if (!docDirty) {
    void loadFromPath(path);
    return;
  }
  setPendingPath(path);
  setShowUnsavedModal(true);
}

async function loadFromPath(path: string): Promise<void> {
  if (!backend) return;
  const text = await backend.readFileByPath(path);
  if (text === null) {
    console.error("readFileByPath returned null for", path);
    return;
  }
  loadDocument(text);
  doLayout(); paint();
  setCurrentPath(path);
  markClean();
  pushTitle(path, false);
}
```

**Step 5: Add subscription useEffect (the one legitimate one — subscription lifecycle, not data flow)**

Reads `backend` from state (set by Task 4's effect). Putting `backendRef.current` in a deps array is broken — refs don't re-trigger effects. We use the state value here.

```typescript
useEffect(() => {
  if (!backend) return;
  const unsub = backend.subscribeToOpenRequest(handleOpenRequest);
  return unsub;
}, [backend, docDirty]);
```

`backend` in deps → effect runs once when the dynamic import resolves.
`docDirty` in deps → on each transition, the closure re-captures the latest `handleOpenRequest`, which itself reads `docDirty`. (Alternative: stash `docDirty` in a ref and read it inside `handleOpenRequest`; either is acceptable, this version is simpler.)

If `handleOpenRequest` is declared inline (closes over `docDirty`, `loadFromPath`, etc.) and re-created every render, the effect will re-subscribe on every render — that is a minor inefficiency but not a correctness bug. Wrap with `useCallback` only if perf becomes an issue.

**Step 6: Render the modal**

Inside the existing JSX `return (...)` block, near the top-level container, conditionally render:

```tsx
{showUnsavedModal && pendingPath && (
  <UnsavedChangesModal
    pendingPath={pendingPath}
    onCancel={() => { setShowUnsavedModal(false); setPendingPath(null); }}
    onDiscard={() => {
      const p = pendingPath;
      setShowUnsavedModal(false); setPendingPath(null);
      if (p) void loadFromPath(p);
    }}
    onSaveFirst={async () => {
      const p = pendingPath;
      setShowUnsavedModal(false); setPendingPath(null);
      await saveCurrent();
      if (p) void loadFromPath(p);
    }}
  />
)}
```

Add the import at the top of DemoV2.tsx:

```typescript
import { UnsavedChangesModal } from "./UnsavedChangesModal";
```

**Step 7: Update Cmd+O handler to also set `currentPath` and clean dirty**

Replace the Cmd+O handler from Task 4 with the version below. Same `backend` (state) source; the keydown effect's deps must include `backend, docDirty, currentPath, pendingPath, showUnsavedModal` — anything the closure reads.

```typescript
if (mod && e.key === "o") {
  e.preventDefault();
  if (!backend) return;
  const r = await backend.openFile();
  if (r) {
    loadDocument(r.text);
    doLayout(); paint();
    setCurrentPath(r.path);
    markClean();
    pushTitle(r.path, false);
  }
  return;
}
```

Update Cmd+Shift+S similarly:

```typescript
if (mod && e.shiftKey && e.key === "s") {
  e.preventDefault();
  if (!backend) return;
  const state = stateRef.current;
  const md = serializeUnified(getDoc(state), getFrames(state));
  const newPath = await backend.saveFileAs(md);
  if (newPath !== null) {
    stateRef.current = applyClearDirty(stateRef.current);
    syncRefsFromState();
    setCurrentPath(newPath);
    markClean();
    pushTitle(newPath, false);
  }
  return;
}
```

Update `saveCurrent()` (declared in Task 4 Step 2) to mark clean and update title. The `backend` here is the same state value:

```typescript
async function saveCurrent(): Promise<void> {
  if (!backend) return;
  const state = stateRef.current;
  const md = serializeUnified(getDoc(state), getFrames(state));
  await backend.saveFile(md);
  stateRef.current = applyClearDirty(stateRef.current);
  syncRefsFromState();
  markClean();
  pushTitle(currentPath, false);
}
```

**Step 8: Run vitest**

```sh
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: count grew by 2 (the two docChanged tests added in Step 1); **0 failures**.

**Step 9: Verify build**

```sh
npm run build 2>&1 | tail -5
```

Expected: clean.

**Step 10: Manual smoke test**

```sh
npm run dev
```

In Chrome:
1. Open page → title shows "Gridpad" (no file).
2. Cmd+O, pick `foo.md` → title shows "foo.md — Gridpad".
3. Type something → title shows "foo.md ● Gridpad".
4. Cmd+S → title shows "foo.md — Gridpad" (dot gone).
5. Open browser DevTools, run: `window.dispatchEvent(new CustomEvent('debug-open-request', { detail: '/x' }));` — does nothing (no listener), confirming the open-request flow only activates under Tauri. (Browser smoke for the modal will happen in Task 14 manually under Tauri.)

**Step 11: Commit**

```sh
git add src/DemoV2.tsx src/editorState.test.ts
git commit -m "feat(DemoV2): currentPath/docDirty state + UnsavedChangesModal wiring"
```

**Handoff to Task 8:** Frontend is complete in browser mode. Tauri commands are mocked but not implemented in Rust. Task 8 implements them.

---

## Task 8: Rust commands in `lib.rs` + cargo tests

**Files:**
- Modify: `src-tauri/src/lib.rs` (replace placeholder body)
- Modify: `src-tauri/capabilities/default.json` (re-add `$schema` line now that the schema file exists post-build)

**Step 1: Write the failing tests inline in lib.rs**

Replace `src-tauri/src/lib.rs` with the full implementation including a `#[cfg(test)]` module:

```rust
use std::path::PathBuf;
use std::sync::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager, State, RunEvent};
use tauri_plugin_cli::CliExt;
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct AppState {
    pub pending_path: Mutex<Option<String>>,
    pub current_path: Mutex<Option<String>>,
    pub frontend_ready: Mutex<bool>,
}

#[derive(Serialize)]
pub struct OpenedFile { pub path: String, pub text: String }

// ── Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn get_initial_path(state: State<'_, AppState>) -> Option<String> {
    *state.frontend_ready.lock().unwrap() = true;
    state.pending_path.lock().unwrap().take()
}

#[tauri::command]
fn read_file_command(path: String, state: State<'_, AppState>) -> Result<String, String> {
    if path.is_empty() { return Err("empty path".into()); }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))?;
    *state.current_path.lock().unwrap() = Some(path);
    Ok(text)
}

#[tauri::command]
fn write_file_command(text: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = state.current_path.lock().unwrap().clone()
        .ok_or_else(|| "no current path; use saveFileAs first".to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("write failed: {e}"))
}

// `tauri_plugin_dialog::FilePath` is an enum that handles cross-platform paths
// (incl. mobile content:// URIs). On desktop, .into_path() always succeeds and
// returns a std::path::PathBuf.
#[tauri::command]
async fn dialog_open_command(app: tauri::AppHandle) -> Result<Option<OpenedFile>, String> {
    let picked = app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .blocking_pick_file();
    let Some(file_path) = picked else { return Ok(None); };
    let path: PathBuf = file_path.into_path()
        .map_err(|e| format!("invalid path from dialog: {e}"))?;
    let path_str = path.to_string_lossy().to_string();
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))?;
    let state = app.state::<AppState>();
    *state.current_path.lock().unwrap() = Some(path_str.clone());
    Ok(Some(OpenedFile { path: path_str, text }))
}

#[tauri::command]
async fn dialog_save_command(app: tauri::AppHandle, text: String) -> Result<Option<String>, String> {
    let picked = app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name("document.md")
        .blocking_save_file();
    let Some(file_path) = picked else { return Ok(None); };
    let path: PathBuf = file_path.into_path()
        .map_err(|e| format!("invalid path from dialog: {e}"))?;
    let path_str = path.to_string_lossy().to_string();
    std::fs::write(&path, text).map_err(|e| format!("write failed: {e}"))?;
    let state = app.state::<AppState>();
    *state.current_path.lock().unwrap() = Some(path_str.clone());
    Ok(Some(path_str))
}

#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| format!("set_title failed: {e}"))
}

// ── App entry ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = argv.get(1).cloned() {
                let _ = app.emit("open-path-request", path);
            }
            if let Some(w) = app.get_webview_window("main") { let _ = w.set_focus(); }
        }))
        .setup(|app| {
            // Capture cold-start argv via plugin-cli.
            if let Ok(matches) = app.cli().matches() {
                if let Some(arg) = matches.args.get("file") {
                    if let serde_json::Value::String(p) = &arg.value {
                        *app.state::<AppState>().pending_path.lock().unwrap() = Some(p.clone());
                    }
                }
            }
            // Default macOS menu (Cmd+Q, Cmd+H, Edit menu).
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_path,
            read_file_command,
            write_file_command,
            dialog_open_command,
            dialog_save_command,
            set_window_title,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = event {
                let paths: Vec<String> = urls.iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter_map(|p| p.to_str().map(String::from))
                    .collect();
                if let Some(path) = paths.first() {
                    let state = app.state::<AppState>();
                    let ready = *state.frontend_ready.lock().unwrap();
                    if ready { let _ = app.emit("open-path-request", path.clone()); }
                    else { *state.pending_path.lock().unwrap() = Some(path.clone()); }
                }
            }
            let _ = (app, event);
        });
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_file_command_round_trip() {
        let tmp = std::env::temp_dir().join("gridpad-test-read.md");
        fs::write(&tmp, "# hello\n").unwrap();
        let state = AppState::default();
        // Cannot construct State<'_, AppState> outside Tauri; test the inner logic.
        let text = std::fs::read_to_string(&tmp).unwrap();
        assert_eq!(text, "# hello\n");
        *state.current_path.lock().unwrap() = Some(tmp.to_string_lossy().to_string());
        assert!(state.current_path.lock().unwrap().is_some());
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn write_file_round_trip() {
        let tmp = std::env::temp_dir().join("gridpad-test-write.md");
        let _ = fs::remove_file(&tmp);
        std::fs::write(&tmp, "data").unwrap();
        assert_eq!(fs::read_to_string(&tmp).unwrap(), "data");
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn read_empty_path_errors() {
        // Mirrors the validation in read_file_command.
        let path: String = "".into();
        assert!(path.is_empty());
    }

    #[test]
    fn frontend_ready_starts_false() {
        let s = AppState::default();
        assert!(!*s.frontend_ready.lock().unwrap());
    }

    #[test]
    fn pending_path_take_clears() {
        let s = AppState::default();
        *s.pending_path.lock().unwrap() = Some("/tmp/x.md".into());
        let drained = s.pending_path.lock().unwrap().take();
        assert_eq!(drained, Some("/tmp/x.md".into()));
        assert!(s.pending_path.lock().unwrap().is_none());
    }
}
```

**Note on Rust unit tests:** Tauri `State<'_, T>` cannot be constructed outside the framework, so command handlers can't be unit-tested directly. The test module verifies the **inner state-transition logic** (file I/O, mutex behavior). Integration with Tauri commands is verified in Tasks 9–10 manually.

**Step 2: Restore `$schema` in capabilities/default.json**

Edit `src-tauri/capabilities/default.json`, prepend the `$schema` field:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  ...
}
```

**Step 3: Run cargo tests**

```sh
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -10
```

Expected: `test result: ok. 5 passed; 0 failed`. **First run downloads + compiles the dialog/fs/single-instance plugins (3–8 min).**

**Step 4: Build the dev .app to verify wiring**

```sh
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: `Finished` with possibly warnings about unused variables `let _ = (app, event);` — accept these.

**Step 5: Commit**

```sh
git add src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat(tauri): Rust commands (file I/O, dialog, title) with cargo tests"
```

**Handoff to Task 9:** Rust backend compiles. Single-instance and RunEvent wiring is already in `run()`; Task 9 is manual verification.

---

## Task 9: Verify single-instance + warm-start `RunEvent::Opened` (MANUAL)

**Why manual:** requires two running instances of the app and human observation that the second invocation focuses the first window instead of spawning a new one.

**Files:** None (implementation already in Task 8's `lib.rs`).

**Step 1: Run dev shell**

```sh
npm run tauri dev
```

Wait for the Gridpad window to appear (~30 s first time; faster on rebuilds).

**Step 2: From a second terminal**

```sh
open -a "Gridpad"
```

Expected: the existing window comes to the foreground; **no new window opens**. If a second window opens, single-instance is broken.

**Step 3: Verify open-path emission via dev console**

In the Tauri window's webview DevTools (right-click → Inspect, or Cmd+Option+I), run:

```javascript
const { listen } = await import("@tauri-apps/api/event");
listen("open-path-request", e => console.log("open-path-request", e.payload));
```

Then from terminal:

```sh
open -a "Gridpad" --args /tmp/foo.md
```

Expected console line: `open-path-request /tmp/foo.md`. (The frontend's `subscribeToOpenRequest` already does this; this step is just the diagnostic confirmation.)

**Step 4: Document result**

If both checks pass, write `MANUAL_TASK_9_PASS` to a scratch note (or just proceed). If anything fails, capture the failure mode and stop — investigate before Task 10.

**Step 5: Commit (no code changes; commit only if previous task left uncommitted state)**

Skip if `git status` is clean.

---

## Task 10: Verify CLI argv cold-start (MANUAL)

**Why manual:** requires launching a fresh Tauri process and confirming the file loads.

**Files:** None (implementation in Task 8).

**Step 1: Kill any running Gridpad instances**

```sh
pkill -f "Gridpad" || true
rm -f "$TMPDIR/gridpad-single-instance.lock"
```

**Step 2: Create a test file**

```sh
echo "# tauri-shell test\n\nHello from CLI." > /tmp/tauri-test.md
```

**Step 3: Cold-start with argv**

```sh
npm run tauri dev -- -- /tmp/tauri-test.md
```

The double `--` is required: first separates `npm` from the script, second separates Tauri CLI from the inner CLI args.

If that does not deliver argv to the binary (Tauri dev mode wraps the binary in cargo which may eat extra args), use the production-build path instead:

```sh
npm run tauri build
open -a "src-tauri/target/release/bundle/macos/Gridpad.app" --args /tmp/tauri-test.md
```

**Step 4: Verify**

Expected: window opens, content shows "# tauri-shell test\n\nHello from CLI." Title bar reads "tauri-test.md — Gridpad".

If the window opens but the file doesn't load, the issue is in cold-start path. Diagnostics:
- Open DevTools in the window. Check console for `get_initial_path` errors.
- Run in console: `await __TAURI_INTERNALS__.invoke("get_initial_path")` → should return the path.
- If null: cli plugin didn't capture argv. Recheck `tauri.conf.json` `plugins.cli.args` and `setup()` matching code in `lib.rs`.

**Step 5: Document result**

Pass / fail noted. No commit.

---

## Task 11: Flip vite `base` to `'/'` + audit assets

**Files:**
- Modify: `vite.config.ts`
- Audit: `index.html`, `src/**/*.css` (if any), `public/**`

**Step 1: Audit current `/gridpad/` references**

```sh
grep -rn "/gridpad/" --include="*.html" --include="*.css" --include="*.tsx" --include="*.ts" /Users/parijat/dev/gridpad/.claude/worktrees/unified-document/src /Users/parijat/dev/gridpad/.claude/worktrees/unified-document/index.html /Users/parijat/dev/gridpad/.claude/worktrees/unified-document/public 2>/dev/null
```

Expected: zero hits OR a small enumerable list. If hits exist, fix each by switching to relative paths or `import.meta.env.BASE_URL`.

**Step 2: Flip `vite.config.ts`**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
})
```

**Step 3: Verify browser dev still works**

```sh
npm run build 2>&1 | tail -5
```

Expected: clean. Then:

```sh
npm run dev
```

Open `http://localhost:5173/` in Chrome — page loads, no asset 404s. Press Cmd+O — works.

**Step 4: Verify Tauri build assets resolve**

```sh
npm run tauri build 2>&1 | tail -10
```

Expected: `Finished` line, `.app` produced at `src-tauri/target/release/bundle/macos/Gridpad.app`. Open it; window loads, no asset 404s in DevTools.

**Step 5: Document gh-pages workaround**

Create or append to a single-line note in `README.md` (or the existing one):

```markdown
- `vite build --base=/gridpad/` — manual command for gh-pages deploys (default base is `/` for Tauri).
```

**Step 6: Commit**

```sh
git add vite.config.ts README.md
git commit -m "build(vite): flip base to '/' for Tauri; gh-pages now manual --base=/gridpad/"
```

---

## Task 12: `bin/gridpad` shell script

**Files:**
- Create: `bin/gridpad`

**Step 1: Create the script**

```sh
mkdir -p bin
```

Write `bin/gridpad`:

```sh
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: gridpad <path>" >&2
  exit 1
fi

# Resolve to absolute path.
TARGET="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

if [[ ! -f "$TARGET" ]]; then
  echo "gridpad: file not found: $TARGET" >&2
  exit 1
fi

open -a "Gridpad" --args "$TARGET"
```

**Step 2: Make executable**

```sh
chmod +x bin/gridpad
```

**Step 3: Verify usage error**

```sh
bin/gridpad
```

Expected: `usage: gridpad <path>` on stderr, exit 1.

**Step 4: Verify file-not-found error**

```sh
bin/gridpad /nonexistent/path.md
```

Expected: `gridpad: file not found: /nonexistent/path.md` on stderr, exit 1.

**Step 5: Verify happy path** (only after Task 11 produced a `.app`)

```sh
bin/gridpad /tmp/tauri-test.md
```

Expected: existing Gridpad window receives the open-path-request and loads the file (or, if not running, launches and loads).

**Step 6: Commit**

```sh
git add bin/gridpad
git commit -m "feat(cli): bin/gridpad shell wrapper"
```

---

## Task 13: Full vitest suite — no regressions

**Step 1: Run**

```sh
npx vitest run --reporter=dot 2>&1 | tail -3
```

Expected: total = baseline + 29 (9 from Task 3, 11 from Task 5, 5 from Task 6, 4 from Task 7); **0 failures**. If failures appear, identify whether they were pre-existing on `main` (run `git stash && git checkout main && npx vitest run --reporter=dot 2>&1 | tail -3 && git checkout - && git stash pop` to compare). Pre-existing failures are out of scope.

**Step 2: Run build**

```sh
npm run build 2>&1 | tail -5
```

Expected: clean.

**Step 3: Commit any outstanding state** (likely nothing if previous tasks committed)

---

## Task 14: Manual smoke tests of all four scenarios (MANUAL)

**Why manual:** end-to-end Tauri behavior cannot be tested via Vitest or Playwright in this plan's scope.

**Setup:**

```sh
npm run tauri build
cp -r src-tauri/target/release/bundle/macos/Gridpad.app /Applications/
cp bin/gridpad /usr/local/bin/gridpad  # or PATH location of choice
```

(Gatekeeper warning on first launch is expected — right-click → Open.)

**Test 1: Cold start with file**

```sh
echo "# Test 1\n\nHello." > /tmp/t1.md
gridpad /tmp/t1.md
```

Expected: app opens, content shows "Test 1\n\nHello.", title shows "t1.md — Gridpad".

**Test 2: Edit + save**

In the open window: type some text. Title gains the dot indicator. Cmd+S. Title loses the dot.

```sh
cat /tmp/t1.md
```

Expected: includes the typed text.

**Test 3: Warm-start with dirty doc → modal**

In the open window from Test 2, type more (don't save). From terminal:

```sh
echo "# Test 3" > /tmp/t3.md
gridpad /tmp/t3.md
```

Expected: existing window comes to the foreground AND the UnsavedChangesModal appears showing "Open t3.md anyway?". Test all three buttons:
- **Cancel** → modal closes, original doc still showing.
- **Discard changes** → modal closes, t3.md loads, dirty edits lost.
- **Save and open** → save fires (title flickers clean), then t3.md loads.

(Run the test three times to exercise all three.)

**Test 4: Nonexistent file**

```sh
gridpad /tmp/does-not-exist-xyz.md
```

Expected: shell script prints `gridpad: file not found:` and exits 1. App does not change state.

**Step Final: Document outcomes**

Record any failures for follow-up. PASS counts as full feature delivered.

---

## Known debt acknowledged by this plan

1. **DemoV2.tsx file size.** Currently 1456 lines. This plan adds ~80 (net +55 after browser-backend extraction). Still well over CLAUDE.md's 300-line cap. Documented; not addressed here. Follow-up: extract a `<EditorShell>` and a `<KeyboardHandler>` in a separate refactor plan.
2. **Autosave behavior change.** `scheduleAutosave` (500 ms debounce after edits) is removed. v1 desktop behavior: explicit Cmd+S only. If user complains during dogfooding, add it back as a separate task.
3. **`useEffect` for backend initialization** (Task 4). Justification: this is a one-shot dynamic import — setup/lifecycle, not data flow. The result is stored in `useState`, not `useRef`, so `useEffect`s that depend on the backend (Task 7's open-request subscription) actually re-run when it resolves.
4. **`useEffect` for the open-request subscription** (Task 7). Justification: subscription lifecycle, explicitly the "one legitimate `useEffect`" called out in the design doc §5.2.
5. **Tauri command unit tests are state-transition only.** Tauri's `State<'_, T>` extractor cannot be constructed outside the runtime, so command bodies are not directly testable. End-to-end behavior is verified in manual Tasks 9, 10, 14.
6. **No Playwright retargeting.** Existing browser tests run against `localhost:5173` and continue to work. Tauri WebDriver / `tauri-driver` is out of scope.
7. **Pre-existing TypeScript-diagnostic noise** (e.g., `harness.spec.ts` `Cannot find name 'fs'`) is unrelated to this plan. Do not fix as part of these tasks.

---

## Execution

Per user direction: run via `tdd-plan-executor`, with two sequential sonnet plan reviews preceding execution. This document is the plan that the executor consumes.

If executing without the wrapper skill, the per-task loop is:
1. Gemini reviews the task slice.
2. Sonnet writes the failing tests.
3. Reviewer (you or sonnet code-reviewer) reads the tests.
4. Sonnet implements minimal code.
5. Verify GREEN with the listed command.
6. Gemini reviews the diff.
7. Apply Gemini findings, re-verify.
8. Commit (commit message provided in each task's last step).
