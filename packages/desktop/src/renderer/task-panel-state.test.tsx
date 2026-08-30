import { describe, expect, it } from "vitest";
import { initialTaskPanel, switchedTaskPanel, taskPanelPreferenceKey } from "./task-panel-state";

describe("task panel selection", () => {
  it("uses Task Git for the initial task when it has no explicit panel choice", () => {
    expect(initialTaskPanel("classic", "task-a", () => null)).toEqual({ classic: "taskGit" });
    expect(initialTaskPanel("ai-focused", "task-a", () => null)).toEqual({ focusedTaskGit: true });
  });

  it("opens Task Git on a genuine switch between tasks", () => {
    expect(switchedTaskPanel("task-b")).toEqual({ classic: "taskGit", focusedTaskGit: true });
  });

  it("does nothing for same-task refreshes and reconnect updates", () => {
    expect(switchedTaskPanel(undefined)).toEqual({});
  });

  it("respects a user's task-specific choice on initial entry and reconnect", () => {
    const values = new Map([
      [taskPanelPreferenceKey("classic", "task-a"), "project"],
      [taskPanelPreferenceKey("ai-focused", "task-a"), "closed"]
    ]);
    const read = (key: string) => values.get(key) ?? null;
    expect(initialTaskPanel("classic", "task-a", read)).toEqual({ classic: "project" });
    expect(initialTaskPanel("ai-focused", "task-a", read)).toEqual({ focusedTaskGit: false });
  });

  it("lets only the current rapid switch determine the visible task panel", () => {
    let currentSequence = 0;
    let panel = "project";
    const begin = () => ++currentSequence;
    const apply = (sequence: number) => { if (sequence === currentSequence) panel = switchedTaskPanel("task")?.classic ?? panel; };
    const first = begin();
    const second = begin();
    apply(first);
    expect(panel).toBe("project");
    apply(second);
    expect(panel).toBe("taskGit");
  });
});
