import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "./model";
import { TerminalTabButton } from "./TerminalPanel";

const tab: TerminalTab = { id: "tab-1", terminalId: "terminal-1", title: "Development server", status: "running" };

afterEach(cleanup);

describe("TerminalTabButton", () => {
  it("closes on middle mouse down without activating the tab", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<TerminalTabButton tab={tab} active={false} onActivate={onActivate} onClose={onClose} />);

    const tabButton = screen.getByRole("tab");
    expect(fireEvent.mouseDown(tabButton, { button: 1 })).toBe(false);
    fireEvent.click(tabButton, { button: 1 });
    expect(onClose).toHaveBeenCalledWith(tab);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("preserves primary-click activation and close-button behavior", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<TerminalTabButton tab={tab} active onActivate={onActivate} onClose={onClose} />);

    const tabButton = screen.getByRole("tab");
    fireEvent.click(tabButton);
    expect(onActivate).toHaveBeenCalledWith(tab.id);

    fireEvent.click(screen.getByTitle(`Close ${tab.title}`));
    expect(onClose).toHaveBeenCalledWith(tab);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(tabButton.getAttribute("aria-selected")).toBe("true");
    expect(tabButton.getAttribute("title")).toBe(`${tab.title} — running. Middle-click to close.`);
  });

  it("offers rename and duplicate actions from the tab menu", () => {
    const onRename = vi.fn();
    const onDuplicate = vi.fn();
    render(<TerminalTabButton tab={tab} active={false} onActivate={vi.fn()} onClose={vi.fn()} onRename={onRename} onDuplicate={onDuplicate} />);

    fireEvent.contextMenu(screen.getByRole("tab"));
    fireEvent.click(screen.getByText("Rename"));
    expect(onRename).toHaveBeenCalledWith(tab);

    fireEvent.contextMenu(screen.getByRole("tab"));
    fireEvent.click(screen.getByText("Duplicate"));
    expect(onDuplicate).toHaveBeenCalledWith(tab);
  });

  it("moves a tab when dropped onto another tab", () => {
    const onMove = vi.fn();
    render(<TerminalTabButton tab={tab} active={false} onActivate={vi.fn()} onClose={vi.fn()} onMove={onMove} />);
    const dataTransfer = { effectAllowed: "", dropEffect: "", getData: vi.fn(() => "tab-2"), setData: vi.fn() };
    fireEvent.drop(screen.getByRole("tab"), { dataTransfer });
    expect(onMove).toHaveBeenCalledWith("tab-2", tab.id);
  });
});
