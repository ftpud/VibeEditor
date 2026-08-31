import { describe, expect, it, vi } from "vitest";
import { commandEnabled, rankCommands, type Command } from "./command-registry";

const context = { connected: true, hasActiveEditor: false, activeEditorDirty: false, gitBusy: false, taskSwitching: false, aiBusy: false };
describe("command registry", () => {
  const commands: Command[] = [{ id: "project.refresh", label: "Refresh Project", category: "Project", execute: vi.fn() }, { id: "editor.save", label: "Save Active Editor", category: "Editor", when: (value) => value.activeEditorDirty, execute: vi.fn() }];
  it("has stable searchable identities and evaluates availability from typed context", () => {
    expect(rankCommands(commands, "project refresh").map((command) => command.id)).toEqual(["project.refresh"]);
    expect(commandEnabled(commands[1]!, context)).toBe(false);
    expect(commandEnabled(commands[1]!, { ...context, activeEditorDirty: true })).toBe(true);
  });
});
