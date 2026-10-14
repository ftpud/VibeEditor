import { expect, it } from "vitest";
import type { HarnessRun } from "@remote-ide/protocol";
import { mergeWorkflowHistory, workflowRunsForContext } from "./workflow-context";

it("keeps live cancellation and new runs when an older history response arrives", () => {
  const running = { id: "run", status: "running" } as HarnessRun;
  const cancelled = { ...running, status: "cancelled" } as HarnessRun;
  const started = { id: "new", status: "running" } as HarnessRun;
  const historical = { id: "old", status: "succeeded" } as HarnessRun;
  expect(mergeWorkflowHistory([cancelled, started], [running, historical], [running])).toEqual([cancelled, started, historical]);
  expect(mergeWorkflowHistory([running], [cancelled, historical], [running])).toEqual([cancelled, historical]);
});

it("scopes controls by root, task and bound worktree even when an obsolete response arrives", () => {
  const runs = [
    { id: "a", binding: { rootWorkspace: "/root", workspace: "/task-a", taskId: "a" } },
    { id: "b", binding: { rootWorkspace: "/root", workspace: "/task-b", taskId: "b" } },
    { id: "root", binding: { rootWorkspace: "/root", workspace: "/root" } },
    { id: "other", binding: { rootWorkspace: "/other", workspace: "/task-a", taskId: "a" } },
    { id: "legacy", workspace: "/task-a" },
    { id: "unknown" },
  ] as HarnessRun[];
  expect(workflowRunsForContext(runs, "/root", "/task-a", "a").map((run) => run.id)).toEqual(["a", "legacy"]);
  expect(workflowRunsForContext(runs, "/root", "/task-b", "b").map((run) => run.id)).toEqual(["b"]);
  expect(workflowRunsForContext(runs, "/root", "/root").map((run) => run.id)).toEqual(["root"]);
  expect(workflowRunsForContext(runs, "/root", "/replacement", "a")).toEqual([]);
});

it("retains hydrated details on a summary refresh and replaces them when lifecycle changes", () => {
  const full = { id: "run", status: "running", blocks: [{ blockId: "chat", status: "running", output: "Live reply" }] } as HarnessRun;
  const summary = { ...full, summary: true, blocks: [{ blockId: "chat", status: "running" }] } as HarnessRun;
  expect(mergeWorkflowHistory([full], [summary], [full])).toEqual([full]);
  const completed = { ...summary, status: "succeeded", blocks: [{ blockId: "chat", status: "succeeded" }] } as HarnessRun;
  expect(mergeWorkflowHistory([full], [completed], [full])).toEqual([completed]);
});
