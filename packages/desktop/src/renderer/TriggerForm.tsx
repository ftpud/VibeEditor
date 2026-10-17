import { Plus, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import type { AgentFile, AiModel, AiProviderDescriptor, HarnessDefinition, TriggerFileEvent, TriggerInput, WorkspaceTask } from "@remote-ide/protocol";

import { ActionModelFields } from "./ActionModelFields";

const FILE_EVENTS: { id: TriggerFileEvent; label: string }[] = [{ id: "changed", label: "Changed" }, { id: "created", label: "Created" }, { id: "deleted", label: "Deleted" }];

export function TriggerForm({ tasks, workflows, providers, selectedTaskId, defaultProvider, onLoadAgents, onLoadModels, onCreate, onCancel }: {
  tasks: WorkspaceTask[]; workflows: HarnessDefinition[]; providers: AiProviderDescriptor[];
  selectedTaskId?: string; defaultProvider: string;
  onLoadAgents(taskId?: string): Promise<AgentFile[]>;
  onLoadModels(provider: string): Promise<AiModel[]>;
  onCreate(input: TriggerInput): Promise<void>;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"file" | "fifo">("file");
  const [path, setPath] = useState("");
  const [events, setEvents] = useState<TriggerFileEvent[]>(["changed", "created"]);
  const [debounce, setDebounce] = useState(2);
  const [maxPerHour, setMaxPerHour] = useState(20);
  const [taskId, setTaskId] = useState(selectedTaskId ?? "");
  const [type, setType] = useState<"prompt" | "workflow">("prompt");
  const [provider, setProvider] = useState(defaultProvider);
  const [newSession, setNewSession] = useState(false);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [agentKey, setAgentKey] = useState("");
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState("");
  const [harnessId, setHarnessId] = useState(workflows[0]?.id ?? "");
  const [startBlockId, setStartBlockId] = useState("");
  const starts = (workflows.find((item) => item.id === harnessId)?.blocks ?? []).filter((block) => block.type === "start_button" || block.type === "start_input");
  useEffect(() => { setStartBlockId(starts[0]?.id ?? ""); }, [harnessId]);
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setAgentsLoading(true); setAgentsError(""); setAgents([]); setAgentKey("");
    void onLoadAgents(taskId || undefined).then((items) => { if (current) setAgents(items); }).catch((error) => { if (current) setAgentsError(error instanceof Error ? error.message : "Could not load agents"); }).finally(() => { if (current) setAgentsLoading(false); });
    return () => { current = false; };
  }, [taskId, onLoadAgents]);
  const toggleEvent = (event: TriggerFileEvent) => setEvents((current) => current.includes(event) ? current.filter((item) => item !== event) : [...current, event]);
  return <form className="schedule-form" aria-label="New trigger" onSubmit={(event) => {
    event.preventDefault();
    if (saving) return;
    if (sourceType === "file" && events.length === 0) { setError("Choose at least one file event."); return; }
    const agent = agents.find((item) => `${item.scope}:${item.name}` === agentKey);
    setSaving(true); setError("");
    void onCreate({
      name, taskId: taskId || undefined, debounceSeconds: debounce, maxFiresPerHour: maxPerHour,
      source: sourceType === "file" ? { type: "file", path: path.trim(), events } : { type: "fifo", path: path.trim() },
      action: type === "workflow" ? { type, provider, harnessId, input: prompt, ...(startBlockId ? { startBlockId } : {}) } : { type, provider, prompt, ...(newSession ? { newSession, ...(agent ? { agent: { scope: agent.scope, name: agent.name } } : {}), ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) } : {}) }
    }).then(onCancel).catch((error) => setError(error instanceof Error ? error.message : "Could not create trigger")).finally(() => setSaving(false));
  }}>
    <header className="schedule-form-heading"><Zap size={15} aria-hidden="true" /><strong>New trigger</strong><button type="button" aria-label="Close new trigger" title="Close new trigger" disabled={saving} onClick={onCancel}><X size={14} aria-hidden="true" /></button></header>
    <label>Name<input placeholder="e.g. Review when build log changes" required maxLength={180} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>Watch<select value={sourceType} onChange={(event) => setSourceType(event.target.value as typeof sourceType)}><option value="file">A file or folder</option><option value="fifo">A named pipe (FIFO)</option></select></label>
    <label>{sourceType === "file" ? "File or folder path" : "Pipe path"}<input required placeholder={sourceType === "file" ? "logs/build.log or /var/log/app.log" : "/tmp/vibe-events (created if missing)"} value={path} onChange={(event) => setPath(event.target.value)} /></label>
    {sourceType === "file" ? <fieldset className="trigger-events"><legend>Fire when it is</legend>{FILE_EVENTS.map((item) => <label key={item.id}><input type="checkbox" checked={events.includes(item.id)} onChange={() => toggleEvent(item.id)} />{item.label}</label>)}</fieldset> : <p className="timers-help">Each write to the pipe (for example <code>echo "build failed" &gt; pipe</code>) starts the action, and the text received is added to the prompt.</p>}
    <label>Action<select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="prompt">Send a prompt</option><option value="workflow">Start a workflow</option></select></label>
    <label>Target task<select value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">Root workspace</option>{tasks.filter((task) => task.status !== "finished" && !task.archived).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label>
    {type === "prompt" && <label>Session<select value={newSession ? "new" : "continue"} onChange={(event) => setNewSession(event.target.value === "new")}><option value="continue">Continue the current session</option><option value="new">Start a new session</option></select></label>}
    {type === "prompt" && <label>AI provider<select required value={provider} onChange={(event) => setProvider(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {type === "prompt" ? !newSession ? null : <label>Agent preset<select value={agentKey} disabled={agentsLoading} onChange={(event) => setAgentKey(event.target.value)}><option value="">Default agent</option>{agents.map((agent) => <option key={`${agent.scope}:${agent.name}`} value={`${agent.scope}:${agent.name}`}>{agent.agent.name} ({agent.scope})</option>)}</select></label> : <label>Workflow<select required value={harnessId} onChange={(event) => setHarnessId(event.target.value)}><option value="" disabled>Select workflow</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>}
    {type === "prompt" && newSession && <ActionModelFields provider={provider} model={model} reasoning={reasoning} onLoadModels={onLoadModels} onChange={(value) => { setModel(value.model); setReasoning(value.reasoning); }} />}
    {type === "workflow" && starts.length > 1 && <label>Start block<select required value={startBlockId} onChange={(event) => setStartBlockId(event.target.value)}>{starts.map((block) => <option key={block.id} value={block.id}>{block.label}</option>)}</select></label>}
    {type === "prompt" && newSession && agentsError && <p role="alert">{agentsError}</p>}
    <label>{type === "prompt" ? "Prompt" : "Workflow input"}<textarea placeholder={type === "prompt" ? "Describe what the agent should do when this fires…" : "Optional input to start the workflow…"} required={type === "prompt"} rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
    <div className="schedule-interval"><label>Quiet period (seconds)<input type="number" min={0} max={3600} step={1} required value={debounce} onChange={(event) => setDebounce(Number(event.target.value))} /></label><label>Max runs per hour<input type="number" min={1} max={1000} step={1} required value={maxPerHour} onChange={(event) => setMaxPerHour(Number(event.target.value))} /></label></div>
    <p className="timers-help">Events are grouped until the quiet period passes, and ignored while the target agent or previous workflow is still busy. If the hourly limit is hit the trigger disables itself to stop feedback loops. Core must be running; changes made while it is stopped are not replayed.</p>
    {error && <p role="alert">{error}</p>}
    <div className="timer-actions"><button className="primary" type="submit" disabled={saving || (type === "prompt" && newSession && (agentsLoading || Boolean(agentsError)))}><Plus size={13} aria-hidden="true" />{saving ? "Saving…" : "Create trigger"}</button><button type="button" disabled={saving} onClick={onCancel}><X size={13} aria-hidden="true" />Cancel</button></div>
  </form>;
}
