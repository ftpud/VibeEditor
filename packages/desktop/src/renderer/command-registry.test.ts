import { describe, expect, it, vi } from "vitest";
import { commandEnabled, defaultShortcutBindings, normalizeShortcut, rankCommands, shortcutConflict, shortcutMatches, type Command } from "./command-registry";

const context = { connected: true, hasActiveEditor: false, activeEditorDirty: false, gitBusy: false, taskSwitching: false, aiBusy: false };
describe("command registry", () => {
  const commands: Command[] = [{ id: "project.refresh", label: "Refresh Project", category: "Project", execute: vi.fn() }, { id: "editor.save", label: "Save Active Editor", category: "Editor", when: (value) => value.activeEditorDirty, execute: vi.fn() }];
  it("has stable searchable identities and evaluates availability from typed context", () => {
    expect(rankCommands(commands, "project refresh").map((command) => command.id)).toEqual(["project.refresh"]);
    expect(commandEnabled(commands[1]!, context)).toBe(false);
    expect(commandEnabled(commands[1]!, { ...context, activeEditorDirty: true })).toBe(true);
  });
  it("uses platform conventions and detects command and reserved conflicts", () => {
    const bindings = defaultShortcutBindings("mac");
    expect(bindings["editor.save"]).toBe("Meta+S");
    expect(shortcutConflict("project.quickOpen", "Meta+S", bindings, "mac")).toContain("editor.save");
    expect(shortcutConflict("project.quickOpen", "Meta+W", bindings, "mac")).toContain("Monaco/editor");
    expect(shortcutConflict("project.quickOpen", "Meta+K", bindings, "mac")).toBeUndefined();
  });
  it("normalizes and matches keyboard events exactly", () => {
    expect(normalizeShortcut("cmd+shift+p")).toBe("Meta+Shift+P");
    expect(shortcutMatches({ key: "p", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, "Ctrl+Shift+P")).toBe(true);
    expect(shortcutMatches({ key: "p", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, "Ctrl+Shift+P")).toBe(false);
  });
});
