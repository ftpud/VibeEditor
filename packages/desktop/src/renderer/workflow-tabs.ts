import type { HarnessDefinition } from "@remote-ide/protocol";
import type { EditorTab } from "./model";

/** A workflow view belongs to the root and task where it was opened. */
export function openWorkflowEditor(tabs: EditorTab[], workflow: HarnessDefinition, rootId: string, taskId?: string): { tabs: EditorTab[]; activeTabId: string } {
  const existing = tabs.find((tab) => tab.type === "workflow" && tab.workflowId === workflow.id && tab.rootId === rootId && tab.workflowTaskId === taskId);
  if (existing) return { tabs, activeTabId: existing.id };
  const id = `workflow:${JSON.stringify([rootId, taskId ?? null, workflow.id])}`;
  return { tabs: [...tabs, { id, type: "workflow", workflowId: workflow.id, workflowTaskId: taskId, rootId, title: workflow.name, path: id, content: "", savedContent: "", dirty: false, loading: false }], activeTabId: id };
}
