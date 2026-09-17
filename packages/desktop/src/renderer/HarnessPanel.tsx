import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link2, Play, Plus, Save, Square, Trash2 } from "lucide-react";
import type { AgentFile, AiProviderDescriptor, HarnessBlock, HarnessDefinition, HarnessRun } from "@remote-ide/protocol";

type Props = {
  harnesses: HarnessDefinition[];
  runs: HarnessRun[];
  providers: AiProviderDescriptor[];
  agents: AgentFile[];
  onCreate(name: string): Promise<HarnessDefinition>;
  onSave(harness: HarnessDefinition): Promise<HarnessDefinition>;
  onDelete(id: string): Promise<void>;
  onRun(harnessId: string, input: string): Promise<HarnessRun>;
  onCancelRun(runId: string): Promise<void>;
  onError(message: string): void;
};

export function HarnessPanel({ harnesses, runs, providers, agents, onCreate, onSave, onDelete, onRun, onCancelRun, onError }: Props) {
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<HarnessDefinition>();
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [connectFrom, setConnectFrom] = useState<string>();
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ id: string; dx: number; dy: number }>();
  const selected = harnesses.find((item) => item.id === selectedId);
  useEffect(() => { if (!selectedId && harnesses[0]) setSelectedId(harnesses[0].id); }, [harnesses, selectedId]);
  useEffect(() => { setDraft(selected ? structuredClone(selected) : undefined); setSelectedBlockId(undefined); }, [selected?.id, selected?.version]);
  const block = draft?.blocks.find((item) => item.id === selectedBlockId);
  const dirty = Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));
  const run = runs.find((item) => item.harnessId === selectedId);
  const running = run?.status === "queued" || run?.status === "running" || run?.status === "waiting";
  const blockById = useMemo(() => new Map(draft?.blocks.map((item) => [item.id, item]) ?? []), [draft?.blocks]);

  const create = async () => {
    const name = window.prompt("Harness name", "New Harness")?.trim();
    if (!name) return;
    try { const harness = await onCreate(name); setSelectedId(harness.id); }
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
    const next: HarnessBlock = { id, type: "prompt", label: `Prompt ${draft.blocks.length + 1}`, prompt: draft.blocks.length ? "Use the preceding result to continue:\n\n{{input}}" : "{{input}}", position: { x: 32 + (draft.blocks.length % 3) * 220, y: 30 + Math.floor(draft.blocks.length / 3) * 150 } };
    setDraft({ ...draft, blocks: [...draft.blocks, next] }); setSelectedBlockId(id);
  };
  const removeBlock = (id: string) => {
    if (!draft) return;
    setDraft({ ...draft, blocks: draft.blocks.filter((item) => item.id !== id), edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id) });
    setSelectedBlockId(undefined); setConnectFrom((current) => current === id ? undefined : current);
  };
  const chooseForConnection = (id: string) => {
    if (!draft) return;
    if (!connectFrom) { setConnectFrom(id); return; }
    if (connectFrom !== id && !draft.edges.some((edge) => edge.from === connectFrom && edge.to === id)) setDraft({ ...draft, edges: [...draft.edges, { id: crypto.randomUUID(), from: connectFrom, to: id }] });
    setConnectFrom(undefined);
  };
  const pointerDown = (event: ReactPointerEvent, item: HarnessBlock) => {
    const target = event.currentTarget as HTMLElement; target.setPointerCapture(event.pointerId);
    drag.current = { id: item.id, dx: event.clientX - item.position.x, dy: event.clientY - item.position.y };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft || !drag.current) return;
    const bounds = event.currentTarget.getBoundingClientRect(); const item = drag.current;
    setDraft({ ...draft, blocks: draft.blocks.map((block) => block.id === item.id ? { ...block, position: { x: Math.max(8, event.clientX - bounds.left - item.dx), y: Math.max(8, event.clientY - bounds.top - item.dy) } } : block) });
  };

  return <div className="harness-panel">
    <div className="harness-picker"><select aria-label="Selected harness" value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value || undefined)}><option value="">Select a harness</option>{harnesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button title="Create harness" onClick={() => void create()}><Plus size={14} /></button><button title="Delete harness" disabled={!draft} onClick={() => void remove()}><Trash2 size={14} /></button></div>
    {!draft ? <div className="harness-empty"><strong>Build an AI workflow</strong><span>Create a harness, add prompt blocks, then connect their execution order.</span><button onClick={() => void create()}><Plus size={14} /> Create harness</button></div> : <>
      <div className="harness-toolbar"><input aria-label="Harness name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><button title="Add prompt block" onClick={addBlock}><Plus size={14} /> Block</button><button title="Save harness" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? "Saving" : "Save"}</button></div>
      <div className="harness-canvas" onPointerMove={pointerMove} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
        <svg aria-hidden="true">{draft.edges.map((edge) => { const from = blockById.get(edge.from); const to = blockById.get(edge.to); if (!from || !to) return null; return <line key={edge.id} x1={from.position.x + 176} y1={from.position.y + 43} x2={to.position.x} y2={to.position.y + 43} />; })}</svg>
        {draft.blocks.map((item) => { const state = run?.blocks.find((block) => block.blockId === item.id); return <div key={item.id} className={`harness-block ${selectedBlockId === item.id ? "selected" : ""} ${connectFrom === item.id ? "connecting" : ""}`} style={{ left: item.position.x, top: item.position.y }} onPointerDown={(event) => pointerDown(event, item)} onClick={() => setSelectedBlockId(item.id)}><header><span className={`harness-status ${state?.status ?? "idle"}`} />{item.label}</header><small>{state?.status === "running" ? "Running…" : state?.error ?? item.model ?? item.provider ?? "Default model"}</small><footer><button title={connectFrom ? "Connect here" : "Start connection"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); chooseForConnection(item.id); }}><Link2 size={12} /></button><button title="Delete block" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeBlock(item.id); }}><Trash2 size={12} /></button></footer></div>; })}
        {!draft.blocks.length && <button className="harness-canvas-empty" onClick={addBlock}><Plus size={16} /> Add the first prompt block</button>}
      </div>
      {block && <div className="harness-inspector"><header><strong>Block settings</strong><button title="Close block settings" onClick={() => setSelectedBlockId(undefined)}>×</button></header><label>Name<input value={block.label} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, label: event.target.value } : item) })} /></label><div className="harness-fields"><label>Provider<select value={block.provider ?? ""} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, provider: event.target.value || undefined } : item) })}><option value="">Default</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label>Model<input placeholder="Provider default" value={block.model ?? ""} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, model: event.target.value || undefined } : item) })} /></label></div><label>Agent<select value={block.agent ? `${block.agent.scope}:${block.agent.name}` : ""} onChange={(event) => { const agent = agents.find((item) => `${item.scope}:${item.name}` === event.target.value); setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, agent: agent ? { scope: agent.scope, name: agent.name } : undefined } : item) }); }}><option value="">None</option>{agents.map((item) => <option key={`${item.scope}:${item.name}`} value={`${item.scope}:${item.name}`}>{item.agent.name}</option>)}</select></label><label>Prompt template<textarea rows={5} value={block.prompt} onChange={(event) => setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, prompt: event.target.value } : item) })} /></label></div>}
      <div className="harness-run"><textarea aria-label="Harness prompt" rows={3} placeholder="Give this harness an activity…" value={input} onChange={(event) => setInput(event.target.value)} />{running ? <button className="danger" onClick={() => void onCancelRun(run!.id)}><Square size={13} /> Stop</button> : <button disabled={dirty || !input.trim() || !draft.blocks.length} title={dirty ? "Save changes before running" : "Run harness"} onClick={() => void start()}><Play size={14} /> Run</button>}<small className={run?.status === "failed" ? "error" : ""}>{dirty ? "Save changes before running." : run ? `Last run: ${run.status}${run.error ? ` — ${run.error}` : ""}` : "Runs use the same providers, agents, MCP tools, and sessions as the AI tab."}</small></div>
    </>}
  </div>;
}
