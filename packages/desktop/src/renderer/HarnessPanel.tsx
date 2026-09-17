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
  onCancelRun(runId: string): Promise<void>;
  onError(message: string): void;
};

export function HarnessPanel({ harnesses, runs, providers, agents, defaultProvider, onLoadModels, onCreate, onSave, onDelete, onRun, onCancelRun, onError }: Props) {
  const arrowMarkerId = `harness-arrow-${useId().replace(/:/g, "")}`;
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<HarnessDefinition>();
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [connectFrom, setConnectFrom] = useState<string>();
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [createName, setCreateName] = useState<string>();
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
  const running = run?.status === "queued" || run?.status === "running" || run?.status === "waiting";
  const blockById = useMemo(() => new Map(draft?.blocks.map((item) => [item.id, item]) ?? []), [draft?.blocks]);

  const create = async () => {
    const name = createName?.trim();
    if (!name) return;
    try { const harness = await onCreate(name); setSelectedId(harness.id); setCreateName(undefined); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not create harness"); }
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try { const harness = await onSave(draft); setSelectedId(harness.id); setDraft(structuredClone(harness)); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not save harness"); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!draft || !window.confirm(`Delete harness ${draft.name}?`)) return;
    try { await onDelete(draft.id); setSelectedId(undefined); setDraft(undefined); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not delete harness"); }
  };
  const start = async () => { if (!draft || dirty || !input.trim()) return; try { await onRun(draft.id, input); } catch (error) { onError(error instanceof Error ? error.message : "Could not run harness"); } };
  const addBlock = () => {
    if (!draft) return;
    const id = crypto.randomUUID();
    const next: HarnessBlock = { id, type: "prompt", label: `Prompt ${draft.blocks.length + 1}`, prompt: draft.blocks.length ? "Use the preceding result to continue:\n\n{{input}}" : "{{input}}", position: { x: 32 + (draft.blocks.length % 3) * 220, y: 30 + Math.floor(draft.blocks.length / 3) * 170 } };
    setDraft({ ...draft, blocks: [...draft.blocks, next] }); setSelectedBlockId(id);
  };
  const removeBlock = (id: string) => {
    if (!draft) return;
    setDraft({ ...draft, blocks: draft.blocks.filter((item) => item.id !== id), edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id) });
    setSelectedBlockId(undefined); setConnectFrom((current) => current === id ? undefined : current);
  };
  const connectTo = (id: string) => {
    if (!draft) return;
    if (!connectFrom || connectFrom === id) return;
    if (draft.edges.some((edge) => edge.from === connectFrom && edge.to === id)) onError("These blocks are already connected");
    else if (wouldCreateCycle(draft, connectFrom, id)) onError("That connection would create a cycle");
    else setDraft({ ...draft, edges: [...draft.edges, { id: crypto.randomUUID(), from: connectFrom, to: id }] });
    setConnectFrom(undefined);
  };
  const pointerDown = (event: ReactPointerEvent, item: HarnessBlock) => {
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

  return <div className="harness-panel">
    {createName !== undefined ? <form className="harness-create" onSubmit={(event) => { event.preventDefault(); void create(); }}><input autoFocus aria-label="Harness name" value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="New Harness" /><button type="submit" disabled={!createName.trim()}>Create</button><button type="button" title="Cancel harness creation" onClick={() => setCreateName(undefined)}><X size={14} /></button></form> : <div className="harness-picker"><select aria-label="Selected harness" value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value || undefined)}><option value="">Select a harness</option>{harnesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button title="Create harness" onClick={() => setCreateName("New Harness")}><Plus size={14} /></button><button title="Delete harness" disabled={!draft} onClick={() => void remove()}><Trash2 size={14} /></button></div>}
    {!draft ? <div className="harness-empty"><strong>Build an AI workflow</strong><span>Create a harness, add prompt blocks, then connect their execution order.</span><button onClick={() => setCreateName("New Harness")}><Plus size={14} /> Create harness</button></div> : <>
      <div className="harness-toolbar"><input aria-label="Harness name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><button title="Add prompt block" onClick={addBlock}><Plus size={14} /> Block</button><button title="Save harness" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? "Saving" : "Save"}</button></div>
      {connectFrom && <div className="harness-connect-hint">Select an input port to connect from <strong>{blockById.get(connectFrom)?.label}</strong>. <button onClick={() => setConnectFrom(undefined)}>Cancel</button></div>}
      <div className="harness-canvas" onPointerMove={pointerMove} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
        <svg aria-label="Harness connections"><defs><marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" /></marker></defs>{draft.edges.map((edge) => { const from = blockById.get(edge.from); const to = blockById.get(edge.to); if (!from || !to) return null; return <path key={edge.id} className="harness-edge" d={edgePath(from, to)} markerEnd={`url(#${arrowMarkerId})`}><title>{`${from.label} then ${to.label}`}</title></path>; })}</svg>
        {draft.blocks.map((item) => { const state = run?.blocks.find((block) => block.blockId === item.id); const preview = responsePreview(state?.output, state?.status); return <div key={item.id} className={`harness-block ${selectedBlockId === item.id ? "selected" : ""} ${connectFrom === item.id ? "connecting" : ""}`} style={{ left: item.position.x, top: item.position.y }} onPointerDown={(event) => pointerDown(event, item)} onClick={() => setSelectedBlockId(item.id)}><button className="harness-port input" aria-label={`Connect into ${item.label}`} title="Input: connect selected block here" disabled={!connectFrom || connectFrom === item.id} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); connectTo(item.id); }} /><button className="harness-port output" aria-label={`Connect from ${item.label}`} title={connectFrom === item.id ? "Cancel connection" : "Output: start connection"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setConnectFrom((current) => current === item.id ? undefined : item.id); }} /><header><span className={`harness-status ${state?.status ?? "idle"}`} />{item.label}</header><small>{state?.status === "running" ? "Running…" : state?.error ?? item.model ?? item.provider ?? "Default model"}</small><div className={`harness-response-preview ${state?.output ? "available" : ""}`} title={state?.output} aria-label={`${item.label} response preview`}>{preview}</div><footer><button title="Delete block" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeBlock(item.id); }}><Trash2 size={12} /></button></footer></div>; })}
        {!draft.blocks.length && <button className="harness-canvas-empty" onClick={addBlock}><Plus size={16} /> Add the first prompt block</button>}
      </div>
      {block && <div className="harness-inspector"><header><strong>Block settings</strong><button title="Close block settings" onClick={() => setSelectedBlockId(undefined)}>×</button></header><label>Name<input value={block.label} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, label: event.target.value } : item) })} /></label><div className="harness-fields"><label>Provider<select value={block.provider ?? ""} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, provider: event.target.value || undefined, model: undefined } : item) })}><option value="">Default</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><div className="harness-model-field"><ModelPicker models={blockModels} value={block.model ?? ""} label={`${providers.find((provider) => provider.id === blockProvider)?.name ?? "AI"} model`} disabled={!blockProvider || !blockModels.length} onChange={(model) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, model } : item) })} />{block.model && <button title="Use provider default model" onClick={() => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, model: undefined } : item) })}>Default</button>}</div></div><label>Agent<select value={block.agent ? `${block.agent.scope}:${block.agent.name}` : ""} onChange={(event) => { const agent = agents.find((item) => `${item.scope}:${item.name}` === event.target.value); setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, agent: agent ? { scope: agent.scope, name: agent.name } : undefined } : item) }); }}><option value="">None</option>{agents.map((item) => <option key={`${item.scope}:${item.name}`} value={`${item.scope}:${item.name}`}>{item.agent.name}</option>)}</select></label><label>Prompt template<textarea rows={5} value={block.prompt} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, prompt: event.target.value } : item) })} /></label><small className="harness-input-help">For root blocks, <code>{"{{input}}"}</code> is the harness activity. For connected blocks, it is the direct predecessor output.</small></div>}
      <div className="harness-run"><textarea aria-label="Harness prompt" rows={3} placeholder="Give this harness an activity…" value={input} onChange={(event) => setInput(event.target.value)} />{running ? <button className="danger" onClick={() => void onCancelRun(run!.id)}><Square size={13} /> Stop</button> : <button disabled={dirty || !input.trim() || !draft.blocks.length} title={dirty ? "Save changes before running" : "Run harness"} onClick={() => void start()}><Play size={14} /> Run</button>}<small className={run?.status === "failed" ? "error" : ""}>{dirty ? "Save changes before running." : run ? `Last run: ${run.status}${run.error ? ` — ${run.error}` : ""}` : "Runs use the same providers, agents, MCP tools, and sessions as the AI tab."}</small></div>
    </>}
  </div>;
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
