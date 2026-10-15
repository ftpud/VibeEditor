import { expect, it } from "vitest";
import type { HarnessDefinition } from "@remote-ide/protocol";
import { openWorkflowEditor } from "./workflow-tabs";
const workflow = { id: "check", name: "Workspace check" } as HarnessDefinition;
it("reactivates an existing workflow tab without duplicating it", () => {
  const first = openWorkflowEditor([], workflow, "root", "task");
  const again = openWorkflowEditor(first.tabs, { ...workflow, name: "Renamed" }, "root", "task");
  expect(again.tabs).toBe(first.tabs);
  expect(again.activeTabId).toBe(first.activeTabId);
});
it("keeps separate workflow tabs for different roots and tasks", () => {
  const root = openWorkflowEditor([], workflow, "root");
  const task = openWorkflowEditor(root.tabs, workflow, "root", "task");
  const other = openWorkflowEditor(task.tabs, workflow, "other", "task");
  expect(new Set(other.tabs.map((tab) => tab.id)).size).toBe(3);
  expect(other.tabs.map((tab) => [tab.rootId, tab.workflowTaskId])).toEqual([["root", undefined], ["root", "task"], ["other", "task"]]);
});
