import type { HarnessRun } from "@remote-ide/protocol";

/** Keep live updates that arrived while an older history request was in flight. */
export function mergeWorkflowHistory(current: HarnessRun[], incoming: HarnessRun[], baseline: HarnessRun[]): HarnessRun[] {
  const before = new Map(baseline.map((run) => [run.id, run]));
  const changed = current.filter((run) => before.get(run.id) !== run);
  const changedIds = new Set(changed.map((run) => run.id));
  return [...changed, ...incoming.filter((run) => !changedIds.has(run.id))];
}

/** Compare Core-owned identity and paths; Desktop never resolves worktrees. */
export function workflowRunsForContext(runs: HarnessRun[], rootWorkspace: string | undefined, workspace: string, taskId?: string): HarnessRun[] {
  return runs.filter((run) => run.binding
    ? run.binding.rootWorkspace === rootWorkspace && run.binding.taskId === taskId && run.binding.workspace === workspace
    : run.workspace === workspace);
}
