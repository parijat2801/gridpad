import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
