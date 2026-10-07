import { CalendarClock, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentFile, AiProviderDescriptor, HarnessDefinition, ScheduleInput, WorkspaceTask } from "@remote-ide/protocol";

function localDateTime(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ScheduleForm({ tasks, workflows, providers, selectedTaskId, defaultProvider, onLoadAgents, onCreate, onCancel }: {
  tasks: WorkspaceTask[]; workflows: HarnessDefinition[]; providers: AiProviderDescriptor[];
  selectedTaskId?: string; defaultProvider: string;
  onLoadAgents(taskId?: string): Promise<AgentFile[]>;
  onCreate(input: ScheduleInput): Promise<void>;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [taskId, setTaskId] = useState(selectedTaskId ?? "");
  const [type, setType] = useState<"prompt" | "workflow">("prompt");
  const [provider, setProvider] = useState(defaultProvider);
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [agentKey, setAgentKey] = useState("");
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState("");
  const [harnessId, setHarnessId] = useState(workflows[0]?.id ?? "");
  const [startBlockId, setStartBlockId] = useState("");
  const starts = (workflows.find((item) => item.id === harnessId)?.blocks ?? []).filter((block) => block.type === "start_button" || block.type === "start_input");
  useEffect(() => { setStartBlockId(starts[0]?.id ?? ""); }, [harnessId]);
  const [prompt, setPrompt] = useState("");
  const [dueAt, setDueAt] = useState(() => localDateTime(new Date(Date.now() + 300_000)));
  const [repeat, setRepeat] = useState(false);
  const [interval, setInterval] = useState(1);
  const [unit, setUnit] = useState(3600);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setAgentsLoading(true); setAgentsError(""); setAgents([]); setAgentKey("");
    void onLoadAgents(taskId || undefined).then((items) => { if (current) setAgents(items); }).catch((error) => { if (current) setAgentsError(error instanceof Error ? error.message : "Could not load agents"); }).finally(() => { if (current) setAgentsLoading(false); });
    return () => { current = false; };
  }, [taskId, onLoadAgents]);
  return <form className="schedule-form" aria-label="New schedule" onSubmit={(event) => {
    event.preventDefault();
    if (saving) return;
    const date = new Date(dueAt);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setError("Choose a first run time in the future."); return; }
    const agent = agents.find((item) => `${item.scope}:${item.name}` === agentKey);
    setSaving(true); setError("");
    void onCreate({ name, dueAt: date.toISOString(), ...(repeat ? { intervalSeconds: interval * unit } : {}), ...(taskId ? { taskId } : {}), action: type === "workflow" ? { type, provider, harnessId, input: prompt, ...(startBlockId ? { startBlockId } : {}) } : { type, provider, prompt, ...(agent ? { agent: { scope: agent.scope, name: agent.name } } : {}) } }).then(onCancel).catch((error) => setError(error instanceof Error ? error.message : "Could not create schedule")).finally(() => setSaving(false));
  }}>
    <header className="schedule-form-heading"><CalendarClock size={15} aria-hidden="true" /><strong>New schedule</strong><button type="button" aria-label="Close new schedule" title="Close new schedule" disabled={saving} onClick={onCancel}><X size={14} aria-hidden="true" /></button></header>
    <label>Name<input placeholder="e.g. Daily workspace review" required maxLength={180} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>Action<select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="prompt">Send a prompt</option><option value="workflow">Start a workflow</option></select></label>
    <label>Target task<select value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">Root workspace</option>{tasks.filter((task) => task.status !== "finished" && !task.archived).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label>
    <label>AI provider<select required value={provider} onChange={(event) => setProvider(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {type === "prompt" ? <label>Agent preset<select value={agentKey} disabled={agentsLoading} onChange={(event) => setAgentKey(event.target.value)}><option value="">Default agent</option>{agents.map((agent) => <option key={`${agent.scope}:${agent.name}`} value={`${agent.scope}:${agent.name}`}>{agent.agent.name} ({agent.scope})</option>)}</select></label> : <label>Workflow<select required value={harnessId} onChange={(event) => setHarnessId(event.target.value)}><option value="" disabled>Select workflow</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label>}
    {type === "workflow" && starts.length > 1 && <label>Start block<select required value={startBlockId} onChange={(event) => setStartBlockId(event.target.value)}>{starts.map((block) => <option key={block.id} value={block.id}>{block.label}</option>)}</select></label>}
    {type === "prompt" && agentsError && <p role="alert">{agentsError}</p>}
    <label>{type === "prompt" ? "Prompt" : "Workflow input"}<textarea placeholder={type === "prompt" ? "Describe what the agent should do…" : "Optional input to start the workflow…"} required={type === "prompt"} rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
    <label>First run (local time)<input type="datetime-local" required value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
    <label>Schedule<select value={repeat ? "repeat" : "once"} onChange={(event) => setRepeat(event.target.value === "repeat")}><option value="once">One time</option><option value="repeat">Recurring</option></select></label>
    {repeat && <div className="schedule-interval"><label>Repeat every<input type="number" required min={1} max={365} step={1} value={interval} onChange={(event) => setInterval(Number(event.target.value))} /></label><label>Interval unit<select value={unit} onChange={(event) => setUnit(Number(event.target.value))}><option value={60}>Minutes</option><option value={3600}>Hours</option><option value={86400}>Days</option></select></label></div>}
    <p className="timers-help">Core must be running to execute schedules. Missed runs execute once after restart. Busy targets or failed launches pause the schedule for review.</p>
    {error && <p role="alert">{error}</p>}
    <div className="timer-actions"><button className="primary" type="submit" disabled={saving || (type === "prompt" && (agentsLoading || Boolean(agentsError)))}><Plus size={13} aria-hidden="true" />{saving ? "Saving…" : "Create schedule"}</button><button type="button" disabled={saving} onClick={onCancel}><X size={13} aria-hidden="true" />Cancel</button></div>
  </form>;
}
