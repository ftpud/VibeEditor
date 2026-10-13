import type { HarnessRun } from "@remote-ide/protocol";

/** Compare Core-owned identity and paths; Desktop never resolves worktrees. */
export function workflowRunsForContext(runs: HarnessRun[], rootWorkspace: string | undefined, workspace: string, taskId?: string): HarnessRun[] {
  return runs.filter((run) => run.binding
    ? run.binding.rootWorkspace === rootWorkspace && run.binding.taskId === taskId && run.binding.workspace === workspace
    : run.workspace === workspace);
}
