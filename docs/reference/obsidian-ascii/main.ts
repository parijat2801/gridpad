import { Plugin, WorkspaceLeaf } from "obsidian";
import { AsciiCanvasView, VIEW_TYPE_ASCII_CANVAS } from "./AsciiCanvasView";
import { TFile } from "obsidian";

const MD_FENCE = "```ascii";

function extractAsciiBlock(raw: string): string {
  const idx = raw.indexOf(MD_FENCE);
  if (idx === -1) return raw.trimEnd();
  const afterFence = raw.slice(idx + MD_FENCE.length).replace(/^\r?\n/, "");
  const endIdx = afterFence.indexOf("\n```");
  const block = endIdx === -1 ? afterFence : afterFence.slice(0, endIdx);
  return block.trimEnd();
}

export default class AsciiCanvasPlugin extends Plugin {
  onload() {
    this.registerView(
      VIEW_TYPE_ASCII_CANVAS,
      (leaf: WorkspaceLeaf) => new AsciiCanvasView(leaf, this.app)
    );
    this.registerExtensions(["ascii"], VIEW_TYPE_ASCII_CANVAS);

    this.registerMarkdownPostProcessor((el, ctx) => {
      el.querySelectorAll<HTMLElement>(".internal-embed").forEach((embedEl) => {
        const src = embedEl.getAttribute("src") ?? embedEl.querySelector("a.internal-link")?.getAttribute("data-href") ?? "";
        if (!src) return;
        const dest = this.app.metadataCache.getFirstLinkpathDest(src, ctx.sourcePath);
        if (!(dest instanceof TFile) || dest.extension !== "ascii") return;
        const filePath = dest.path;
        const sourcePath = ctx.sourcePath;
        void this.app.vault.adapter.read(filePath).then((raw) => {
          const text = extractAsciiBlock(raw);
          embedEl.empty();
          const wrapper = embedEl.createDiv({ cls: "ascii-canvas-embed-wrapper" });
          const pre = wrapper.createEl("pre", { cls: "ascii-canvas-embed" });
          pre.setText(text);
          const openLink = wrapper.createEl("a", { cls: "ascii-canvas-embed-open" });
          openLink.href = "#";
          openLink.textContent = "Open";
          openLink.setAttribute("title", "Open in ASCII canvas");
          openLink.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            void this.app.workspace.openLinkText(filePath, sourcePath, false);
          });
        }).catch(() => {});
      });
    }, 100);

    this.addRibbonIcon("pencil", "New ASCII canvas", () => void this.createNewCanvas());

    this.addCommand({
      id: "new",
      name: "New canvas",
      callback: () => void this.createNewCanvas(),
    });
    this.addCommand({
      id: "undo",
      name: "Undo",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(AsciiCanvasView);
        if (view) {
          if (!checking) view.undo();
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "redo",
      name: "Redo",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(AsciiCanvasView);
        if (view) {
          if (!checking) view.redo();
          return true;
        }
        return false;
      },
    });
  }

  async createNewCanvas(): Promise<void> {
    const folder = this.app.fileManager.getNewFileParent("");
    const name = `ASCII Canvas ${Date.now()}.ascii`;
    const path = folder.path ? `${folder.path}/${name}` : name;
    const file = await this.app.vault.create(path, "");
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_ASCII_CANVAS,
      state: { file: file.path },
    });
    void this.app.workspace.revealLeaf(leaf);
  }
}
