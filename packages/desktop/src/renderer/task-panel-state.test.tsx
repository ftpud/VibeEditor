import { describe, expect, it } from "vitest";
import { restoredFocusedLeftPanels, initialTaskPanel, switchedTaskPanel, taskPanelPreferenceKey } from "./task-panel-state";

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

describe("Proc navigation persistence", () => {
  it("restores Proc in classic task navigation", () => {
    expect(initialTaskPanel("classic", "task", () => "proc")).toEqual({ classic: "proc" });
  });
  it("restores focused Proc exclusively while retaining Tasks and handling older saved preferences", () => {
    const current = { tasks: true, ai: true, harness: false, timers: false, proc: false };
    expect(restoredFocusedLeftPanels(current, { proc: true })).toEqual({ tasks: true, ai: false, harness: false, timers: false, proc: true });
    expect(restoredFocusedLeftPanels(current, { timers: true })).toEqual({ tasks: true, ai: false, harness: false, timers: true, proc: false });
  });
});
