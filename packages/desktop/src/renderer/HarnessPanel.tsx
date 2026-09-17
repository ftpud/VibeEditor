import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Play, Plus, Save, Square, Trash2, X } from "lucide-react";
import type { AgentFile, AiModel, AiProvider, AiProviderDescriptor, HarnessBlock, HarnessDefinition, HarnessRun } from "@remote-ide/protocol";
import { ModelPicker } from "./ModelPicker";

type Props = {
  harnesses: HarnessDefinition[];
  runs: HarnessRun[];
  providers: AiProviderDescriptor[];
  agents: AgentFile[];
  defaultProvider?: AiProvider;
  onLoadModels?(provider: AiProvider): Promise<AiModel[]>;
  onCreate(name: string): Promise<HarnessDefinition>;
  onSave(harness: HarnessDefinition): Promise<HarnessDefinition>;
  onDelete(id: string): Promise<void>;
  onRun(harnessId: string, input: string): Promise<HarnessRun>;
  onAppendRun?(runId: string, input: string): Promise<HarnessRun>;
  onCancelRun(runId: string): Promise<void>;
  onError(message: string): void;
};

export function HarnessPanel({ harnesses, runs, providers, agents, defaultProvider, onLoadModels, onCreate, onSave, onDelete, onRun, onAppendRun, onCancelRun, onError }: Props) {
  const arrowMarkerId = `harness-arrow-${useId().replace(/:/g, "")}`;
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<HarnessDefinition>();
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [connectFrom, setConnectFrom] = useState<string>();
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [createName, setCreateName] = useState<string>();
  const [mode, setMode] = useState<"view" | "edit">("edit");
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, AiModel[]>>({});
  const drag = useRef<{ id: string; grabX: number; grabY: number }>();
  const selected = harnesses.find((item) => item.id === selectedId);
  useEffect(() => { if (!selectedId && harnesses[0]) setSelectedId(harnesses[0].id); }, [harnesses, selectedId]);
  useEffect(() => { setDraft(selected ? structuredClone(selected) : undefined); setSelectedBlockId(undefined); }, [selected?.id, selected?.version]);
  const block = draft?.blocks.find((item) => item.id === selectedBlockId);
  const blockProvider = block?.provider ?? defaultProvider;
  const blockModels = blockProvider ? modelsByProvider[blockProvider] ?? [] : [];
  useEffect(() => {
    if (!blockProvider || modelsByProvider[blockProvider] || !onLoadModels) return;
    let active = true;
    void onLoadModels(blockProvider).then((models) => { if (active) setModelsByProvider((current) => ({ ...current, [blockProvider]: models })); }).catch((error) => { if (active) onError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { active = false; };
  }, [blockProvider, modelsByProvider, onError, onLoadModels]);
  const dirty = Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));
  const run = runs.find((item) => item.harnessId === selectedId);
  const activeRuns = runs.filter((item) => item.harnessId === selectedId && ["queued", "running", "waiting"].includes(item.status));
  const blockRun = run?.blocks.find((item) => item.blockId === selectedBlockId);
  const blockById = useMemo(() => new Map(draft?.blocks.map((item) => [item.id, item]) ?? []), [draft?.blocks]);

  const create = async () => {
    const name = createName?.trim();
    if (!name) return;
    try { const harness = await onCreate(name); setSelectedId(harness.id); setCreateName(undefined); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not create workflow"); }
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try { const harness = await onSave(draft); setSelectedId(harness.id); setDraft(structuredClone(harness)); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not save workflow"); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!draft || !window.confirm(`Delete workflow ${draft.name}?`)) return;
    try { await onDelete(draft.id); setSelectedId(undefined); setDraft(undefined); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not delete workflow"); }
  };
  const start = async () => { if (!draft || dirty || !input.trim()) return; try { if (activeRuns[0] && onAppendRun) await onAppendRun(activeRuns[0].id, input); else await onRun(draft.id, input); setInput(""); } catch (error) { onError(error instanceof Error ? error.message : "Could not send workflow input"); } };
  const addBlock = () => {
    if (!draft) return;
    const id = crypto.randomUUID();
    const next: HarnessBlock = { id, type: "prompt", label: `Prompt ${draft.blocks.length + 1}`, prompt: draft.blocks.length ? "Use the preceding result to continue:\n\n{{input}}" : "{{input}}", position: { x: 32 + (draft.blocks.length % 3) * 220, y: 30 + Math.floor(draft.blocks.length / 3) * 170 } };
    setDraft({ ...draft, blocks: [...draft.blocks, next] }); setSelectedBlockId(id);
  };
  const removeBlock = (id: string) => {
    if (!draft || mode !== "edit") return;
    setDraft({ ...draft, blocks: draft.blocks.filter((item) => item.id !== id), edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id) });
    setSelectedBlockId(undefined); setConnectFrom((current) => current === id ? undefined : current);
  };
  const connectTo = (id: string) => {
    if (!draft || mode !== "edit") return;
    if (!connectFrom || connectFrom === id) return;
    if (draft.edges.some((edge) => edge.from === connectFrom && edge.to === id)) onError("These blocks are already connected");
    else if (wouldCreateCycle(draft, connectFrom, id)) onError("That connection would create a cycle");
    else setDraft({ ...draft, edges: [...draft.edges, { id: crypto.randomUUID(), from: connectFrom, to: id, label: draft.blocks.find((item) => item.id === id)?.label ?? "Next" }] });
    setConnectFrom(undefined);
  };
  const pointerDown = (event: ReactPointerEvent, item: HarnessBlock) => {
    if (mode !== "edit") return;
    const target = event.currentTarget as HTMLElement; target.setPointerCapture(event.pointerId);
    const bounds = target.getBoundingClientRect();
    drag.current = { id: item.id, grabX: event.clientX - bounds.left, grabY: event.clientY - bounds.top };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft || !drag.current) return;
    const bounds = event.currentTarget.getBoundingClientRect(); const item = drag.current;
    const position = dragPosition(event.clientX, event.clientY, bounds.left, bounds.top, event.currentTarget.scrollLeft, event.currentTarget.scrollTop, item.grabX, item.grabY);
    setDraft({ ...draft, blocks: draft.blocks.map((block) => block.id === item.id ? { ...block, position } : block) });
  };

  return <div className={`harness-panel ${mode}`}>
    {createName !== undefined ? <form className="harness-create" onSubmit={(event) => { event.preventDefault(); void create(); }}><input autoFocus aria-label="Workflow name" value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="New Workflow" /><button type="submit" disabled={!createName.trim()}>Create</button><button type="button" title="Cancel workflow creation" onClick={() => setCreateName(undefined)}><X size={14} /></button></form> : <div className="harness-picker"><select aria-label="Selected workflow" value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value || undefined)}><option value="">Select a workflow</option>{harnesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{mode === "edit" && <><button title="Create workflow" onClick={() => setCreateName("New Workflow")}><Plus size={14} /></button><button title="Delete workflow" disabled={!draft} onClick={() => void remove()}><Trash2 size={14} /></button></>}<div className="harness-mode" role="group" aria-label="Workflow mode"><button className={mode === "view" ? "active" : ""} onClick={() => { setMode("view"); setConnectFrom(undefined); }}>View</button><button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>Edit</button></div></div>}
    {!draft ? <div className="harness-empty"><strong>Build an AI workflow</strong><span>Create a workflow, add prompt blocks, then connect their execution order.</span><button onClick={() => setCreateName("New Workflow")}><Plus size={14} /> Create workflow</button></div> : <>
      {mode === "edit" ? <div className="harness-toolbar"><input aria-label="Workflow name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><button title="Add prompt block" onClick={addBlock}><Plus size={14} /> Block</button><button title="Save workflow" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? "Saving" : "Save"}</button></div> : <div className="harness-view-summary"><strong>{draft.name}</strong><span>{run ? `Last run: ${run.status}` : "No runs yet"}</span></div>}
      {mode === "edit" && connectFrom && <div className="harness-connect-hint">Select an input port to connect from <strong>{blockById.get(connectFrom)?.label}</strong>. <button onClick={() => setConnectFrom(undefined)}>Cancel</button></div>}
      <div className={`harness-canvas ${mode}`} onPointerMove={pointerMove} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
        <svg aria-label="Workflow connections"><defs><marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" /></marker></defs>{draft.edges.map((edge) => { const from = blockById.get(edge.from); const to = blockById.get(edge.to); if (!from || !to) return null; const labelX = (from.position.x + to.position.x) / 2 + BLOCK_WIDTH / 2; const labelY = (from.position.y + to.position.y) / 2 + BLOCK_HEIGHT / 2 - 7; return <g key={edge.id}><path className="harness-edge" d={edgePath(from, to)} markerEnd={`url(#${arrowMarkerId})`}><title>{`${from.label} then ${to.label}`}</title></path>{edge.label && <text className="harness-edge-label" x={labelX} y={labelY} textAnchor="middle">{edge.label}</text>}</g>; })}</svg>
        {draft.blocks.map((item) => { const state = run?.blocks.find((block) => block.blockId === item.id); const preview = responsePreview(state?.output, state?.status); return <div key={item.id} className={`harness-block ${selectedBlockId === item.id ? "selected" : ""} ${connectFrom === item.id ? "connecting" : ""}`} style={{ left: item.position.x, top: item.position.y }} onPointerDown={(event) => pointerDown(event, item)} onClick={() => setSelectedBlockId(item.id)}><button className="harness-port input" aria-label={`Connect into ${item.label}`} title="Input: connect selected block here" disabled={!connectFrom || connectFrom === item.id} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); connectTo(item.id); }} /><button className="harness-port output" aria-label={`Connect from ${item.label}`} title={connectFrom === item.id ? "Cancel connection" : "Output: start connection"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setConnectFrom((current) => current === item.id ? undefined : item.id); }} /><header><span className={`harness-status ${state?.status ?? "idle"}`} />{item.label}</header><small>{state?.status === "running" && state.iterations?.length ? `Stack item ${state.iterations.length} of ${state.plannedRuns ?? state.iterations.length}` : state?.status === "running" ? "Running…" : state?.error ?? item.model ?? item.provider ?? "Default model"}</small><div className={`harness-response-preview ${state?.output ? "available" : ""}`} title={state?.output} aria-label={`${item.label} response preview`}>{preview}</div><footer><button title="Delete block" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeBlock(item.id); }}><Trash2 size={12} /></button></footer></div>; })}
        {!draft.blocks.length && <button className="harness-canvas-empty" onClick={addBlock}><Plus size={16} /> Add the first prompt block</button>}
      </div>
      {block && mode === "view" && <BlockRunDetails block={block} state={blockRun} onClose={() => setSelectedBlockId(undefined)} />}
      {block && <div className="harness-inspector"><header><strong>Block settings</strong><button title="Close block settings" onClick={() => setSelectedBlockId(undefined)}>×</button></header><label>Name<input value={block.label} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, label: event.target.value } : item) })} /></label><label>Role<select aria-label="Block role" value={block.type} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, type: event.target.value as HarnessBlock["type"] } : item) })}><option value="prompt">AI agent</option><option value="task">Task orchestrator</option></select></label><div className="harness-fields"><label>Provider<select value={block.provider ?? ""} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, provider: event.target.value || undefined, model: undefined } : item) })}><option value="">Default</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><div className="harness-model-field"><ModelPicker models={blockModels} value={block.model ?? ""} label={`${providers.find((provider) => provider.id === blockProvider)?.name ?? "AI"} model`} disabled={!blockProvider || !blockModels.length} onChange={(model) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, model } : item) })} />{block.model && <button title="Use provider default model" onClick={() => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, model: undefined } : item) })}>Default</button>}</div></div><div className="harness-fields"><label>Incoming paths<select aria-label="Incoming path behavior" value={block.join ?? "all"} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, join: event.target.value as "all" | "any" } : item) })}><option value="all">Wait for all</option><option value="any">Continue after any</option></select></label><label>Outgoing paths<select aria-label="Outgoing path behavior" value={block.routing ?? "all"} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, routing: event.target.value as "all" | "ai" } : item) })}><option value="all">Start all paths</option><option value="ai">AI chooses one</option></select></label></div>{draft.edges.some((edge) => edge.from === block.id) && <div className="harness-routes"><strong>Outgoing path names</strong>{draft.edges.filter((edge) => edge.from === block.id).map((edge) => <label key={edge.id}>{blockById.get(edge.to)?.label ?? "Target"}<input aria-label={`Path to ${blockById.get(edge.to)?.label ?? edge.to}`} value={edge.label ?? ""} onChange={(event) => setDraft({ ...draft, edges: draft.edges.map((item) => item.id === edge.id ? { ...item, label: event.target.value } : item) })} /></label>)}</div>}<label>Agent<select value={block.agent ? `${block.agent.scope}:${block.agent.name}` : ""} onChange={(event) => { const agent = agents.find((item) => `${item.scope}:${item.name}` === event.target.value); setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, agent: agent ? { scope: agent.scope, name: agent.name } : undefined } : item) }); }}><option value="">None</option>{agents.map((item) => <option key={`${item.scope}:${item.name}`} value={`${item.scope}:${item.name}`}>{item.agent.name}</option>)}</select></label><label>Prompt template<textarea rows={5} value={block.prompt} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, prompt: event.target.value } : item) })} /></label><small className="harness-input-help">Every block keeps one AI session. Connected upstream agents can append prompts to that session with <code>workflow_run_stack</code>. Agents wait and resume themselves with <code>timer_set</code>. Task orchestrators use the task MCP tools to create, monitor, prompt, and merge visible task workspaces.</small></div>}
      <div className="harness-run"><textarea aria-label="Workflow input" rows={3} placeholder={activeRuns.length ? "Append another prompt to the active dispatcher…" : "Give this workflow an activity…"} value={input} onChange={(event) => setInput(event.target.value)} /><button disabled={dirty || !input.trim() || !draft.blocks.length} title={dirty ? "Save changes before running" : activeRuns.length ? "Append to the active dispatcher session" : "Run workflow"} onClick={() => void start()}><Play size={14} /> {activeRuns.length ? "Send" : "Run"}</button>{activeRuns.length > 0 && <button className="danger" title="Stop the active run" onClick={() => void onCancelRun(activeRuns[0]!.id)}><Square size={13} /> Stop</button>}<small className={run?.status === "failed" ? "error" : ""}>{dirty ? "Save changes before running." : activeRuns.length ? "The dispatcher session is active. New prompts are appended without restarting it." : run ? `Last run: ${run.status}${run.error ? ` — ${run.error}` : ""}` : "Workflow sessions enable provider autopilot so configured MCP orchestration can run unattended."}</small></div>
    </>}
  </div>;
}

function BlockRunDetails({ block, state, onClose }: { block: HarnessBlock; state?: HarnessRun["blocks"][number]; onClose(): void }) {
  return <section className="harness-run-details" aria-label={`${block.label} run details`}>
    <header><div><strong>{block.label}</strong><span className={`harness-run-state ${state?.status ?? "idle"}`}>{state?.status ?? "not run"}</span></div><button title="Close run details" onClick={onClose}>×</button></header>
    {!state ? <p className="harness-detail-empty">This block has not run yet.</p> : <>
      <div className="harness-detail-meta"><span>Provider: {state.provider ?? block.provider ?? "default"}</span>{state.workspace && <span>Persistent session: active</span>}{state.selectedRoute && <span>Route: {state.selectedRoute}</span>}{state.startedAt && <span>Started: {new Date(state.startedAt).toLocaleString()}</span>}</div>
      {state.iterations?.length ? <div className="harness-iteration-list"><strong>Stack items ({state.iterations.length}/{state.plannedRuns ?? state.iterations.length})</strong>{state.iterations.map((iteration) => <details key={iteration.index} open={iteration.index === state.iterations!.length}><summary><span>Item {iteration.index}</span><span className={`harness-run-state ${iteration.status}`}>{iteration.status}</span></summary>{iteration.prompt && <LogSection title="Prompt" value={iteration.prompt} />}{iteration.output && <LogSection title="Answer" value={iteration.output} />}{iteration.error && <LogSection title="Error" value={iteration.error} error />}</details>)}</div> : <>{state.prompt && <LogSection title="Prompt" value={state.prompt} />}{state.output && <LogSection title="Answer" value={state.output} />}{state.error && <LogSection title="Error" value={state.error} error />}</>}
    </>}
  </section>;
}

function LogSection({ title, value, error }: { title: string; value: string; error?: boolean }) {
  return <section className={`harness-log${error ? " error" : ""}`}><strong>{title}</strong><pre>{value}</pre></section>;
}

const BLOCK_WIDTH = 176;
const BLOCK_HEIGHT = 116;

export function responsePreview(output?: string, status?: HarnessRun["blocks"][number]["status"]): string {
  if (!output?.trim()) return status === "running" ? "Waiting for response…" : "No response yet";
  const compact = output.trim().replace(/\s+/g, " ");
  return compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
}

export function dragPosition(clientX: number, clientY: number, canvasLeft: number, canvasTop: number, scrollLeft: number, scrollTop: number, grabX: number, grabY: number): HarnessBlock["position"] {
  return { x: Math.max(8, clientX - canvasLeft + scrollLeft - grabX), y: Math.max(8, clientY - canvasTop + scrollTop - grabY) };
}

export function edgePath(from: HarnessBlock, to: HarnessBlock): string {
  const fromCenter = { x: from.position.x + BLOCK_WIDTH / 2, y: from.position.y + BLOCK_HEIGHT / 2 };
  const toCenter = { x: to.position.x + BLOCK_WIDTH / 2, y: to.position.y + BLOCK_HEIGHT / 2 };
  const horizontal = Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y);
  if (horizontal) {
    const direction = toCenter.x >= fromCenter.x ? 1 : -1;
    const startX = fromCenter.x + direction * BLOCK_WIDTH / 2; const endX = toCenter.x - direction * BLOCK_WIDTH / 2;
    const bend = Math.max(36, Math.abs(endX - startX) / 2);
    return `M ${startX} ${fromCenter.y} C ${startX + direction * bend} ${fromCenter.y}, ${endX - direction * bend} ${toCenter.y}, ${endX} ${toCenter.y}`;
  }
  const direction = toCenter.y >= fromCenter.y ? 1 : -1;
  const startY = fromCenter.y + direction * BLOCK_HEIGHT / 2; const endY = toCenter.y - direction * BLOCK_HEIGHT / 2;
  const bend = Math.max(36, Math.abs(endY - startY) / 2);
  return `M ${fromCenter.x} ${startY} C ${fromCenter.x} ${startY + direction * bend}, ${toCenter.x} ${endY - direction * bend}, ${toCenter.x} ${endY}`;
}

function wouldCreateCycle(harness: HarnessDefinition, from: string, to: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of harness.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge.to]);
  const pending = [to]; const visited = new Set<string>();
  while (pending.length) { const current = pending.pop()!; if (current === from) return true; if (visited.has(current)) continue; visited.add(current); pending.push(...outgoing.get(current) ?? []); }
  return false;
}
