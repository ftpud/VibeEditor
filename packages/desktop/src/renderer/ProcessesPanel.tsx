import { RefreshCw, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { ManagedProcess, AiProviderDescriptor } from "@remote-ide/protocol";

export function ProcessesPanel({ processes, providers, loading, error, disabled, onRefresh, onKill }: {
  processes: ManagedProcess[]; providers: AiProviderDescriptor[]; loading: boolean; error?: string; disabled: boolean;
  onRefresh(): Promise<void>; onKill(id: string): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const execute = async (action: () => Promise<void>) => {
    if (pending || disabled) return;
    setPending(true); setActionError("");
    try { await action(); } catch (error) { setActionError(error instanceof Error ? error.message : "Could not update processes. Refresh and try again."); }
    finally { setPending(false); }
  };
  const busy = pending || disabled;
  return <>
    <header className="panel-header"><span>Proc <span className="timers-total">{processes.length}</span></span><div className="panel-header-actions"><button title="Refresh processes" aria-label="Refresh processes" disabled={busy || loading} onClick={() => void execute(onRefresh)}><RefreshCw size={14} /></button></div></header>
    <div className="timers-panel">
      <p className="timers-help">AI processes across this project’s tasks and workflow sessions. Kill stops the selected process and its managed descendants.</p>
      {(error || actionError) && <p className="schedule-error" role="alert">{actionError || error}</p>}
      {loading && <p role="status">Loading processes…</p>}
      {!loading && !error && !processes.length && <div className="timers-empty" role="status"><SquareTerminal size={28} aria-hidden="true" /><strong>No running AI processes</strong><span>Agent commands and workflow apps appear here when they start.</span></div>}
      {processes.map((item) => <article className="timer-entry" key={item.id} aria-label={`${item.command} process`}>
        <div className="timer-title"><SquareTerminal size={14} aria-hidden="true" /><strong title={item.command}>{item.command}</strong><span className="timer-state scheduled">Running</span></div>
        <p>PID {item.pid} · {item.kind === "agent" ? "Agent" : item.kind === "workflow-app" ? "Workflow app" : "Command"}{item.provider ? ` · ${providers.find((provider) => provider.id === item.provider)?.name ?? item.provider}` : ""}</p>
        <p>{item.taskName ?? (item.workflowRunId ? "Workflow session" : "Workspace session")}</p>
        <details><summary>Process details</summary><div>{item.workspace}</div>{item.taskId && <div>Task: {item.taskId}</div>}{item.sessionId && <div>Session: {item.sessionId}</div>}{item.workflowRunId && <div>Workflow: {item.workflowRunId}</div>}{item.workflowBlockId && <div>Block: {item.workflowBlockId}</div>}</details>
        <div className="timer-actions"><button className="danger" disabled={busy} onClick={() => void execute(() => onKill(item.id))}><Square size={13} aria-hidden="true" /> Kill</button></div>
      </article>)}
    </div>
  </>;
}
