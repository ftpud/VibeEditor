import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutSettings } from "./ShortcutSettings";
import { defaultShortcutBindings, type Command } from "./command-registry";

const commands: Command[] = [
  { id: "project.quickOpen", label: "Go to File", category: "Project", execute: vi.fn() },
  { id: "editor.save", label: "Save Active Editor", category: "Editor", execute: vi.fn() }
];
afterEach(cleanup);

describe("ShortcutSettings", () => {
  it("captures a valid binding and reports command conflicts", () => {
    const onChange = vi.fn();
    render(<ShortcutSettings commands={commands} bindings={defaultShortcutBindings("windows")} platform="windows" onChange={onChange} onReset={vi.fn()} />);
    const quickOpen = screen.getByRole("button", { name: "Go to File shortcut" });
    fireEvent.click(quickOpen); fireEvent.keyDown(quickOpen, { key: "s", ctrlKey: true });
    expect(screen.getByRole("alert").textContent).toContain("editor.save");
    fireEvent.keyDown(quickOpen, { key: "k", ctrlKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledWith("project.quickOpen", "Ctrl+Shift+K");
  });

  it("identifies reserved editor bindings and allows clearing", () => {
    const onChange = vi.fn();
    render(<ShortcutSettings commands={commands} bindings={defaultShortcutBindings("windows")} platform="windows" onChange={onChange} onReset={vi.fn()} />);
    const quickOpen = screen.getByRole("button", { name: "Go to File shortcut" });
    fireEvent.click(quickOpen); fireEvent.keyDown(quickOpen, { key: "w", ctrlKey: true });
    expect(screen.getByRole("alert").textContent).toContain("Monaco/editor");
    fireEvent.keyDown(quickOpen, { key: "Backspace" });
    expect(onChange).toHaveBeenCalledWith("project.quickOpen");
  });
});
