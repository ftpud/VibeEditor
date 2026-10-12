import { expect, it } from "vitest";
import type { HarnessRun } from "@remote-ide/protocol";
import type { EditorTab } from "./model";
import { workflowDocumentOptions, restoreWorkflowDocuments } from "./workflow-documents";

const file = (path: string): EditorTab => ({ id: path, type: "file", rootId: "root", title: path, path, content: "", savedContent: "", dirty: false, loading: false });
const runs = [{ id: "run", definition: { blocks: [{ id: "report", type: "markdown", label: "Report" }] }, blocks: [{ blockId: "report", output: "# Report\nUpdated result" }] }] as HarnessRun[];
const saved = [{ runId: "run", blockId: "report", position: 1, active: true, markdownMode: "preview" as const }];

it("restores workflow Markdown and the active document from Core output alongside ordinary files", () => {
  const restored = restoreWorkflowDocuments([file("first.ts"), file("last.ts")], saved, runs, "root");
  expect(restored.tabs.map((tab) => tab.title)).toEqual(["first.ts", "Report.md", "last.ts"]);
  const report = restored.tabs[1]!;
  expect(report).toMatchObject({ type: "workflowDocument", content: "# Report\nUpdated result", markdownMode: "preview", workflowRunId: "run", workflowBlockId: "report" });
  expect(restored.activeTabId).toBe(report.id);
  expect(workflowDocumentOptions(restored.tabs, restored.activeTabId, "root")).toEqual({ workflowDocuments: saved });
});

it("keeps the current Markdown tab open when switching to a task with no saved document tabs", () => {
  const original = restoreWorkflowDocuments([file("source.ts")], saved, runs, "root");
  const switched = restoreWorkflowDocuments([file("target.ts")], [], runs, "root", original.tabs, original.activeTabId);
  expect(switched.tabs.map((tab) => tab.title)).toEqual(["target.ts", "Report.md"]);
  expect(switched.activeTabId).toBe(original.activeTabId);
  expect(workflowDocumentOptions(switched.tabs, switched.activeTabId, "root").workflowDocuments).toEqual(saved);
});

it("does not restore manually closed documents or carry documents into another root", () => {
  const original = restoreWorkflowDocuments([], saved, runs, "root");
  expect(restoreWorkflowDocuments([], [], runs, "other", original.tabs, original.activeTabId).tabs).toEqual([]);
  expect(restoreWorkflowDocuments([], [], runs, "root").tabs).toEqual([]);
  expect(workflowDocumentOptions(original.tabs, original.activeTabId, "other").workflowDocuments).toEqual([]);
});

it("skips deleted workflow history and retains a still-open document without duplicating it", () => {
  expect(restoreWorkflowDocuments([file("file.ts")], saved, [], "root").tabs).toHaveLength(1);
  const original = restoreWorkflowDocuments([], saved, runs, "root");
  expect(restoreWorkflowDocuments([], saved, [], "root", original.tabs).tabs).toHaveLength(1);
  expect(restoreWorkflowDocuments([], saved, runs, "root", original.tabs).tabs).toHaveLength(1);
});
