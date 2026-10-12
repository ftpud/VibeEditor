import type { HarnessRun, WorkspaceOptions } from "@remote-ide/protocol";
import type { EditorTab } from "./model";

export function workflowDocumentOptions(tabs: EditorTab[], activeTabId?: string, rootId?: string): Pick<WorkspaceOptions, "workflowDocuments"> {
  return { workflowDocuments: tabs.flatMap((tab, position) => tab.type === "workflowDocument" && tab.workflowRunId && tab.workflowBlockId && (!tab.rootId || !rootId || tab.rootId === rootId) ? [{ runId: tab.workflowRunId, blockId: tab.workflowBlockId, position, ...(tab.pinned ? { pinned: true } : {}), markdownMode: tab.markdownMode ?? "preview", ...(tab.id === activeTabId ? { active: true } : {}) }] : []) };
}

/** Restore only explicitly open documents, using the run’s frozen definition and saved output. */
export function restoreWorkflowDocuments(fileTabs: EditorTab[], saved: WorkspaceOptions["workflowDocuments"], runs: HarnessRun[], rootId: string, existing: EditorTab[] = [], existingActiveTabId?: string): { tabs: EditorTab[]; activeTabId?: string } {
  const tabs = [...fileTabs];
  let activeTabId: string | undefined;
  const references = [...saved ?? []];
  for (const document of workflowDocumentOptions(existing, existingActiveTabId, rootId).workflowDocuments ?? []) {
    if (!references.some((saved) => saved.runId === document.runId && saved.blockId === document.blockId)) references.push(document);
  }
  for (const document of references.sort((a, b) => a.position - b.position)) {
    const run = runs.find((run) => run.id === document.runId);
    const block = run?.definition?.blocks.find((block) => block.id === document.blockId && block.type === "markdown");
    const output = run?.blocks.find((state) => state.blockId === document.blockId)?.output;
    const previous = existing.find((tab) => tab.type === "workflowDocument" && (!tab.rootId || tab.rootId === rootId) && tab.workflowRunId === document.runId && tab.workflowBlockId === document.blockId);
    if ((!block || output === undefined) && !previous) continue;
    const title = block ? (block.label.endsWith(".md") ? block.label : `${block.label}.md`) : previous!.title;
    const content = output ?? previous!.savedContent;
    const id = `workflow-document:${rootId}:${document.runId}:${document.blockId}`;
    tabs.splice(Math.min(document.position, tabs.length), 0, { id, type: "workflowDocument", workflowRunId: document.runId, workflowBlockId: document.blockId, rootId, title, path: title, content: previous?.dirty ? previous.content : content, savedContent: content, dirty: previous?.dirty ?? false, loading: false, pinned: document.pinned, markdownMode: document.markdownMode ?? "preview" });
    if (document.active) activeTabId = id;
  }
  if (tabs.some((tab) => tab.type === "workflowDocument" && tab.id === existingActiveTabId)) activeTabId = existingActiveTabId;
  return { tabs, activeTabId };
}
