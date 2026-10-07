import { Bot, Clock, Pause, Play, RefreshCw, Square, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentFile, AiContinuationTimer, AiProviderDescriptor, HarnessDefinition, HarnessRun, ScheduleInput, WorkspaceRoot, WorkspaceSchedule, WorkspaceTask } from "@remote-ide/protocol";

import { ScheduleForm } from "./ScheduleForm";

export function TimersPanel({ timers, schedules, workflows, roots, providers, tasks, runs, selectedTaskId, defaultProvider, onLoadAgents, onCreateSchedule, onScheduleAction, disabled = false, onRefresh, onAction, onCancelAll, onError }: {
  timers: AiContinuationTimer[];
  schedules: WorkspaceSchedule[];
  workflows: HarnessDefinition[];
  roots: WorkspaceRoot[];
  selectedTaskId?: string;
  defaultProvider: string;
  onLoadAgents(taskId?: string): Promise<AgentFile[]>;
  onCreateSchedule(input: ScheduleInput): Promise<void>;
  onScheduleAction(id: string, action: "fire" | "pause" | "resume" | "delete"): Promise<void>;
  providers: AiProviderDescriptor[];
  tasks: WorkspaceTask[];
  runs: HarnessRun[];
  disabled?: boolean;
  onRefresh(): Promise<void>;
  onAction(id: string, action: "cancel" | "fire"): Promise<void>;
  onCancelAll(): Promise<void>;
  onError(message: string): void;
}) {
  const [now, setNow] = useState(Date.now());
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!timers.length && !schedules.some((schedule) => schedule.enabled)) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [timers, schedules]);
  const execute = async (action: () => Promise<void>) => {
    if (pending || disabled) return;
    setPending(true);
    try { await action(); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not update timers"); }
    finally { setPending(false); }
  };
  const busy = pending || disabled;
  return <>
    <header className="panel-header"><span>Timers <span className="timers-total">{timers.length + schedules.filter((item) => item.enabled).length}</span></span><div className="panel-header-actions">
      <button title="New schedule" aria-label="New schedule" disabled={busy} aria-expanded={creating} onClick={() => setCreating((open) => !open)}><Plus size={14} /></button>
      <button title="Refresh timers" aria-label="Refresh timers" disabled={busy} onClick={() => void execute(onRefresh)}><RefreshCw size={14} /></button>
      <button title="Cancel all timers and pause schedules" aria-label="Cancel all timers and pause schedules" disabled={busy || (!timers.length && !schedules.some((schedule) => schedule.enabled))} onClick={() => void execute(onCancelAll)}><Square size={14} /></button>
    </div></header>
    <div className="timers-panel">
      <p className="timers-help">Schedule prompts and workflows, or manage upcoming AI continuations.</p>
      {creating && <ScheduleForm tasks={tasks} workflows={workflows} providers={providers} selectedTaskId={selectedTaskId} defaultProvider={defaultProvider} onLoadAgents={onLoadAgents} onCreate={onCreateSchedule} onCancel={() => setCreating(false)} />}
      {schedules.length > 0 && <section className="timer-section" aria-label="Schedules"><header className="timer-section-header"><Clock size={13} aria-hidden="true" /><span>Schedules</span><span>{schedules.length}</span></header>{schedules.map((schedule) => <article className="timer-entry" key={schedule.id} aria-label={`${schedule.name} schedule`}>
        <div className="timer-title"><Clock size={14} /><strong title={schedule.name}>{schedule.name}</strong><span className={`timer-state ${schedule.enabled ? "scheduled" : schedule.lastError ? "error" : "paused"}`}>{schedule.enabled ? "Scheduled" : schedule.lastRunAt && !schedule.intervalSeconds && !schedule.lastError ? "Completed" : "Paused"}</span></div>
        <p>{schedule.action.type === "workflow" ? `Workflow: ${workflows.find((item) => item.id === ("harnessId" in schedule.action ? schedule.action.harnessId : ""))?.name ?? schedule.action.harnessId}` : `Prompt · ${providers.find((item) => item.id === schedule.action.provider)?.name ?? schedule.action.provider}${schedule.action.agent ? ` · ${schedule.action.agent.name}` : ""}`}</p>
        <p>{roots.find((root) => root.id === schedule.rootId)?.alias ?? schedule.rootId} · {schedule.taskId ? tasks.find((item) => item.id === schedule.taskId)?.name ?? `Task ${schedule.taskId}` : "Root workspace"} · {schedule.intervalSeconds ? `Every ${schedule.intervalSeconds / 60} minutes` : "One time"}</p>
        {schedule.enabled && <><div className="timer-countdown" role="timer">{Date.parse(schedule.dueAt) <= now ? "Due now" : `Next run in ${Math.ceil((Date.parse(schedule.dueAt) - now) / 60_000)}m`}</div><time dateTime={schedule.dueAt}>{new Date(schedule.dueAt).toLocaleString()}</time></>}
        {schedule.lastRunAt && <p>Last run: {new Date(schedule.lastRunAt).toLocaleString()}</p>}
        {schedule.lastError && <p className="schedule-error" role="alert">{schedule.lastError}</p>}
        <details><summary>{schedule.action.type === "prompt" ? "Prompt" : "Workflow input"}</summary><p className="timer-prompt">{schedule.action.type === "prompt" ? schedule.action.prompt : schedule.action.input}</p></details>
        <div className="timer-actions">
          <button disabled={busy} onClick={() => void execute(() => onScheduleAction(schedule.id, "fire"))}><Play size={13} /> Run now</button>
          <button disabled={busy} onClick={() => void execute(() => onScheduleAction(schedule.id, schedule.enabled ? "pause" : "resume"))}>{schedule.enabled ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}{schedule.enabled ? "Pause" : "Resume"}</button>
          <button className="danger" disabled={busy} onClick={() => void execute(() => onScheduleAction(schedule.id, "delete"))}><Trash2 size={13} /> Delete</button>
        </div>
      </article>)}</section>}
      {!timers.length && !schedules.length && <div className="timers-empty" role="status"><Clock size={28} aria-hidden="true" /><strong>No timers or schedules</strong><span>Create a schedule to run an agent or workflow later.</span>{!creating && <button onClick={() => setCreating(true)} disabled={busy}><Plus size={14} aria-hidden="true" /> Create schedule</button>}</div>}
      {timers.length > 0 && <section className="timer-section" aria-label="AI continuations"><header className="timer-section-header"><Bot size={13} aria-hidden="true" /><span>AI continuations</span><span>{timers.length}</span></header>{timers.map((timer) => {
        const run = runs.find((item) => item.id === timer.workflowRunId);
        const task = tasks.find((item) => timer.workspace.endsWith(`/${item.id}/workspace`));
        const internal = timer.workspace.includes("/workflow-sessions/");
        const owner = timer.workflowRunId ? run?.definition?.blocks.find((block) => block.id === timer.workflowBlockId)?.label ?? `Workflow ${run?.id.slice(0, 8) ?? timer.workflowRunId.slice(0, 8)}` : internal ? "Internal workflow session" : task?.name ?? "Workspace session";
        const provider = providers.find((item) => item.id === timer.provider)?.name ?? timer.provider;
        const seconds = Math.max(0, Math.ceil((new Date(timer.dueAt).getTime() - now) / 1000));
        const remaining = seconds ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s` : "Due now";
        return <article className="timer-entry" key={timer.id} aria-label={`${owner} timer`}>
          <div className="timer-title"><Bot size={14} aria-hidden="true" /><strong title={owner}>{owner}</strong><span className="timer-provider" title={provider}>{provider}</span></div>
          <div className="timer-countdown" role="timer">{remaining}</div>
          <time dateTime={timer.dueAt}>{new Date(timer.dueAt).toLocaleString()}</time>
          <p className="timer-prompt">{timer.prompt}</p>
          <details><summary>Session details</summary><div>{timer.workspace}</div>{timer.workflowBlockId && <div>Workflow block: {timer.workflowBlockId}</div>}<div>Created: {new Date(timer.createdAt).toLocaleString()}</div></details>
          <div className="timer-actions">
            <button disabled={busy} onClick={() => void execute(() => onAction(timer.id, "fire"))}><Play size={13} /> Run now</button>
            <button title="Cancel the scheduled prompt; the current AI turn keeps running" disabled={busy} onClick={() => void execute(() => onAction(timer.id, "cancel"))}><Square size={13} /> Cancel timer</button>
          </div>
        </article>;
      })}</section>}
    </div>
  </>;
}
