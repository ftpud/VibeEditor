import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

afterEach(cleanup);

describe("CommandPalette", () => {
  it("searches typed commands and keeps unavailable commands visible", () => {
    const execute = vi.fn(); const close = vi.fn();
    render(<CommandPalette context={{ connected: true, hasActiveEditor: false, activeEditorDirty: false, gitBusy: true, taskSwitching: false, aiBusy: false }} bindings={{ "terminal.new": "Ctrl+N" }} platform="windows" onClose={close} commands={[{ id: "git.refresh", label: "Refresh Git Changes", category: "Git", when: (context) => !context.gitBusy, execute }, { id: "terminal.new", label: "New Terminal", category: "Terminal", execute }]} />);
    const input = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "git" } });
    const command = screen.getByRole("option", { name: /Refresh Git Changes/ });
    expect(command.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Unavailable")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(execute).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
