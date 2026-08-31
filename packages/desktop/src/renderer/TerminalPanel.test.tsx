import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "./model";
import { TerminalRecoveryNotice, TerminalTabButton } from "./TerminalPanel";

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

  it("renames inline from the tab menu and duplicates independently", () => {
    const onRename = vi.fn();
    const onDuplicate = vi.fn();
    render(<TerminalTabButton tab={tab} active={false} onActivate={vi.fn()} onClose={vi.fn()} onRename={onRename} onDuplicate={onDuplicate} />);

    fireEvent.contextMenu(screen.getByRole("tab"));
    fireEvent.click(screen.getByText("Rename"));
    const input = screen.getByRole("textbox", { name: `Rename ${tab.title}` });
    fireEvent.change(input, { target: { value: "API server" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(tab, "API server");

    fireEvent.contextMenu(screen.getByRole("tab"));
    fireEvent.click(screen.getByText("Duplicate"));
    expect(onDuplicate).toHaveBeenCalledWith(tab);
  });

  it("cancels an inline rename without changing the title", () => {
    const onRename = vi.fn();
    render(<TerminalTabButton tab={tab} active onActivate={vi.fn()} onClose={vi.fn()} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByRole("tab"));
    const input = screen.getByRole("textbox", { name: `Rename ${tab.title}` });
    fireEvent.change(input, { target: { value: "Discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("tab").textContent).toContain(tab.title);
  });

  it("moves a tab when dropped onto another tab", () => {
    const onMove = vi.fn();
    render(<TerminalTabButton tab={tab} active={false} onActivate={vi.fn()} onClose={vi.fn()} onMove={onMove} />);
    const dataTransfer = { effectAllowed: "", dropEffect: "", getData: vi.fn(() => "tab-2"), setData: vi.fn() };
    fireEvent.drop(screen.getByRole("tab"), { dataTransfer });
    expect(onMove).toHaveBeenCalledWith("tab-2", tab.id);
  });
});

describe("TerminalRecoveryNotice", () => {
  it("clearly distinguishes a live reattach from a recreated shell", () => {
    const { rerender } = render(<TerminalRecoveryNotice tab={{ ...tab, recovery: "reattached" }} />);
    expect(screen.getByRole("status").textContent).toContain("same Core-owned terminal process");
    rerender(<TerminalRecoveryNotice tab={{ ...tab, recovery: "recreated" }} />);
    expect(screen.getByRole("status").textContent).toContain("former process, environment, and working directory were not restored");
  });

  it("reports an exited process without suggesting recovery", () => {
    render(<TerminalRecoveryNotice tab={{ ...tab, status: "exited", exitCode: 17 }} />);
    expect(screen.getByRole("status").textContent).toContain("exited with code 17 and cannot accept input");
  });

  it("automatically dismisses recovery notices", () => {
    vi.useFakeTimers();
    try {
      render(<TerminalRecoveryNotice tab={{ ...tab, recovery: "recreated" }} />);
      expect(screen.getByRole("status")).toBeTruthy();
      act(() => vi.advanceTimersByTime(6_000));
      expect(screen.queryByRole("status")).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
