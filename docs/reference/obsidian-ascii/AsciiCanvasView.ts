import { App, ItemView, TFile, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_ASCII_CANVAS = "ascii-canvas-view";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 60;
const MIN_COLS = 10;
const MAX_COLS = 200;
const MIN_ROWS = 10;
const MAX_ROWS = 100;
const BLANK = " ";
const MAX_HISTORY = 50;
const MD_HEADER = "# ASCII Canvas";
const MD_FENCE = "```ascii";
const BRUSH_RADIUS = 2;
const SPRAY_RADIUS = 4;
const SPRAY_DOTS = 10;
const FONT_W = 5;
const FONT_H = 7;
const FONT_SPACING = 1;

const BLOCK_FONT_5X7: Record<string, string[]> = {
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
  "0": [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "  ## ", " #   ", "#    ", "#####"],
  "3": [" ### ", "#   #", "    #", "  ## ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#    ", "#### ", "    #", "#   #", " ### "],
  "6": [" ### ", "#   #", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#    "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "#   #", " ### "],
  "A": ["  #  ", " # # ", "#   #", "#   #", "#####", "#   #", "#   #"],
  "B": ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  "C": [" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "],
  "D": ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
  "E": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  "F": ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  "G": [" ### ", "#   #", "#    ", "#  ##", "#   #", "#   #", " ####"],
  "H": ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  "I": [" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "J": ["    #", "    #", "    #", "    #", "    #", "#   #", " ### "],
  "K": ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
  "L": ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  "M": ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"],
  "N": ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
  "O": [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  "P": ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  "Q": [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
  "R": ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  "S": [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  "T": ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  "U": ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  "V": ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  "W": ["#   #", "#   #", "#   #", "#   #", "# # #", "## ##", "#   #"],
  "X": ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  "Y": ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  "Z": ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
};

type Tool = "pencil" | "line" | "rect" | "diamond" | "ellipse" | "triangle" | "fill" | "brush" | "spray" | "erase" | "select" | "wordart";

export class AsciiCanvasView extends ItemView {
  navigation = true;
  private filePath: string | null = null;
  private lines: string[] = [];
  private tool: Tool = "pencil";
  private drawChar = ".";
  private isDrawing = false;
  private lastCell: { row: number; col: number } | null = null;
  private lastHoverCell: { row: number; col: number } | null = null;
  private gridEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private undoStack: string[][] = [];
  private redoStack: string[][] = [];
  private selection: { rMin: number; rMax: number; cMin: number; cMax: number } | null = null;
  private isSelecting = false;
  private selectStart: { row: number; col: number } | null = null;
  private isMoving = false;
  private moveBuffer: string[] = [];
  private moveOrigin: { row: number; col: number } | null = null;
  private moveOffset: { row: number; col: number } = { row: 0, col: 0 };
  private moveUnderContent: string[] = [];
  private previewBase: string[] | null = null;
  private clipboard: string[] = [];
  private wordArtInput: HTMLInputElement | null = null;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;

  constructor(leaf: WorkspaceLeaf, _app: App) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ASCII_CANVAS;
  }

  getDisplayText(): string {
    if (this.filePath) {
      const f = this.app.vault.getAbstractFileByPath(this.filePath);
      return f instanceof TFile ? f.name : "ASCII canvas";
    }
    return "ASCII canvas";
  }

  getState(): { file?: string } {
    return this.filePath ? { file: this.filePath } : {};
  }

  async setState(state: { file?: string; path?: string }, result: { history: boolean }): Promise<void> {
    this.filePath = state.file ?? state.path ?? null;
    await super.setState(state, result);
    if (this.gridEl && this.filePath) {
      await this.loadFile();
      this.renderGrid();
      this.updateStatus();
    }
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass("ascii-canvas-view");
    container.empty();

    const toolbar = container.createDiv({ cls: "ascii-canvas-toolbar" });
    const sizeWrap = toolbar.createDiv({ cls: "ascii-tool-size-wrap" });
    const colsInput = sizeWrap.createEl("input", {
      cls: "tool-size",
      attr: { type: "number", min: String(MIN_COLS), max: String(MAX_COLS), value: String(this.cols), title: "Columns" },
    });
    sizeWrap.createSpan({ cls: "ascii-tool-size-sep", text: "x" });
    const rowsInput = sizeWrap.createEl("input", {
      cls: "tool-size",
      attr: { type: "number", min: String(MIN_ROWS), max: String(MAX_ROWS), value: String(this.rows), title: "Rows" },
    });
    const applySize = () => {
      const c = Math.max(MIN_COLS, Math.min(MAX_COLS, parseInt(colsInput.value, 10) || DEFAULT_COLS));
      const r = Math.max(MIN_ROWS, Math.min(MAX_ROWS, parseInt(rowsInput.value, 10) || DEFAULT_ROWS));
      colsInput.value = String(c);
      rowsInput.value = String(r);
      if (c !== this.cols || r !== this.rows) this.resizeCanvas(c, r);
    };
    colsInput.addEventListener("change", applySize);
    rowsInput.addEventListener("change", applySize);
    toolbar.createEl("span", { cls: "ascii-tool-sep" });
    const undoBtn = toolbar.createEl("button", { cls: "ascii-tool-btn" });
    undoBtn.createSpan({ cls: "ascii-tool-icon", text: "<-" });
    undoBtn.setAttribute("title", "Undo");
    undoBtn.addEventListener("click", () => this.undo());
    const redoBtn = toolbar.createEl("button", { cls: "ascii-tool-btn" });
    redoBtn.createSpan({ cls: "ascii-tool-icon", text: "->" });
    redoBtn.setAttribute("title", "Redo");
    redoBtn.addEventListener("click", () => this.redo());
    toolbar.createEl("span", { cls: "ascii-tool-sep" });
    const charWrap = toolbar.createDiv({ cls: "ascii-tool-char-wrap" });
    const charInput = charWrap.createEl("input", {
      cls: "tool-char",
      attr: { type: "text", maxlength: "1", value: this.drawChar, title: "Draw character" },
    });
    charInput.addEventListener("input", () => {
      const v = charInput.value;
      this.drawChar = v.length > 0 ? v[v.length - 1] : BLANK;
    });
    toolbar.createEl("span", { cls: "ascii-tool-sep" });
    const addToolBtn = (icon: string, title: string, tool: Tool) => {
      const btn = toolbar.createEl("button", { cls: "ascii-tool-btn" });
      btn.createSpan({ cls: "ascii-tool-icon", text: icon });
      btn.setAttribute("title", title);
      btn.addEventListener("click", () => {
        this.tool = tool;
        toolbar.querySelectorAll(".ascii-tool-btn").forEach((b) => (b as HTMLElement).classList.remove("active"));
        btn.classList.add("active");
        if (tool === "erase" || tool === "wordart") this.clearSelection();
        this.updateStatus();
      });
      return btn;
    };
    const pencilBtn = addToolBtn(".", "Pencil", "pencil");
    addToolBtn("/", "Line", "line");
    addToolBtn("#", "Rect", "rect");
    addToolBtn("<>", "Diamond", "diamond");
    addToolBtn("()", "Circle", "ellipse");
    addToolBtn("^", "Triangle", "triangle");
    addToolBtn("~", "Fill", "fill");
    addToolBtn("O", "Brush", "brush");
    addToolBtn("..", "Spray", "spray");
    addToolBtn("x", "Erase", "erase");
    addToolBtn("[]", "Select", "select");
    addToolBtn("Aa", "Word art", "wordart");
    const wordArtWrap = toolbar.createDiv({ cls: "ascii-tool-char-wrap" });
    this.wordArtInput = wordArtWrap.createEl("input", {
      cls: "tool-char tool-wordart",
      attr: { type: "text", placeholder: "Text", title: "Word art text" },
    });
    toolbar.createEl("span", { cls: "ascii-tool-sep" });
    const saveBtn = toolbar.createEl("button", { cls: "ascii-tool-btn" });
    saveBtn.createSpan({ cls: "ascii-tool-icon", text: "[S]" });
    saveBtn.setAttribute("title", "Save");
    saveBtn.addEventListener("click", () => this.flushSave());
    pencilBtn.classList.add("active");

    const wrap = container.createDiv({ cls: "ascii-canvas-wrap" });
    this.gridEl = wrap.createDiv({ cls: "ascii-canvas-grid" });
    this.gridEl.tabIndex = 0;

    this.statusEl = container.createDiv({ cls: "ascii-canvas-status" });

    await this.loadFile();
    if (!this.filePath && this.leaf) {
      const vs = this.leaf.getViewState();
      const path = (vs?.state as { file?: string; path?: string } | undefined)?.file ?? (vs?.state as { file?: string; path?: string } | undefined)?.path;
      if (path) {
        this.filePath = path;
        await this.loadFile();
      }
    }
    this.renderGrid();
    this.attachPointerEvents();
    this.registerScopeKeys();
    this.registerKeydown();
    this.registerDeactivateSave();
    this.updateStatus();
  }

  private registerDeactivateSave(): void {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.app.workspace.getActiveViewOfType(AsciiCanvasView) !== this && this.filePath) {
          if (this.saveTimeout !== null) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
          }
          void this.doSave(this.getContent());
        }
      })
    );
  }

  private registerKeydown(): void {
    const handler = (e: KeyboardEvent) => {
      if (this.app.workspace.getActiveViewOfType(AsciiCanvasView) !== this) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && key === "c") {
        e.preventDefault();
        e.stopPropagation();
        this.copy();
        return;
      }
      if (mod && key === "x") {
        e.preventDefault();
        e.stopPropagation();
        this.cut();
        return;
      }
      if (mod && key === "v") {
        e.preventDefault();
        e.stopPropagation();
        this.paste();
        return;
      }
      if (mod && key === "s") {
        e.preventDefault();
        e.stopPropagation();
        this.flushSave();
        return;
      }
    };
    this.registerDomEvent(document, "keydown", handler, true);
  }

  private copy(): void {
    if (!this.selection) return;
    this.clipboard = this.getSelectionContent();
  }

  private cut(): void {
    if (!this.selection) return;
    const { rMin, rMax, cMin, cMax } = this.selection;
    this.pushUndo();
    this.clipboard = this.getSelectionContent();
    this.clearRegion(rMin, rMax, cMin, cMax);
    this.selection = null;
    this.renderGrid();
    this.scheduleSave();
  }

  private paste(): void {
    if (this.clipboard.length === 0) return;
    const h = this.clipboard.length;
    const w = this.clipboard[0]?.length ?? 0;
    if (w <= 0) return;
    this.pushUndo();
    let r0: number;
    let c0: number;
    if (this.selection) {
      r0 = this.selection.rMin;
      c0 = this.selection.cMin;
    } else {
      r0 = 0;
      c0 = 0;
    }
    r0 = Math.max(0, Math.min(r0, this.rows - h));
    c0 = Math.max(0, Math.min(c0, this.cols - w));
    this.pasteAt(r0, c0, this.clipboard);
    this.selection = { rMin: r0, rMax: r0 + h - 1, cMin: c0, cMax: c0 + w - 1 };
    this.renderGrid();
    this.scheduleSave();
  }

  async onClose(): Promise<void> {
    if (this.saveTimeout !== null) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.doSave(this.getContent());
  }

  private async loadFile(): Promise<void> {
    if (!this.filePath) {
      this.lines = this.emptyGrid();
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) {
      this.lines = this.emptyGrid();
      return;
    }
    try {
      const raw = await this.app.vault.read(file);
      const fence = MD_FENCE;
      const idx = raw.indexOf(fence);
      if (idx >= 0) {
        const beforeFence = raw.slice(0, idx);
        const sizeMatch = beforeFence.match(/^\s*(\d+)\s+(\d+)\s*$/m);
        if (sizeMatch) {
          const c = Math.max(MIN_COLS, Math.min(MAX_COLS, parseInt(sizeMatch[1], 10) || DEFAULT_COLS));
          const r = Math.max(MIN_ROWS, Math.min(MAX_ROWS, parseInt(sizeMatch[2], 10) || DEFAULT_ROWS));
          this.cols = c;
          this.rows = r;
          const sizeInputs = this.contentEl.querySelectorAll<HTMLInputElement>(".tool-size");
          if (sizeInputs[0]) sizeInputs[0].value = String(this.cols);
          if (sizeInputs[1]) sizeInputs[1].value = String(this.rows);
        }
      }
      const gridLines = this.parseMdFormat(raw);
      this.lines = [];
      for (let r = 0; r < this.rows; r++) {
        const row = gridLines[r] ?? "";
        const padded = row.slice(0, this.cols).padEnd(this.cols, BLANK);
        this.lines.push(padded);
      }
    } catch {
      this.lines = this.emptyGrid();
    }
  }

  private parseMdFormat(raw: string): string[] {
    const fence = MD_FENCE;
    const idx = raw.indexOf(fence);
    if (idx === -1) {
      const row = BLANK.repeat(this.cols);
      return Array(this.rows).fill(row) as string[];
    }
    const afterFence = raw.slice(idx + fence.length).replace(/^\r?\n/, "");
    const endIdx = afterFence.indexOf("\n```");
    const block = endIdx === -1 ? afterFence : afterFence.slice(0, endIdx);
    const inputLines = block.split(/\r?\n/);
    const out: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const row = inputLines[r] ?? "";
      out.push(row.slice(0, this.cols).padEnd(this.cols, BLANK));
    }
    return out;
  }

  private emptyGrid(): string[] {
    const row = BLANK.repeat(this.cols);
    return Array(this.rows).fill(row) as string[];
  }

  private resizeCanvas(newCols: number, newRows: number): void {
    if (newCols === this.cols && newRows === this.rows) return;
    const oldCols = this.cols;
    this.cols = newCols;
    this.rows = newRows;
    const newLines: string[] = [];
    for (let r = 0; r < newRows; r++) {
      const oldRow = this.lines[r] ?? BLANK.repeat(oldCols);
      const trimmed = oldRow.slice(0, newCols);
      newLines.push(trimmed.padEnd(newCols, BLANK));
    }
    this.lines = newLines;
    this.clearSelection();
    this.renderGrid();
    this.updateStatus();
    this.scheduleSave();
  }

  private renderGrid(): void {
    if (!this.gridEl) return;
    this.gridEl.empty();
    for (let r = 0; r < this.rows; r++) {
      const rowEl = this.gridEl.createDiv();
      for (let c = 0; c < this.cols; c++) {
        const cls = "ascii-canvas-cell" + (this.isSelected(r, c) ? " ascii-canvas-cell-selected" : "");
        const cell = rowEl.createSpan({
          cls,
          attr: { "data-row": String(r), "data-col": String(c) },
        });
        cell.setText(this.lines[r]?.[c] ?? BLANK);
      }
    }
  }

  private attachPointerEvents(): void {
    if (!this.gridEl) return;
    this.registerDomEvent(this.gridEl, "pointerdown", (e: PointerEvent) => {
      const cell = this.getCellFromEvent(e);
      if (!cell) return;
      if (this.tool === "select") {
        if (this.selection && this.isInsideSelection(cell.row, cell.col) && !this.isMoving) {
          this.startMove(cell);
        } else {
          this.clearSelection();
          this.isSelecting = true;
          this.selectStart = cell;
          this.selection = { rMin: cell.row, rMax: cell.row, cMin: cell.col, cMax: cell.col };
          this.renderGrid();
        }
        return;
      }
      if (this.isMoving) return;
      if (this.tool === "fill") {
        this.pushUndo();
        this.floodFill(cell.row, cell.col);
        this.renderGrid();
        this.scheduleSave();
        return;
      }
      if (this.tool === "wordart") {
        const text = (this.wordArtInput?.value ?? "").trim().toUpperCase();
        if (text) {
          this.pushUndo();
          this.drawWordArt(cell.row, cell.col, text);
          this.renderGrid();
          this.scheduleSave();
        }
        return;
      }
      this.isDrawing = true;
      this.lastCell = cell;
      this.lastHoverCell = cell;
      const shapeTools: Tool[] = ["rect", "line", "diamond", "ellipse", "triangle"];
      if (shapeTools.includes(this.tool)) {
        this.previewBase = this.cloneLines();
      } else {
        if (this.tool === "pencil" || this.tool === "erase" || this.tool === "brush" || this.tool === "spray") {
          this.pushUndo();
        }
        if (this.tool === "brush") {
          this.applyToolBrushSize(cell.row, cell.col);
        } else if (this.tool === "spray") {
          this.applySpray(cell.row, cell.col);
        } else {
          this.applyTool(cell.row, cell.col);
        }
      }
      this.renderGrid();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    });
    this.registerDomEvent(document, "pointermove", (e: PointerEvent) => {
      const cell = this.getCellFromEvent(e) ?? this.getCellFromCoords(e.clientX, e.clientY);
      if (this.isSelecting && this.selectStart && cell) {
        const rMin = Math.min(this.selectStart.row, cell.row);
        const rMax = Math.max(this.selectStart.row, cell.row);
        const cMin = Math.min(this.selectStart.col, cell.col);
        const cMax = Math.max(this.selectStart.col, cell.col);
        this.selection = { rMin, rMax, cMin, cMax };
        this.renderGrid();
        return;
      }
      if (this.isMoving && this.moveOrigin !== null && this.moveBuffer.length > 0) {
        const cellForMove = cell ?? this.lastHoverCell;
        if (cellForMove) {
          const h = this.moveBuffer.length;
          const w = this.moveBuffer[0]?.length ?? 0;
          const newR0 = Math.max(0, Math.min(cellForMove.row - this.moveOffset.row, this.rows - h));
          const newC0 = Math.max(0, Math.min(cellForMove.col - this.moveOffset.col, this.cols - w));
          this.pasteAt(this.moveOrigin.row, this.moveOrigin.col, this.moveUnderContent);
          this.moveUnderContent = this.getContentAt(newR0, newC0, h, w);
          this.moveOrigin = { row: newR0, col: newC0 };
          this.pasteAt(this.moveOrigin.row, this.moveOrigin.col, this.moveBuffer);
          this.renderGrid();
        }
        return;
      }
      if (!this.isDrawing) return;
      if (!cell) return;
      if (this.lastCell && (this.lastCell.row !== cell.row || this.lastCell.col !== cell.col)) {
        this.renderGrid();
      }
    });
    this.registerDomEvent(this.gridEl, "pointerup", (e: PointerEvent) => {
      this.gridEl?.releasePointerCapture(e.pointerId);
    });
    this.registerDomEvent(this.gridEl, "pointercancel", (e: PointerEvent) => {
      this.gridEl?.releasePointerCapture(e.pointerId);
      if (this.previewBase !== null) {
        this.lines = this.previewBase.map((row) => row.slice(0));
        this.previewBase = null;
        this.renderGrid();
      }
      this.isDrawing = false;
      this.isSelecting = false;
      this.isMoving = false;
    });
    this.registerDomEvent(document, "pointerup", (e: PointerEvent) => {
      if (this.isSelecting) {
        this.isSelecting = false;
        this.selectStart = null;
        this.renderGrid();
        return;
      }
      if (this.isMoving) {
        this.finishMove();
        return;
      }
      const shapeTools: Tool[] = ["rect", "line", "diamond", "ellipse", "triangle"];
      if (this.isDrawing && shapeTools.includes(this.tool) && this.lastCell && this.lastHoverCell && this.previewBase !== null) {
        const end = this.tool === "line" && e.shiftKey
          ? this.constrainToStraight(this.lastCell, this.lastHoverCell)
          : (this.tool === "rect" || this.tool === "diamond" || this.tool === "ellipse" || this.tool === "triangle") && e.shiftKey
            ? this.constrainToSquare(this.lastCell, this.lastHoverCell)
            : this.lastHoverCell;
        this.lines = this.previewBase.map((row) => row.slice(0));
        if (this.tool === "rect") this.drawRect(this.lastCell.row, this.lastCell.col, end.row, end.col);
        else if (this.tool === "line") this.drawLine(this.lastCell.row, this.lastCell.col, end.row, end.col);
        else if (this.tool === "diamond") this.drawDiamond(this.lastCell.row, this.lastCell.col, end.row, end.col);
        else if (this.tool === "ellipse") this.drawEllipse(this.lastCell.row, this.lastCell.col, end.row, end.col);
        else if (this.tool === "triangle") this.drawTriangle(this.lastCell.row, this.lastCell.col, end.row, end.col);
        this.redoStack = [];
        this.undoStack.push(this.previewBase.map((row) => row.slice(0)));
        if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
        this.previewBase = null;
        this.lastCell = null;
        this.renderGrid();
        this.scheduleSave();
      }
      this.isDrawing = false;
    });
    this.registerDomEvent(this.gridEl, "pointermove", (e: PointerEvent) => {
      const coordCell = this.getCellFromCoords(e.clientX, e.clientY);
      const cell = this.getCellFromEvent(e) ?? coordCell;
      if (cell) this.lastHoverCell = cell;
      if (this.isDrawing && (this.tool === "pencil" || this.tool === "erase" || this.tool === "brush") && this.lastCell && coordCell) {
        if (this.lastCell.row !== coordCell.row || this.lastCell.col !== coordCell.col) {
          const end = e.shiftKey ? this.constrainToStraight(this.lastCell, coordCell) : coordCell;
          this.applyToolAlongLine(this.lastCell.row, this.lastCell.col, end.row, end.col);
          this.lastCell = end;
          this.renderGrid();
        }
      } else if (this.isDrawing && this.tool === "spray" && coordCell) {
        this.applySpray(coordCell.row, coordCell.col);
        this.renderGrid();
      } else if (cell && this.isDrawing && this.previewBase !== null && this.lastCell) {
        this.lines = this.previewBase.map((row) => row.slice(0));
        const end = e.shiftKey && (this.tool === "rect" || this.tool === "diamond" || this.tool === "ellipse" || this.tool === "triangle")
          ? this.constrainToSquare(this.lastCell, cell)
          : this.tool === "line" && e.shiftKey
            ? this.constrainToStraight(this.lastCell, cell)
            : cell;
        if (this.tool === "rect") {
          this.drawRect(this.lastCell.row, this.lastCell.col, end.row, end.col);
        } else if (this.tool === "line") {
          this.drawLine(this.lastCell.row, this.lastCell.col, end.row, end.col);
        } else if (this.tool === "diamond") {
          this.drawDiamond(this.lastCell.row, this.lastCell.col, end.row, end.col);
        } else if (this.tool === "ellipse") {
          this.drawEllipse(this.lastCell.row, this.lastCell.col, end.row, end.col);
        } else if (this.tool === "triangle") {
          this.drawTriangle(this.lastCell.row, this.lastCell.col, end.row, end.col);
        }
        this.renderGrid();
      }
    });
  }

  private cloneLines(): string[] {
    return this.lines.map((row) => row.slice(0));
  }

  private pushUndo(): void {
    this.redoStack = [];
    this.undoStack.push(this.cloneLines());
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
  }

  undo(): void {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(this.cloneLines());
    const prev = this.undoStack.pop();
    if (prev) this.lines = prev.map((row) => row.slice(0));
    this.renderGrid();
    this.scheduleSave();
    this.updateStatus();
  }

  redo(): void {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(this.cloneLines());
    const next = this.redoStack.pop();
    if (next) this.lines = next.map((row) => row.slice(0));
    this.renderGrid();
    this.scheduleSave();
    this.updateStatus();
  }

  private registerScopeKeys(): void {
    if (!this.scope) return;
    const scope = this.scope;
    scope.register(["Mod"], "z", (evt) => {
      evt.preventDefault();
      this.undo();
    });
    scope.register(["Mod", "Shift"], "z", (evt) => {
      evt.preventDefault();
      this.redo();
    });
  }

  private clearSelection(): void {
    this.selection = null;
    this.isSelecting = false;
    this.selectStart = null;
    this.isMoving = false;
    this.moveBuffer = [];
    this.moveUnderContent = [];
    this.moveOrigin = null;
  }

  private isInsideSelection(r: number, c: number): boolean {
    if (!this.selection) return false;
    const { rMin, rMax, cMin, cMax } = this.selection;
    return r >= rMin && r <= rMax && c >= cMin && c <= cMax;
  }

  private isSelected(r: number, c: number): boolean {
    if (this.isMoving && this.moveOrigin !== null && this.moveBuffer.length > 0) {
      const o = this.moveOrigin;
      const h = this.moveBuffer.length;
      const w = this.moveBuffer[0]?.length ?? 0;
      return r >= o.row && r < o.row + h && c >= o.col && c < o.col + w;
    }
    if (!this.selection) return false;
    const { rMin, rMax, cMin, cMax } = this.selection;
    return r >= rMin && r <= rMax && c >= cMin && c <= cMax;
  }

  private getSelectionContent(): string[] {
    if (!this.selection) return [];
    const { rMin, rMax, cMin, cMax } = this.selection;
    const out: string[] = [];
    for (let r = rMin; r <= rMax; r++) {
      const line = this.lines[r];
      out.push(typeof line === "undefined" ? BLANK.repeat(cMax - cMin + 1) : line.slice(cMin, cMax + 1));
    }
    return out;
  }

  private getContentAt(r0: number, c0: number, h: number, w: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < h; i++) {
      const r = r0 + i;
      const line = r >= 0 && r < this.rows ? this.lines[r] : undefined;
      const row = typeof line === "undefined" ? BLANK.repeat(w) : line.slice(c0, c0 + w).padEnd(w, BLANK);
      out.push(row);
    }
    return out;
  }

  private clearRegion(rMin: number, rMax: number, cMin: number, cMax: number): void {
    for (let r = rMin; r <= rMax; r++) {
      if (r < 0 || r >= this.rows) continue;
      const line = this.lines[r];
      if (typeof line === "undefined") continue;
      const start = Math.max(0, cMin);
      const end = Math.min(this.cols, cMax + 1);
      this.lines[r] = line.slice(0, start) + BLANK.repeat(end - start) + line.slice(end);
    }
  }

  private pasteAt(r0: number, c0: number, buffer: string[]): void {
    for (let i = 0; i < buffer.length; i++) {
      const r = r0 + i;
      if (r < 0 || r >= this.rows) continue;
      const row = buffer[i];
      if (typeof row === "undefined") continue;
      let line = this.lines[r];
      if (typeof line === "undefined") continue;
      for (let j = 0; j < row.length; j++) {
        const c = c0 + j;
        if (c < 0 || c >= this.cols) continue;
        line = line.slice(0, c) + row[j] + line.slice(c + 1);
      }
      this.lines[r] = line;
    }
  }

  private startMove(cell: { row: number; col: number }): void {
    if (!this.selection) return;
    const { rMin, rMax, cMin, cMax } = this.selection;
    this.pushUndo();
    this.moveBuffer = this.getSelectionContent();
    const h = this.moveBuffer.length;
    const w = this.moveBuffer[0]?.length ?? 0;
    this.clearRegion(rMin, rMax, cMin, cMax);
    this.moveOffset = { row: cell.row - rMin, col: cell.col - cMin };
    this.moveOrigin = { row: rMin, col: cMin };
    this.moveUnderContent = this.getContentAt(rMin, cMin, h, w);
    this.pasteAt(this.moveOrigin.row, this.moveOrigin.col, this.moveBuffer);
    this.selection = null;
    this.isMoving = true;
  }

  private finishMove(): void {
    if (!this.moveOrigin || this.moveBuffer.length === 0) {
      this.isMoving = false;
      this.moveBuffer = [];
      this.moveOrigin = null;
      this.renderGrid();
      return;
    }
    const h = this.moveBuffer.length;
    const w = this.moveBuffer[0]?.length ?? 0;
    this.selection = {
      rMin: this.moveOrigin.row,
      rMax: this.moveOrigin.row + h - 1,
      cMin: this.moveOrigin.col,
      cMax: this.moveOrigin.col + w - 1,
    };
    this.isMoving = false;
    this.moveBuffer = [];
    this.moveOrigin = null;
    this.scheduleSave();
    this.renderGrid();
  }

  private constrainToStraight(
    from: { row: number; col: number },
    to: { row: number; col: number }
  ): { row: number; col: number } {
    const dr = Math.abs(to.row - from.row);
    const dc = Math.abs(to.col - from.col);
    if (dc >= dr) return { row: from.row, col: to.col };
    return { row: to.row, col: from.col };
  }

  private constrainToSquare(
    from: { row: number; col: number },
    to: { row: number; col: number }
  ): { row: number; col: number } {
    const dr = to.row - from.row;
    const dc = to.col - from.col;
    const size = Math.max(Math.abs(dr), Math.abs(dc), 1);
    const signR = dr === 0 ? 1 : dr > 0 ? 1 : -1;
    const signC = dc === 0 ? 1 : dc > 0 ? 1 : -1;
    return { row: from.row + signR * size, col: from.col + signC * size };
  }

  private getCellFromEvent(e: PointerEvent): { row: number; col: number } | null {
    const target = (e.target as HTMLElement).closest(".ascii-canvas-cell");
    if (!target) return null;
    const row = parseInt(target.getAttribute("data-row") ?? "", 10);
    const col = parseInt(target.getAttribute("data-col") ?? "", 10);
    if (Number.isNaN(row) || Number.isNaN(col)) return null;
    return { row, col };
  }

  private getCellFromCoords(clientX: number, clientY: number): { row: number; col: number } | null {
    if (!this.gridEl) return null;
    const gridRect = this.gridEl.getBoundingClientRect();
    const cellW = gridRect.width / this.cols;
    const cellH = gridRect.height / this.rows;
    if (cellW <= 0 || cellH <= 0) return null;
    const col = Math.floor((clientX - gridRect.left) / cellW);
    const row = Math.floor((clientY - gridRect.top) / cellH);
    const clampedRow = Math.max(0, Math.min(row, this.rows - 1));
    const clampedCol = Math.max(0, Math.min(col, this.cols - 1));
    return { row: clampedRow, col: clampedCol };
  }

  private applyTool(row: number, col: number): void {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    const line = this.lines[row];
    if (typeof line === "undefined") return;
    if (this.tool === "erase") {
      this.lines[row] = line.slice(0, col) + BLANK + line.slice(col + 1);
    } else if (this.tool === "pencil") {
      this.lines[row] = line.slice(0, col) + this.drawChar + line.slice(col + 1);
    }
    this.scheduleSave();
  }

  private applyToolBrush(row: number, col: number): void {
    this.applyTool(row, col);
    this.applyTool(row - 1, col);
    this.applyTool(row + 1, col);
    this.applyTool(row, col - 1);
    this.applyTool(row, col + 1);
  }

  private applyToolBrushSize(row: number, col: number): void {
    const rad = BRUSH_RADIUS;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (dr * dr + dc * dc <= rad * rad + 0.5) {
          this.setCell(row + dr, col + dc, this.drawChar);
        }
      }
    }
    this.scheduleSave();
  }

  private setCell(row: number, col: number, ch: string): void {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    const line = this.lines[row];
    if (typeof line === "undefined") return;
    this.lines[row] = line.slice(0, col) + ch + line.slice(col + 1);
  }

  private drawWordArt(r0: number, c0: number, text: string): void {
    const charW = FONT_W + FONT_SPACING;
    for (let i = 0; i < text.length; i++) {
      const glyph = BLOCK_FONT_5X7[text[i]] ?? BLOCK_FONT_5X7[" "];
      const baseC = c0 + i * charW;
      for (let row = 0; row < FONT_H; row++) {
        const line = glyph[row] ?? "";
        for (let col = 0; col < FONT_W; col++) {
          if (line[col] !== " " && line[col] !== "") this.setCell(r0 + row, baseC + col, this.drawChar);
        }
      }
    }
    this.scheduleSave();
  }

  private floodFill(startR: number, startC: number): void {
    const line0 = this.lines[startR];
    if (typeof line0 === "undefined") return;
    const replaceCh = line0[startC];
    if (typeof replaceCh === "undefined") return;
    if (replaceCh === this.drawChar) return;
    const stack: [number, number][] = [[startR, startC]];
    const visited = new Set<string>();
    const key = (r: number, c: number) => `${r},${c}`;
    while (stack.length > 0) {
      const [r, c] = stack.pop()!;
      if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) continue;
      if (visited.has(key(r, c))) continue;
      const line = this.lines[r];
      if (typeof line === "undefined") continue;
      if (line[c] !== replaceCh) continue;
      visited.add(key(r, c));
      this.setCell(r, c, this.drawChar);
      stack.push([r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]);
    }
    this.scheduleSave();
  }

  private applySpray(centerR: number, centerC: number): void {
    for (let i = 0; i < SPRAY_DOTS; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * SPRAY_RADIUS;
      const r = Math.round(centerR + Math.sin(angle) * dist);
      const c = Math.round(centerC + Math.cos(angle) * dist);
      this.setCell(r, c, this.drawChar);
    }
    this.scheduleSave();
  }

  private applyToolAlongLine(r0: number, c0: number, r1: number, c1: number): void {
    const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = Math.round(r0 + (r1 - r0) * t);
      const c = Math.round(c0 + (c1 - c0) * t);
      if (this.tool === "erase") this.applyToolBrush(r, c);
      else if (this.tool === "brush") this.applyToolBrushSize(r, c);
      else this.applyTool(r, c);
    }
  }

  private lineChar(r0: number, c0: number, r1: number, c1: number): string {
    const dr = r1 - r0;
    const dc = c1 - c0;
    if (dr === 0) return "-";
    if (dc === 0) return "|";
    return (dc > 0) === (dr > 0) ? "\\" : "/";
  }

  private drawLine(r0: number, c0: number, r1: number, c1: number): void {
    const ch = this.lineChar(r0, c0, r1, c1);
    const dr = Math.abs(r1 - r0);
    const dc = Math.abs(c1 - c0);
    const steps = Math.max(dr, dc, 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = Math.round(r0 + (r1 - r0) * t);
      const c = Math.round(c0 + (c1 - c0) * t);
      if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
        const line = this.lines[r];
        if (typeof line !== "undefined") {
          this.lines[r] = line.slice(0, c) + ch + line.slice(c + 1);
        }
      }
    }
    this.scheduleSave();
  }

  private drawRect(r0: number, c0: number, r1: number, c1: number): void {
    const rMin = Math.min(r0, r1);
    const rMax = Math.max(r0, r1);
    const cMin = Math.min(c0, c1);
    const cMax = Math.max(c0, c1);
    const h = (r: number) => (r >= 0 && r < this.rows ? this.lines[r] : undefined);
    const set = (r: number, c: number, ch: string) => {
      const line = h(r);
      if (typeof line !== "undefined" && c >= 0 && c < this.cols) {
        this.lines[r] = line.slice(0, c) + ch + line.slice(c + 1);
      }
    };
    for (let c = cMin; c <= cMax; c++) {
      set(rMin, c, "-");
      set(rMax, c, "-");
    }
    for (let r = rMin; r <= rMax; r++) {
      set(r, cMin, "|");
      set(r, cMax, "|");
    }
    set(rMin, cMin, "+");
    set(rMin, cMax, "+");
    set(rMax, cMin, "+");
    set(rMax, cMax, "+");
    this.scheduleSave();
  }

  private drawDiamond(r0: number, c0: number, r1: number, c1: number): void {
    const rMin = Math.min(r0, r1);
    const rMax = Math.max(r0, r1);
    const cMin = Math.min(c0, c1);
    const cMax = Math.max(c0, c1);
    const midR = Math.round((rMin + rMax) / 2);
    const midC = Math.round((cMin + cMax) / 2);
    this.drawLine(rMin, midC, midR, cMin);
    this.drawLine(midR, cMin, rMax, midC);
    this.drawLine(rMax, midC, midR, cMax);
    this.drawLine(midR, cMax, rMin, midC);
  }

  private drawEllipse(r0: number, c0: number, r1: number, c1: number): void {
    const rMin = Math.min(r0, r1);
    const rMax = Math.max(r0, r1);
    const cMin = Math.min(c0, c1);
    const cMax = Math.max(c0, c1);
    const a = (cMax - cMin) / 2;
    const b = (rMax - rMin) / 2;
    if (a < 0.5 || b < 0.5) return;
    const midR = (rMin + rMax) / 2;
    const midC = (cMin + cMax) / 2;
    const set = (r: number, c: number, ch: string) => {
      if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
        const line = this.lines[r];
        if (typeof line !== "undefined") this.lines[r] = line.slice(0, c) + ch + line.slice(c + 1);
      }
    };
    const steps = Math.max(Math.ceil(Math.PI * 2 * Math.max(a, b)), 8);
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const c = Math.round(midC + a * Math.cos(t));
      const r = Math.round(midR + b * Math.sin(t));
      set(r, c, this.drawChar);
    }
    this.scheduleSave();
  }

  private drawTriangle(r0: number, c0: number, r1: number, c1: number): void {
    const rMin = Math.min(r0, r1);
    const rMax = Math.max(r0, r1);
    const cMin = Math.min(c0, c1);
    const cMax = Math.max(c0, c1);
    const midC = Math.round((cMin + cMax) / 2);
    this.drawLine(rMin, midC, rMax, cMin);
    this.drawLine(rMax, cMin, rMax, cMax);
    this.drawLine(rMax, cMax, rMin, midC);
  }

  private scheduleSave(): void {
    if (this.saveTimeout !== null) clearTimeout(this.saveTimeout);
    const content = this.getContent();
    this.saveTimeout = setTimeout(() => {
      void this.doSave(content).finally(() => {
        this.saveTimeout = null;
      });
    }, 500);
  }

  private flushSave(): void {
    if (this.saveTimeout !== null) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    void this.doSave(this.getContent());
  }

  private getContent(): string {
    return `${MD_HEADER}\n\n${this.cols} ${this.rows}\n\n${MD_FENCE}\n${this.lines.join("\n")}\n\`\`\`\n`;
  }

  private async doSave(content: string): Promise<void> {
    if (!this.filePath) return;
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) return;
    try {
      await this.app.vault.modify(file, content);
    } catch {
      try {
        await this.app.vault.adapter.write(file.path, content);
      } catch {
        /* ignore */
      }
    }
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const parts = [`Tool: ${this.tool}`, `Char: ${this.drawChar === " " ? "space" : this.drawChar}`];
    if (this.undoStack.length > 0) parts.push(`Undo: ${this.undoStack.length}`);
    if (this.redoStack.length > 0) parts.push(`Redo: ${this.redoStack.length}`);
    this.statusEl.setText(parts.join(" | "));
  }
}
