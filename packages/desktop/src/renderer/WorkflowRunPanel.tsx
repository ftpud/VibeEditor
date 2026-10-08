import { useId, useMemo, useState } from "react";
import { Play, Square, Workflow, RotateCcw, ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";
import type { HarnessBlock, HarnessDefinition, HarnessRun } from "@remote-ide/protocol";
import { BlockRunDetails, PauseResolution, WorkflowMessage, type HarnessPanelProps } from "./HarnessPanel";
import { useWorkflowTraces } from "./workflow-tracing";

type Props = Pick<HarnessPanelProps, "harnesses" | "runs" | "diagnostics" | "onRun" | "onChat" | "onValidate" | "onCancelRun" | "onResolvePermission" | "onAnswerQuestion" | "onResumePause" | "onRetryPause" | "onCancelPause" | "onError">;
const activeStatuses = new Set(["queued", "running", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"]);
const pauseStatuses = new Set(["awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"]);
const statusLabel = (status: string) => status.replaceAll("_", " ");

export function WorkflowRunPanel(props: Props) {
  const [filter, setFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string>();
  const expandedWorkflowId = props.harnesses.some((workflow) => workflow.id === expandedId) ? expandedId : undefined;
  const workflows = props.harnesses.filter((workflow) => workflow.id === expandedWorkflowId || workflow.name.toLowerCase().includes(filter.toLowerCase()));
  return <div className={`workflow-run-panel harness-panel${expandedWorkflowId ? " expanded" : ""}`}>
    <div className="workflow-library-toolbar" hidden={!!expandedWorkflowId}>
    <div className="workflow-library-heading"><strong>View / Run</strong><span>{props.harnesses.length} workflows</span></div>
    <input className="workflow-filter" aria-label="Filter workflows" placeholder="Find a workflow…" value={filter} onChange={(event) => setFilter(event.target.value)} />
    {!!props.diagnostics?.length && <div role="alert" className="harness-connect-hint">Workflow state recovered from backup. {props.diagnostics.map((item) => item.reason).join("; ")}</div>}
    </div>
    <div className="workflow-library">{workflows.map((workflow) => <WorkflowCard key={workflow.id} {...props} workflow={workflow} runs={props.runs.filter((run) => run.harnessId === workflow.id)} expanded={expandedWorkflowId === workflow.id} hidden={!!expandedWorkflowId && expandedWorkflowId !== workflow.id} onToggleExpanded={() => setExpandedId((current) => current === workflow.id ? undefined : workflow.id)} />)}</div>
    {!workflows.length && <div className="harness-empty"><Workflow size={30} /><strong>{props.harnesses.length ? "No matching workflows" : "No workflows yet"}</strong><span>{props.harnesses.length ? "Try another name." : "Create your first workflow in Workflow design."}</span></div>}
  </div>;
}

function WorkflowCard({ workflow, expanded, hidden, onToggleExpanded, ...props }: Props & { workflow: HarnessDefinition; expanded: boolean; hidden: boolean; onToggleExpanded(): void }) {
  const [collapsed, setCollapsed] = useState(true);
  const bodyId = useId();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [startedRun, setStartedRun] = useState<HarnessRun>();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [showStarts, setShowStarts] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [error, setError] = useState("");
  const runs = [...props.runs, ...(startedRun && !props.runs.some((run) => run.id === startedRun.id) ? [startedRun] : [])].sort((a, b) => Number(activeStatuses.has(b.status)) - Number(activeStatuses.has(a.status)) || b.createdAt.localeCompare(a.createdAt));
  const run = runs.find((item) => item.id === selectedRunId) ?? runs[0];
  const definition = run?.definition ?? workflow;
  const selectedBlock = definition.blocks.find((block) => block.id === selectedBlockId);
  const starts = workflow.blocks.filter((block) => block.type === "start_button" || block.type === "start_input");
  const activeRuns = runs.filter((item) => activeStatuses.has(item.status));
  const completed = run?.blocks.filter((block) => block.status === "succeeded").length ?? 0;
  const act = async (action: () => Promise<unknown>) => {
    setError("");
    try { await action(); } catch (cause) { const message = cause instanceof Error ? cause.message : "Workflow operation failed"; setError(message); props.onError(message); }
  };
  const start = async (block?: HarnessBlock, snapshot?: HarnessRun) => {
    if (starting) return;
    setStarting(true);
    await act(async () => {
      const input = snapshot?.input ?? (block?.type === "start_button" ? block.prompt : inputs[block?.id ?? "default"] ?? "");
      if (!input.trim()) return;
      if (!snapshot && props.onValidate) {
        const result = await props.onValidate(workflow);
        if (!result.valid) throw new Error(result.issues.map((issue) => issue.message).join("; "));
      }
      const next = await props.onRun(workflow.id, input, block?.id, snapshot?.id);
      setStartedRun(next); setSelectedRunId(next.id); setShowStarts(false); setSelectedBlockId(undefined);
    });
    setStarting(false);
  };
  const renderStart = (block?: HarnessBlock) => {
    const key = block?.id ?? "default";
    const value = block?.type === "start_button" ? block.prompt : inputs[key] ?? "";
    const label = block?.label ?? "Run workflow";
    return <form key={key} className="workflow-start-control" onSubmit={(event) => { event.preventDefault(); void start(block); }}>
      <label>{label}{block?.type !== "start_button" && <textarea rows={3} aria-label={`Input for ${label}`} placeholder="Describe the task…" value={value} onChange={(event) => setInputs((current) => ({ ...current, [key]: event.target.value }))} />}</label>
      {block?.type === "start_button" && <WorkflowMessage title="Prompt" value={value} />}
      <button type="submit" disabled={starting || !value.trim() || !workflow.blocks.length} aria-label={`Start ${label}`}><Play size={13} />{starting ? "Starting…" : "Start"}</button>
    </form>;
  };
  return <article className={`workflow-card${run && activeStatuses.has(run.status) ? " live" : ""}${collapsed ? " collapsed" : ""}${expanded ? " expanded" : ""}`} aria-label={workflow.name} hidden={hidden}>
    <header><Workflow size={16} aria-hidden="true" /><strong title={workflow.name}>{workflow.name}</strong><span className={`workflow-overall-status ${run?.status ?? "idle"}`} role="status" aria-label={statusLabel(run?.status ?? "Ready")} title={statusLabel(run?.status ?? "Ready")}><i className={`harness-status ${run?.status ?? "idle"}`} /></span><div className="workflow-view-controls">
      <button type="button" aria-label={`${collapsed ? "Show" : "Collapse"} ${workflow.name}`} title={collapsed ? "Show workflow content" : "Collapse workflow"} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => { setCollapsed((current) => !current); if (expanded) onToggleExpanded(); }}>{collapsed ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}</button>
      <button type="button" aria-label={`${expanded ? "Restore" : "Expand"} ${workflow.name}`} title={expanded ? "Restore item size" : "Expand to panel"} aria-pressed={expanded} onClick={() => { setCollapsed(false); onToggleExpanded(); }}>{expanded ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}</button>
    </div></header>
    <div id={bodyId} className="workflow-card-body" hidden={collapsed}>
    {run ? <>
      <div className="workflow-run-meta"><select aria-label={`Run for ${workflow.name}`} value={run.id} onChange={(event) => { setSelectedRunId(event.target.value); setSelectedBlockId(undefined); }}>{runs.map((item) => <option key={item.id} value={item.id}>{statusLabel(item.status)} · {new Date(item.createdAt).toLocaleString()}</option>)}</select><span>{completed}/{definition.blocks.length} complete</span></div>
      <details className="workflow-run-input"><summary>Run prompt</summary><WorkflowMessage key={run.id} title="Prompt" value={run.input} /></details>
      <CompactWorkflowPreview definition={definition} run={run} selectedBlockId={selectedBlockId} onSelect={setSelectedBlockId} />
      <div className="workflow-card-actions"><button aria-expanded={showStarts} onClick={() => setShowStarts((value) => !value)}><Play size={13} /> New run</button>{!activeStatuses.has(run.status) && run.definition && <button disabled={starting} onClick={() => void start(undefined, run)}><RotateCcw size={13} /> Rerun</button>}{activeRuns.map((active) => <button key={active.id} aria-label={`Stop run ${active.id}`} onClick={() => void act(() => props.onCancelRun(active.id))}><Square size={12} /> Stop{activeRuns.length > 1 ? ` · ${active.id.slice(0, 6)}` : ""}</button>)}</div>

      {run.blocks.filter((block) => pauseStatuses.has(block.status)).map((block) => <PauseResolution key={`${run.id}:${block.blockId}:${block.pauseId}`} {...props} run={run} block={block} label={definition.blocks.find((item) => item.id === block.blockId)?.label ?? block.blockId} yesNo={definition.blocks.find((item) => item.id === block.blockId)?.type === "yes_no_prompt"} />)}
      {run.error && <p className="workflow-card-error">{run.error}</p>}{!!run.cleanupErrors?.length && <p className="workflow-card-error">{run.cleanupErrors.join("; ")}</p>}
    </> : <><p className="workflow-card-hint">{workflow.blocks.length} blocks · {workflow.blocks.some((block) => block.type === "chatbox") ? "Open a Chatbox or choose a starting point" : "Choose a starting point"}</p><CompactWorkflowPreview definition={definition} selectedBlockId={selectedBlockId} onSelect={setSelectedBlockId} /></>}
    {selectedBlock && <BlockRunDetails key={`${run?.id ?? workflow.id}:${selectedBlock.id}`} block={selectedBlock} run={run} state={run?.blocks.find((block) => block.blockId === selectedBlock.id)} tasks={run?.children?.filter((child) => child.blockId === selectedBlock.id)} onClose={() => setSelectedBlockId(undefined)} onChat={props.onChat ? async (message) => { const next = await props.onChat!(workflow.id, selectedBlock.id, message, run?.id); setStartedRun(next); setSelectedRunId(next.id); } : undefined} onCancelChat={run ? () => props.onCancelRun(run.id) : undefined} definition={definition} />}
    {(!run || showStarts) && <div className="workflow-starts">{starts.length ? starts.map((block) => renderStart(block)) : renderStart()}</div>}
    {error && <p role="alert" className="workflow-card-error">{error}</p>}
    </div>
  </article>;
}

function CompactWorkflowPreview({ definition, run, selectedBlockId, onSelect }: { definition: HarnessDefinition; run?: HarnessRun; selectedBlockId?: string; onSelect(id: string): void }) {
  const traces = useWorkflowTraces(run);
  const blocks = useMemo(() => {
    const source = definition.blocks;
    const minX = source.length ? Math.min(...source.map((block) => block.position.x)) : 0;
    const minY = source.length ? Math.min(...source.map((block) => block.position.y)) : 0;
    const spanY = Math.max(0, ...source.map((block) => block.position.y - minY));
    // Preserve the saved arrangement, removing vertical space until cards
    // with overlapping horizontal bounds have only an 8px gap.
    let scaleY = spanY ? 32 / spanY : 0.2;
    for (let index = 0; index < source.length; index++) {
      const block = source[index]!;
      for (const other of source.slice(index + 1)) {
        const gapY = Math.abs(block.position.y - other.position.y);
        if (gapY && Math.abs(block.position.x - other.position.x) * 0.6 < 120) {
          scaleY = Math.max(scaleY, 32 / gapY);
        }
      }
    }
    scaleY = Math.min(0.6, scaleY);
    const spanX = Math.max(0, ...source.map((block) => block.position.x - minX));
    let scaleX = spanX ? 136 / spanX : 0.6;
    // Apply one scale per axis to keep the original branch arrangement.
    // Leave room for cards and their connections wherever rows overlap.
    for (let index = 0; index < source.length; index++) {
      const block = source[index]!;
      for (const other of source.slice(index + 1)) {
        const gapX = Math.abs(block.position.x - other.position.x);
        if (gapX && Math.abs(block.position.y - other.position.y) * scaleY < 32) {
          scaleX = Math.max(scaleX, 136 / gapX);
        }
      }
    }
    scaleX = Math.min(0.6, scaleX);
    return source.map((block) => ({ ...block, position: { x: 12 + (block.position.x - minX) * scaleX, y: 12 + (block.position.y - minY) * scaleY } }));
  }, [definition]);
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const width = Math.max(280, ...blocks.map((block) => block.position.x + 132));
  const height = Math.max(70, ...blocks.map((block) => block.position.y + 36));
  return <div className="workflow-compact-preview" aria-label="Live workflow tree"><svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
    {definition.edges.map((edge) => {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      if (!from || !to) return null;
      const x = from.position.x + 120, y = from.position.y + 12, tx = to.position.x, ty = to.position.y + 12;
      const path = edge.loop || tx <= x ? `M ${x} ${y} C ${x + 24} ${y + 32}, ${tx - 24} ${ty + 32}, ${tx} ${ty}` : `M ${x} ${y} C ${(x + tx) / 2} ${y}, ${(x + tx) / 2} ${ty}, ${tx} ${ty}`;
      return <g key={edge.id}><path className={`workflow-compact-edge ${edge.type ?? "follow"}`} d={path}><title>{from.label} → {to.label} · {edge.type ?? "follow"}{edge.label ? `: ${edge.label}` : ""}</title></path>{traces.filter((trace) => trace.edgeId === edge.id).map((trace) => <path key={trace.id} className={`harness-transfer ${edge.type ?? "follow"} ${trace.direction} ${trace.status}`} d={path} pathLength={100} style={{ animationDelay: `${trace.delayMs}ms` }} />)}</g>;
    })}
    {blocks.map((block) => {
      const state = run?.blocks.find((item) => item.blockId === block.id);
      const status = state?.status ?? "idle";
      return <g key={block.id} className={`workflow-compact-block ${status}${selectedBlockId === block.id ? " selected" : ""}`} transform={`translate(${block.position.x}, ${block.position.y})`} role="button" tabIndex={0} aria-pressed={selectedBlockId === block.id} aria-label={`${block.label}: ${statusLabel(status)}`} onClick={() => onSelect(block.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(block.id); } }}><title>{block.label} · {statusLabel(status)}{state?.error ? ` · ${state.error}` : ""}</title><rect width={120} height={24} rx={5} /><circle cx={10} cy={12} r={3} /><text x={18} y={16}>{block.label.length > 15 ? `${block.label.slice(0, 14)}…` : block.label}</text></g>;
    })}
  </svg></div>;
}
