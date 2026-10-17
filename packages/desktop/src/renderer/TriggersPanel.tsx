import { Pause, Play, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import type { AgentFile, AiModel, AiProviderDescriptor, HarnessDefinition, TriggerInput, WorkspaceRoot, WorkspaceTask, WorkspaceTrigger } from "@remote-ide/protocol";

import { TriggerForm } from "./TriggerForm";

function describeSource(trigger: WorkspaceTrigger): string {
  return trigger.source.type === "fifo" ? `Pipe ${trigger.source.path}` : `File ${trigger.source.path} · ${trigger.source.events.join(", ")}`;
}

export function TriggersPanel({ triggers, workflows, roots, providers, tasks, selectedTaskId, defaultProvider, onLoadAgents, onLoadModels, onCreate, onAction, disabled = false, onRefresh, onError }: {
  triggers: WorkspaceTrigger[];
  workflows: HarnessDefinition[];
  roots: WorkspaceRoot[];
  providers: AiProviderDescriptor[];
  tasks: WorkspaceTask[];
  selectedTaskId?: string;
  defaultProvider: string;
  onLoadAgents(taskId?: string): Promise<AgentFile[]>;
  onLoadModels(provider: string): Promise<AiModel[]>;
  onCreate(input: TriggerInput): Promise<void>;
  onAction(id: string, action: "fire" | "pause" | "resume" | "delete"): Promise<void>;
  disabled?: boolean;
  onRefresh(): Promise<void>;
  onError(message: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const execute = async (action: () => Promise<void>) => {
    if (pending || disabled) return;
    setPending(true);
    try { await action(); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not update triggers"); }
    finally { setPending(false); }
  };
  const busy = pending || disabled;
  const active = triggers.filter((item) => item.enabled).length;
  return <>
    <header className="panel-header"><span>Triggers <span className="timers-total">{active}</span></span><div className="panel-header-actions">
      <button title="New trigger" aria-label="New trigger" disabled={busy} aria-expanded={creating} onClick={() => setCreating((open) => !open)}><Plus size={14} /></button>
      <button title="Refresh triggers" aria-label="Refresh triggers" disabled={busy} onClick={() => void execute(onRefresh)}><RefreshCw size={14} /></button>
    </div></header>
    <div className="timers-panel">
      <p className="timers-help">Start prompts and workflows when a file changes or data arrives on a named pipe.</p>
      {creating && <TriggerForm tasks={tasks} workflows={workflows} providers={providers} selectedTaskId={selectedTaskId} defaultProvider={defaultProvider} onLoadAgents={onLoadAgents} onLoadModels={onLoadModels} onCreate={onCreate} onCancel={() => setCreating(false)} />}
      {triggers.length > 0 && <section className="timer-section" aria-label="Triggers"><header className="timer-section-header"><Zap size={13} aria-hidden="true" /><span>Triggers</span><span>{triggers.length}</span></header>{triggers.map((trigger) => <article className="timer-entry" key={trigger.id} aria-label={`${trigger.name} trigger`}>
        <div className="timer-title"><Zap size={14} /><strong title={trigger.name}>{trigger.name}</strong><span className={`timer-state ${trigger.enabled ? "scheduled" : trigger.lastError ? "error" : "paused"}`}>{trigger.enabled ? "Watching" : "Paused"}</span></div>
        <p title={trigger.source.path}>{describeSource(trigger)}</p>
        <p>{trigger.action.type === "workflow" ? `Workflow: ${workflows.find((item) => item.id === ("harnessId" in trigger.action ? trigger.action.harnessId : ""))?.name ?? trigger.action.harnessId}` : `Prompt · ${trigger.action.newSession ? "new session · " : ""}${providers.find((item) => item.id === trigger.action.provider)?.name ?? trigger.action.provider}${trigger.action.agent ? ` · ${trigger.action.agent.name}` : ""}${trigger.action.model ? ` · ${trigger.action.model}${trigger.action.reasoning ? ` (${trigger.action.reasoning})` : ""}` : ""}`}</p>
        <p>{roots.find((root) => root.id === trigger.rootId)?.alias ?? trigger.rootId} · {trigger.taskId ? tasks.find((item) => item.id === trigger.taskId)?.name ?? `Task ${trigger.taskId}` : "Root workspace"} · Quiet {trigger.debounceSeconds ?? 2}s · Max {trigger.maxFiresPerHour ?? 20}/h</p>
        <p>Fired {trigger.fireCount} time{trigger.fireCount === 1 ? "" : "s"}{trigger.lastFiredAt ? ` · last ${new Date(trigger.lastFiredAt).toLocaleString()}` : ""}</p>
        {trigger.lastEvent && <p title={trigger.lastEvent}>Last event: {trigger.lastEvent}</p>}
        {trigger.lastSkipped && <p>Skipped: {trigger.lastSkipped}</p>}
        {trigger.lastError && <p className="schedule-error" role="alert">{trigger.lastError}</p>}
        <details><summary>{trigger.action.type === "prompt" ? "Prompt" : "Workflow input"}</summary><p className="timer-prompt">{trigger.action.type === "prompt" ? trigger.action.prompt : trigger.action.input}</p></details>
        <div className="timer-actions">
          <button disabled={busy} onClick={() => void execute(() => onAction(trigger.id, "fire"))}><Play size={13} /> Run now</button>
          <button disabled={busy} onClick={() => void execute(() => onAction(trigger.id, trigger.enabled ? "pause" : "resume"))}>{trigger.enabled ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}{trigger.enabled ? "Pause" : "Resume"}</button>
          <button className="danger" disabled={busy} onClick={() => void execute(() => onAction(trigger.id, "delete"))}><Trash2 size={13} /> Delete</button>
        </div>
      </article>)}</section>}
      {!triggers.length && <div className="timers-empty" role="status"><Zap size={28} aria-hidden="true" /><strong>No triggers</strong><span>Create a trigger to react to file changes or pipe messages.</span>{!creating && <button onClick={() => setCreating(true)} disabled={busy}><Plus size={14} aria-hidden="true" /> Create trigger</button>}</div>}
    </div>
  </>;
}
