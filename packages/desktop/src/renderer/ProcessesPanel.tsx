import { RefreshCw, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { ManagedWorkflowApp } from "@remote-ide/protocol";

export function ProcessesPanel({ processes, loading, error, disabled, onRefresh, onKill }: {
  processes: ManagedWorkflowApp[]; loading: boolean; error?: string; disabled: boolean;
  onRefresh(): Promise<void>; onKill(id: string): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const execute = async (action: () => Promise<void>) => {
    if (pending || disabled) return;
    setPending(true); setActionError("");
    try { await action(); } catch (error) { setActionError(error instanceof Error ? error.message : "Could not update workflow apps. Refresh and try again."); }
    finally { setPending(false); }
  };
  const busy = pending || disabled;
  return <>
    <header className="panel-header"><span>Proc <span className="timers-total">{processes.length}</span></span><div className="panel-header-actions"><button title="Refresh workflow apps" aria-label="Refresh workflow apps" disabled={busy || loading} onClick={() => void execute(onRefresh)}><RefreshCw size={14} /></button></div></header>
    <div className="timers-panel">
      <p className="timers-help">Running workflow apps across this project’s tasks and workflow sessions. Each app counts once, including its children. Stop terminates the whole app tree.</p>
      {(error || actionError) && <p className="schedule-error" role="alert">{actionError || error}</p>}
      {loading && <p role="status">Loading workflow apps…</p>}
      {!loading && !error && !processes.length && <div className="timers-empty" role="status"><SquareTerminal size={28} aria-hidden="true" /><strong>No running workflow apps</strong><span>Apps started by workflow Run App blocks appear here.</span></div>}
      {processes.map((item) => <article className="timer-entry" key={item.id} aria-label={`${item.name} workflow app`}>
        <div className="timer-title"><SquareTerminal size={14} aria-hidden="true" /><strong title={item.command}>{item.name}</strong><span className="timer-state scheduled">{item.status === "descendants-running" ? "Children running" : "Running"}</span></div>
        <p className="timer-prompt">{item.command}</p>
        <p>PID {item.pid} · {item.processCount} {item.processCount === 1 ? "process" : "processes"}</p>
        <p>{item.taskName ?? (item.workflowRunId ? "Workflow session" : "Workspace session")}</p>
        <details><summary>App details</summary><div>{item.workspace}</div>{item.launcherPid !== undefined && item.launcherPid !== item.pid && <div>Exited launcher PID: {item.launcherPid}</div>}{item.taskId && <div>Task: {item.taskId}</div>}{item.workflowRunId && <div>Workflow: {item.workflowRunId}</div>}{item.workflowBlockId && <div>Block: {item.workflowBlockId}</div>}</details>
        <div className="timer-actions"><button className="danger" disabled={busy} onClick={() => void execute(() => onKill(item.id))}><Square size={13} aria-hidden="true" /> Stop</button></div>
      </article>)}
    </div>
  </>;
}
