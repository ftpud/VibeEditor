import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Play, Plus, Save, Square, Trash2, X } from "lucide-react";
import type { AgentFile, AiModel, AiProvider, AiProviderDescriptor, HarnessBlock, HarnessDataSchema, HarnessDefinition, HarnessRun, HarnessLogEntry, HarnessStateDiagnostic, HarnessValidationIssue } from "@remote-ide/protocol";
import { useWorkflowTraces } from "./workflow-tracing";
import { ModelPicker } from "./ModelPicker";

type Props = {
  harnesses: HarnessDefinition[];
  runs: HarnessRun[];
  diagnostics?: HarnessStateDiagnostic[];
  providers: AiProviderDescriptor[];
  agents: AgentFile[];
  defaultProvider?: AiProvider;
  onLoadModels?(provider: AiProvider): Promise<AiModel[]>;
  onValidate?(harness: HarnessDefinition): Promise<{ valid: boolean; issues: HarnessValidationIssue[] }>;
  onCreate(name: string, template?: "five-minute-check-in" | "git-review-commit"): Promise<HarnessDefinition>;
  onRead?(id: string): Promise<HarnessDefinition>;
  onSave(harness: HarnessDefinition): Promise<HarnessDefinition>;
  onDelete(id: string): Promise<void>;
  onRun(harnessId: string, input: string, startBlockId?: string): Promise<HarnessRun>;
  onAppendRun?(runId: string, input: string): Promise<HarnessRun>;
  onResolvePermission?(runId: string, blockId: string, sessionId: string, pauseId: string, requestId: string, optionId?: string): Promise<HarnessRun>;
  onAnswerQuestion?(runId: string, blockId: string, sessionId: string, pauseId: string, input: string): Promise<HarnessRun>;
  onResumePause?(runId: string, blockId: string, pauseId: string): Promise<HarnessRun>;
  onRetryPause?(runId: string, blockId: string, pauseId: string): Promise<HarnessRun>;
  onCancelPause?(runId: string, blockId: string, pauseId: string): Promise<HarnessRun>;
  onCancelRun(runId: string): Promise<void>;
  onError(message: string): void;
};

export function HarnessPanel({ harnesses, runs, diagnostics = [], providers, agents, defaultProvider, onLoadModels, onValidate, onCreate, onRead, onSave, onDelete, onRun, onAppendRun, onResolvePermission, onAnswerQuestion, onResumePause, onRetryPause, onCancelPause, onCancelRun, onError }: Props) {
  const arrowMarkerId = `harness-arrow-${useId().replace(/:/g, "")}`;
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<HarnessDefinition>();
  const [baseline, setBaseline] = useState<HarnessDefinition>();
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [connectFrom, setConnectFrom] = useState<string>();
  const [connectionType, setConnectionType] = useState<"use" | "follow" | "path">("follow");
  const [startInputs, setStartInputs] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [createTemplate, setCreateTemplate] = useState<"" | "five-minute-check-in" | "git-review-commit">("");
  const [createName, setCreateName] = useState<string>();
  const [mode, setMode] = useState<"view" | "edit">("edit");
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, AiModel[]>>({});
  const [remoteValidationIssues, setRemoteValidationIssues] = useState<HarnessValidationIssue[]>([]);
  const [saveConflict, setSaveConflict] = useState<{ local: HarnessDefinition; remote: HarnessDefinition; comparing: boolean }>();
  const drag = useRef<{ id: string; grabX: number; grabY: number }>();
  const selected = harnesses.find((item) => item.id === selectedId);
  useEffect(() => { if (!selectedId && harnesses[0]) setSelectedId(harnesses[0].id); }, [harnesses, selectedId]);
  useEffect(() => { const next = selected ? structuredClone(selected) : undefined; setDraft(next); setBaseline(next); setSelectedBlockId(undefined); setSelectedEdgeId(undefined); setSaveConflict(undefined); }, [selected?.id, selected?.version]);
  const block = draft?.blocks.find((item) => item.id === selectedBlockId);
  const blockProvider = block && ["ai", "prompt", "task", "review"].includes(block.type) ? block.provider ?? defaultProvider : undefined;
  const blockModels = blockProvider ? modelsByProvider[blockProvider] ?? [] : [];
  useEffect(() => {
    if (!blockProvider || modelsByProvider[blockProvider] || !onLoadModels) return;
    let active = true;
    void onLoadModels(blockProvider).then((models) => { if (active) setModelsByProvider((current) => ({ ...current, [blockProvider]: models })); }).catch((error) => { if (active) onError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { active = false; };
  }, [blockProvider, modelsByProvider, onError, onLoadModels]);
  const dirty = Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline));
  const activeRuns = runs.filter((item) => item.harnessId === selectedId && activeRunStatuses.has(item.status));
  const workflowRuns = runs.filter((item) => item.harnessId === selectedId).sort((left, right) => Number(activeRunStatuses.has(right.status)) - Number(activeRunStatuses.has(left.status)) || right.createdAt.localeCompare(left.createdAt));
  const run = workflowRuns.find((item) => item.id === selectedRunId) ?? workflowRuns[0];
  useEffect(() => { if (selectedRunId && !workflowRuns.some((item) => item.id === selectedRunId)) setSelectedRunId(undefined); }, [selectedRunId, workflowRuns]);
  const animatedTraces = useWorkflowTraces(run);
  const blockRun = run?.blocks.find((item) => item.blockId === selectedBlockId);
  const pausedBlock = run?.blocks.find((item) => ["awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"].includes(item.status));
  const blockById = useMemo(() => new Map(draft?.blocks.map((item) => [item.id, item]) ?? []), [draft?.blocks]);
  const selectedEdge = draft?.edges.find((edge) => edge.id === selectedEdgeId);
  useEffect(() => {
    if (!draft || !onValidate) { setRemoteValidationIssues([]); return; }
    let active = true;
    const timer = window.setTimeout(() => { void onValidate(draft).then((result) => { if (active) setRemoteValidationIssues(result.issues); }).catch((error) => { if (active) onError(error instanceof Error ? error.message : "Could not validate workflow"); }); }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [draft, onError, onValidate]);
  const validationIssues = useMemo(() => [...remoteValidationIssues, ...availabilityIssues(draft, providers, agents, defaultProvider, modelsByProvider)], [agents, defaultProvider, draft, modelsByProvider, providers, remoteValidationIssues]);
  useEffect(() => {
    const warnBeforeClosing = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClosing);
    return () => window.removeEventListener("beforeunload", warnBeforeClosing);
  }, [dirty]);
  useEffect(() => {
    if (mode !== "edit" || !selectedEdgeId) return;
    const removeSelectedEdge = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target;
      if (target && "matches" in target && typeof target.matches === "function" && target.matches("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault(); setDraft((current) => current ? { ...current, edges: current.edges.filter((edge) => edge.id !== selectedEdgeId) } : current); setSelectedEdgeId(undefined);
    };
    window.addEventListener("keydown", removeSelectedEdge); return () => window.removeEventListener("keydown", removeSelectedEdge);
  }, [mode, selectedEdgeId]);

  const create = async () => {
    const name = createName?.trim();
    if (!name) return;
    try { const harness = createTemplate ? await onCreate(name, createTemplate) : await onCreate(name); setSelectedId(harness.id); setCreateName(undefined); setCreateTemplate(""); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not create workflow"); }
  };
  const discardDraft = () => !dirty || typeof window.confirm !== "function" || window.confirm("Discard unsaved workflow changes?");
  const validateCurrentDraft = async () => {
    if (!draft || !onValidate) return true;
    const result = await onValidate(draft);
    setRemoteValidationIssues(result.issues);
    return result.valid;
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (!await validateCurrentDraft()) return;
      const harness = await onSave(draft); const next = structuredClone(harness); setSelectedId(harness.id); setDraft(next); setBaseline(next);
    }
    catch (error) {
      if (draft && error instanceof Error && error.message.startsWith("CONFLICT:") && onRead) {
        try { setSaveConflict({ local: structuredClone(draft), remote: await onRead(draft.id), comparing: false }); }
        catch (readError) { onError(readError instanceof Error ? readError.message : "Could not load the changed workflow"); }
      } else onError(error instanceof Error ? error.message : "Could not save workflow");
    }
    finally { setSaving(false); }
  };
  const saveAsCopy = async () => {
    if (!saveConflict) return;
    setSaving(true);
    try {
      const copy = await onCreate(`${saveConflict.local.name} copy`);
      const saved = await onSave({ ...saveConflict.local, id: copy.id, name: copy.name, version: copy.version, createdAt: copy.createdAt, updatedAt: copy.updatedAt });
      const next = structuredClone(saved); setSelectedId(saved.id); setDraft(next); setBaseline(next); setSaveConflict(undefined);
    } catch (error) { onError(error instanceof Error ? error.message : "Could not save workflow copy"); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!draft || !window.confirm(`Delete workflow ${draft.name}?`)) return;
    try { await onDelete(draft.id); setSelectedId(undefined); setDraft(undefined); }
    catch (error) { onError(error instanceof Error ? error.message : "Could not delete workflow"); }
  };
  const start = async (startBlock?: HarnessBlock) => {
    const value = startBlock?.type === "start_button" ? startBlock.prompt : startBlock ? startInputs[startBlock.id] ?? "" : input;
    if (!draft || dirty || !value.trim()) return;
    try {
      if (!await validateCurrentDraft()) return;
      if (!startBlock && !draft.blocks.some((block) => flowBlockTypes.includes(block.type)) && activeRuns[0] && onAppendRun) await onAppendRun(activeRuns[0].id, value); else { const nextRun = await onRun(draft.id, value, startBlock?.id); setSelectedRunId(nextRun.id); }
      setInput("");
    } catch (error) { onError(error instanceof Error ? error.message : "Could not send workflow input"); }
  };
  const updateBlock = (changes: Partial<HarnessBlock>) => { if (draft && block) setDraft({ ...draft, blocks: draft.blocks.map((item) => item.id === block.id ? { ...item, ...changes } : item) }); };
  const addBlock = (type: HarnessBlock["type"] = "ai") => {
    if (!draft) return;
    const id = crypto.randomUUID();
    const next: HarnessBlock = { id, type, label: `${blockTypeLabels[type] ?? type} ${draft.blocks.length + 1}`, prompt: type === "start_button" ? "Start the workflow." : type === "start_input" || type === "timer" || type === "script" ? "" : "{{input}}", ...(type === "timer" ? { seconds: 60 } : {}), position: { x: 32 + (draft.blocks.length % 3) * 220, y: 30 + Math.floor(draft.blocks.length / 3) * 170 } };
    setDraft({ ...draft, blocks: [...draft.blocks, next] }); setSelectedBlockId(id);
  };
  const removeBlock = (id: string) => {
    if (!draft || mode !== "edit") return;
    setDraft({ ...draft, blocks: draft.blocks.filter((item) => item.id !== id), edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id) });
    setSelectedBlockId(undefined); setConnectFrom((current) => current === id ? undefined : current);
  };
  const removeEdge = (id: string) => { if (!draft || mode !== "edit") return; setDraft({ ...draft, edges: draft.edges.filter((edge) => edge.id !== id) }); setSelectedEdgeId(undefined); };
  const connectTo = (id: string) => {
    if (!draft || mode !== "edit") return;
    if (!connectFrom || connectFrom === id) return;
    if (draft.edges.some((edge) => edge.from === connectFrom && edge.to === id && (edge.type ?? "follow") === connectionType)) onError("These blocks are already connected");
    else { setDraft({ ...draft, edges: [...draft.edges, { id: crypto.randomUUID(), from: connectFrom, to: id, type: connectionType, label: draft.blocks.find((item) => item.id === id)?.label ?? "Next" }] }); }

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
    {diagnostics.length > 0 && <div className="harness-connect-hint" role="alert"><strong>Workflow state recovered from backup</strong><ul>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.source}:${diagnostic.detectedAt}:${index}`}>{diagnostic.source}: {diagnostic.reason}</li>)}</ul></div>}
    {createName !== undefined ? <form className="harness-create" onSubmit={(event) => { event.preventDefault(); void create(); }}><input autoFocus aria-label="Workflow name" value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="New Workflow" /><select aria-label="Workflow template" value={createTemplate} onChange={(event) => { const template = event.target.value as typeof createTemplate; setCreateTemplate(template); if (template && createName === "New Workflow") setCreateName(template === "git-review-commit" ? "Review, commit & ask to push" : "Five-minute workspace check-in"); }}><option value="">Blank workflow</option><option value="five-minute-check-in">Five-minute workspace check-in · all blocks</option><option value="git-review-commit">Review, commit & ask to push · Git command blocks</option></select><button type="submit" disabled={!createName.trim()}>Create</button><button type="button" title="Cancel workflow creation" onClick={() => setCreateName(undefined)}><X size={14} /></button></form> : <div className="harness-picker"><select aria-label="Selected workflow" value={selectedId ?? ""} onChange={(event) => { const nextId = event.target.value || undefined; if (nextId !== selectedId && discardDraft()) setSelectedId(nextId); }}><option value="">Select a workflow</option>{harnesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{mode === "edit" && <><button title="Create workflow" onClick={() => { if (discardDraft()) setCreateName("New Workflow"); }}><Plus size={14} /></button><button title="Delete workflow" disabled={!draft} onClick={() => void remove()}><Trash2 size={14} /></button></>}<div className="harness-mode" role="group" aria-label="Workflow mode"><button className={mode === "view" ? "active" : ""} onClick={() => { if (mode !== "view" && !discardDraft()) return; setMode("view"); setConnectFrom(undefined); }}>View</button><button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>Edit</button></div></div>}
    {!draft ? <div className="harness-empty"><strong>Build an AI workflow</strong><span>Add a start block, connect followers, and give AI Agents tools and paths.</span><button onClick={() => setCreateName("New Workflow")}><Plus size={14} /> Create workflow</button></div> : <>
      {mode === "edit" ? <div className="harness-toolbar"><input aria-label="Workflow name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><select aria-label="Add block type" value="" onChange={(event) => { if (event.target.value) addBlock(event.target.value as HarnessBlock["type"]); }}><option value="">+ Add block</option>{flowBlockTypes.map((type) => <option key={type} value={type}>{blockTypeLabels[type]}</option>)}</select><button title="Save workflow" disabled={!dirty || saving || validationIssues.length > 0} onClick={() => void save()}><Save size={14} /> {saving ? "Saving" : "Save"}</button></div> : <div className="harness-view-summary"><strong>{draft.name}</strong>{workflowRuns.length ? <select aria-label="Selected workflow run" value={run?.id ?? ""} onChange={(event) => setSelectedRunId(event.target.value)}>{workflowRuns.map((item) => <option key={item.id} value={item.id}>{activeRunStatuses.has(item.status) ? "● " : ""}{item.status} · {new Date(item.createdAt).toLocaleString()} · {item.input.slice(0, 50)}</option>)}</select> : <span>No runs yet</span>}{activeRuns.length > 1 && <small>{activeRuns.length} active runs</small>}</div>}
      {validationIssues.length > 0 && <div className="harness-connect-hint" role="alert"><strong>{validationIssues.length} workflow issue{validationIssues.length === 1 ? "" : "s"}</strong><ul>{validationIssues.map((issue, index) => <li key={`${issue.code}:${issue.blockId ?? issue.edgeId ?? index}`}><button onClick={() => { if (issue.blockId) { setSelectedBlockId(issue.blockId); setSelectedEdgeId(undefined); } else if (issue.edgeId) { setSelectedEdgeId(issue.edgeId); setSelectedBlockId(undefined); } }}>{issue.message}</button></li>)}</ul></div>}
      {saveConflict && <div className="harness-conflict" role="alert"><strong>This workflow was changed elsewhere.</strong><span>The saved version is {saveConflict.remote.version}; your draft is version {saveConflict.local.version}.</span><div><button onClick={() => { const next = structuredClone(saveConflict.remote); setDraft(next); setBaseline(next); setSaveConflict(undefined); }}>Reload</button><button onClick={() => setSaveConflict((current) => current ? { ...current, comparing: !current.comparing } : current)}>{saveConflict.comparing ? "Hide comparison" : "Compare"}</button><button onClick={() => void saveAsCopy()} disabled={saving}>Save as copy</button></div>{saveConflict.comparing && <div className="harness-conflict-comparison"><section><strong>Your draft</strong><pre>{JSON.stringify(saveConflict.local, null, 2)}</pre></section><section><strong>Saved workflow</strong><pre>{JSON.stringify(saveConflict.remote, null, 2)}</pre></section></div>}</div>}
      {mode === "edit" && connectFrom && <div className="harness-connect-hint">Select an input port to connect from <strong>{blockById.get(connectFrom)?.label}</strong>. <select aria-label="New connection type" value={connectionType} onChange={(event) => setConnectionType(event.target.value as typeof connectionType)}><option value="follow">Follow · pass output when done</option>{blockById.get(connectFrom)?.type === "ai" && <><option value="use">Use · expose as an MCP tool</option><option value="path">Path · AI chooses</option></>}</select> <button onClick={() => setConnectFrom(undefined)}>Cancel</button></div>}
      {mode === "edit" && selectedEdge && <div className="harness-connect-hint harness-edge-controls">Selected connection: <strong>{blockById.get(selectedEdge.from)?.label} → {blockById.get(selectedEdge.to)?.label}</strong><label>Type<select aria-label="Connection type" value={selectedEdge.type ?? "follow"} onChange={(event) => setDraft({ ...draft, edges: draft.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, type: event.target.value as "use" | "follow" | "path", loop: undefined, execution: undefined } : edge) })}><option value="follow">Follow</option>{blockById.get(selectedEdge.from)?.type === "ai" && <><option value="use">Use</option><option value="path">Path</option></>}</select></label>{selectedEdge.type === "path" && <label>Path name<input aria-label="Path name" value={selectedEdge.label ?? ""} onChange={(event) => setDraft({ ...draft, edges: draft.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, label: event.target.value } : edge) })} /></label>}<button onClick={() => removeEdge(selectedEdge.id)}>Remove connection</button></div>}
      <div className={`harness-canvas ${mode}`} onClick={() => setSelectedEdgeId(undefined)} onPointerMove={pointerMove} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
        <svg aria-label="Workflow connections" style={{ width: Math.max(1200, ...draft.blocks.map((block) => block.position.x + BLOCK_WIDTH + 80)), height: Math.max(800, ...draft.blocks.map((block) => block.position.y + BLOCK_HEIGHT + 80)) }}><defs><marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" /></marker></defs>{draft.edges.map((edge) => { const from = blockById.get(edge.from); const to = blockById.get(edge.to); if (!from || !to) return null; const lane = draft.edges.filter((item) => item.from === edge.from && item.to === edge.to).findIndex((item) => item.id === edge.id) * 16; const labelX = (from.position.x + to.position.x) / 2 + BLOCK_WIDTH / 2; const labelY = (from.position.y + to.position.y) / 2 + BLOCK_HEIGHT / 2 - 7 + lane + (edge.loop ? 45 : 0); const title = edge.loop ? `${from.label} loops to ${to.label}` : `${from.label} then ${to.label}`; const traces = animatedTraces.filter((trace) => trace.edgeId === edge.id); const path = edgePath(from, to, edge.loop, lane); return <g key={edge.id}><path className={`harness-edge ${edge.type ?? "follow"}${edge.loop ? " loop" : ""}${selectedEdgeId === edge.id ? " selected" : ""}`} d={path} markerEnd={`url(#${arrowMarkerId})`} role={mode === "edit" ? "button" : undefined} aria-label={mode === "edit" ? `Select connection: ${title}` : undefined} tabIndex={mode === "edit" ? 0 : undefined} onClick={mode === "edit" ? (event) => { event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedBlockId(undefined); } : undefined}><title>{title}</title></path>{traces.map((trace) => <path key={trace.id} className={`harness-transfer ${edge.type ?? "follow"} ${trace.direction} ${trace.status}`} d={path} pathLength={100} style={{ animationDelay: `${trace.delayMs}ms` }} aria-label={`${trace.direction === "return" ? "Output" : "Input"}: ${trace.direction === "return" ? to.label : from.label} → ${trace.direction === "return" ? from.label : to.label}`} />)}{edge.label && <text className="harness-edge-label" x={labelX} y={labelY} textAnchor="middle">{`${edge.type ?? "follow"}${edge.type === "path" ? `: ${edge.label}` : ""}`}</text>}</g>; })}</svg>
        {draft.blocks.map((item) => { const state = run?.blocks.find((block) => block.blockId === item.id); const preview = responsePreview(state?.output, state?.status); const inputActive = animatedTraces.some((trace) => { const edge = draft.edges.find((edge) => edge.id === trace.edgeId); return trace.direction === "return" ? edge?.from === item.id : edge?.to === item.id; }); const outputActive = animatedTraces.some((trace) => { const edge = draft.edges.find((edge) => edge.id === trace.edgeId); return trace.direction === "return" ? edge?.to === item.id : edge?.from === item.id; }); return <div key={item.id} className={`harness-block ${state?.status === "running" ? "working" : ""} ${selectedBlockId === item.id ? "selected" : ""} ${connectFrom === item.id ? "connecting" : ""}`} style={{ left: item.position.x, top: item.position.y }} onPointerDown={(event) => pointerDown(event, item)} onClick={() => setSelectedBlockId(item.id)}><button className={`harness-port input${inputActive ? " flowing" : ""}`} tabIndex={mode === "view" ? -1 : 0} aria-label={`Connect into ${item.label}`} title="Input: connect selected block here" disabled={!connectFrom || connectFrom === item.id} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); connectTo(item.id); }} /><button className={`harness-port output${outputActive ? " flowing" : ""}`} disabled={mode === "view"} tabIndex={mode === "view" ? -1 : 0} aria-label={`Connect from ${item.label}`} title={connectFrom === item.id ? "Cancel connection" : "Output: start connection"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setConnectionType("follow"); setConnectFrom((current) => current === item.id ? undefined : item.id); }} /><header><span className={`harness-status ${state?.status ?? "idle"}`} />{item.label}</header><small>{state?.status === "running" && state.iterations?.length ? `Stack item ${state.iterations.length} of ${state.plannedRuns ?? state.iterations.length}` : state?.status === "running" ? "Running…" : state?.error ?? (item.type === "ai" || ["prompt", "task", "review"].includes(item.type) ? item.model ?? item.provider ?? "Default model" : blockTypeLabels[item.type] ?? item.type)}</small>{mode === "view" && (item.type === "start_button" || item.type === "start_input") ? <div className="harness-start" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>{item.type === "start_input" && <input aria-label={`Input for ${item.label}`} placeholder="Type text…" value={startInputs[item.id] ?? ""} onChange={(event) => setStartInputs((current) => ({ ...current, [item.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void start(item); }} />}<button disabled={dirty || validationIssues.length > 0 || !(item.type === "start_button" ? item.prompt : startInputs[item.id])?.trim()} onClick={() => void start(item)}><Play size={12} /> Start</button></div> : <div className={`harness-response-preview ${state?.output ? "available" : ""}`} title={state?.output} aria-label={`${item.label} response preview`}>{preview}</div>}<footer><button title="Delete block" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeBlock(item.id); }}><Trash2 size={12} /></button></footer></div>; })}
        {!draft.blocks.length && <button className="harness-canvas-empty" onClick={() => addBlock()}><Plus size={16} /> Add the first AI Agent</button>}
      </div>
      {block && mode === "view" && <BlockRunDetails block={block} state={blockRun} tasks={run?.children?.filter((child) => child.blockId === block.id)} onClose={() => setSelectedBlockId(undefined)} />}
      {block && mode === "edit" && <div className="harness-inspector"><header><strong>Block settings</strong><button title="Close block settings" onClick={() => setSelectedBlockId(undefined)}>×</button></header>
        <label>Name<input value={block.label} onChange={(event) => updateBlock({ label: event.target.value })} /></label>
        <label>Type<select aria-label="Block type" value={block.type} onChange={(event) => updateBlock({ type: event.target.value as HarnessBlock["type"], seconds: 60, watchdog: undefined, join: undefined, routing: undefined, review: undefined, verification: undefined })}>{!flowBlockTypes.includes(block.type) && <option value={block.type}>Legacy {block.type}</option>}{flowBlockTypes.map((type) => <option key={type} value={type}>{blockTypeLabels[type]}</option>)}</select></label>
        {["ai", "prompt", "task", "review"].includes(block.type) && <><div className="harness-fields"><label>Provider<select value={block.provider ?? ""} onChange={(event) => updateBlock({ provider: event.target.value || undefined, model: undefined })}><option value="">Default</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><ModelPicker models={blockModels} value={block.model ?? ""} label="AI model" onChange={(model) => updateBlock({ model })} /></div><label>Agent preset<select value={block.agent ? `${block.agent.scope}:${block.agent.name}` : ""} onChange={(event) => { const agent = agents.find((item) => `${item.scope}:${item.name}` === event.target.value); updateBlock({ agent: agent ? { scope: agent.scope, name: agent.name } : undefined }); }}><option value="">None</option>{agents.map((item) => <option key={`${item.scope}:${item.name}`} value={`${item.scope}:${item.name}`}>{item.agent.name}</option>)}</select></label><small>One context per AI Agent in each run. Use connected blocks through MCP; choose a path before finishing.</small></>}
        {block.type === "timer" && <><label>Delay in seconds<input aria-label="Timer seconds" type="number" min="0" max="86400" value={block.seconds ?? 60} onChange={(event) => updateBlock({ seconds: Number(event.target.value) })} /></label><small>Using this block arms its countdown and returns immediately. When it fires, its follow connections receive the input used to arm it.</small></>}
        {block.type === "script" && <><label>Shell script<textarea aria-label="Shell script" rows={6} value={block.command ?? ""} onChange={(event) => updateBlock({ command: event.target.value })} /></label><small>Runs in the Core workspace. Input arrives on stdin and in VIBE_WORKFLOW_INPUT. Stdout becomes this block’s output.</small></>}
        {!["timer", "script", "start_input"].includes(block.type) && <label>{block.type === "text" ? "Text" : ["user_prompt", "yes_no_prompt"].includes(block.type) ? "Question" : block.type === "start_button" ? "Start prompt" : "Instructions"}<textarea aria-label="Block prompt" rows={5} value={block.prompt} onChange={(event) => updateBlock({ prompt: event.target.value })} /></label>}
        <details><summary>Data schemas</summary><SchemaEditor title="Input schema" schema={block.inputSchema} onChange={(inputSchema) => updateBlock({ inputSchema })} /><SchemaEditor title="Output schema" schema={block.outputSchema} onChange={(outputSchema) => updateBlock({ outputSchema })} /></details>
        <small>Follow connections pass this block’s output into the next block. Templates support {'{{input}}'} and {'{{blocks.ID.output}}'}.</small>
      </div>}
      {block && mode === "edit" && <section className="harness-input-help" aria-label="Workflow execution preview"><strong>Execution preview</strong><p>{executionBehavior(block, draft.edges)}</p><pre aria-label="Rendered prompt preview">{previewPrompt(block.prompt, input)}</pre></section>}
      {run && pausedBlock && <PauseResolution run={run} block={pausedBlock} yesNo={blockById.get(pausedBlock.blockId)?.type === "yes_no_prompt"} label={blockById.get(pausedBlock.blockId)?.label ?? pausedBlock.blockId} onResolvePermission={onResolvePermission} onAnswerQuestion={onAnswerQuestion} onResumePause={onResumePause} onRetryPause={onRetryPause} onCancelPause={onCancelPause} onError={onError} />}
      {!draft.blocks.some((item) => item.type === "start_button" || item.type === "start_input") && <div className="harness-run"><textarea aria-label="Workflow input" rows={3} placeholder={activeRuns.length ? "Append another prompt to the active dispatcher…" : "Give this workflow an activity…"} value={input} onChange={(event) => setInput(event.target.value)} /><button disabled={dirty || validationIssues.length > 0 || !input.trim() || !draft.blocks.length} title={dirty ? "Save changes before running" : validationIssues.length ? "Fix workflow issues before running" : activeRuns.length ? "Append to the active dispatcher session" : "Run workflow"} onClick={() => void start()}><Play size={14} /> {activeRuns.length ? "Send" : "Run"}</button>{activeRuns.length > 0 && <button className="danger" title="Stop the active run" onClick={() => void onCancelRun(activeRuns[0]!.id)}><Square size={13} /> Stop</button>}<small className={run?.status === "failed" || run?.cleanupErrors?.length ? "error" : ""}>{dirty ? "Save changes before running." : validationIssues.length ? "Fix validation issues before running." : activeRuns.length ? pausedBlock ? `${pausedBlock.blockId} is waiting for your response.` : "The dispatcher session is active. New prompts are appended without restarting it." : run ? `Last run: ${run.status}${run.error ? ` — ${run.error}` : ""}${run.cleanupErrors?.length ? ` — Cleanup: ${run.cleanupErrors.join("; ")}` : ""}` : "Workflow sessions enable provider autopilot so configured MCP orchestration can run unattended."}</small></div>}
      {draft.blocks.some((item) => item.type === "start_button" || item.type === "start_input") && <div className="harness-run">{activeRuns.map((active) => <button key={active.id} onClick={() => void onCancelRun(active.id)}><Square size={13} /> Stop run</button>)}<small>{dirty ? "Save changes before starting." : run ? `Run: ${run.status}${run.error ? ` — ${run.error}` : ""}` : "Switch to View to start a flow from its start blocks."}</small></div>}
    </>}
  </div>;
}

function PauseResolution({ run, block, yesNo, label, onResolvePermission, onAnswerQuestion, onResumePause, onRetryPause, onCancelPause, onError }: { run: HarnessRun; block: HarnessRun["blocks"][number]; yesNo?: boolean; label: string; onResolvePermission?: Props["onResolvePermission"]; onAnswerQuestion?: Props["onAnswerQuestion"]; onResumePause?: Props["onResumePause"]; onRetryPause?: Props["onRetryPause"]; onCancelPause?: Props["onCancelPause"]; onError(message: string): void }) {
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const owned = Boolean(block.sessionId && block.pauseId);
  const identified = Boolean(block.pauseId);
  const submit = async (action: () => Promise<unknown>) => { setSubmitting(true); try { await action(); setAnswer(""); } catch (error) { onError(error instanceof Error ? error.message : "Could not resume workflow"); } finally { setSubmitting(false); } };
  const cancel = <button className="reject" disabled={!identified || submitting || !onCancelPause} onClick={() => void submit(() => onCancelPause!(run.id, block.blockId, block.pauseId!))}>Cancel run</button>;
  if (block.status === "awaiting_permission" && block.pendingPermission) return <section className="harness-pause" aria-label={`${label} permission request`}><strong>{label} needs permission</strong><span>{block.pendingPermission.title}</span>{block.pendingPermission.details && <pre>{block.pendingPermission.details}</pre>}<div>{block.pendingPermission.options.map((option) => <button key={option.optionId} className={option.kind.startsWith("allow") ? "allow" : "reject"} disabled={!owned || submitting || !onResolvePermission} onClick={() => void submit(() => onResolvePermission!(run.id, block.blockId, block.sessionId!, block.pauseId!, block.pendingPermission!.id, option.optionId))}>{option.name}</button>)}<button className="reject" disabled={!owned || submitting || !onResolvePermission} onClick={() => void submit(() => onResolvePermission!(run.id, block.blockId, block.sessionId!, block.pauseId!, block.pendingPermission!.id))}>Reject</button>{cancel}</div></section>;
  if (block.status === "awaiting_user_input" && yesNo) return <section className="harness-pause" aria-label={`${label} question`}><strong>{label}</strong>{block.question && <p>{block.question}</p>}<div>{(["yes", "no"] as const).map((value) => <button key={value} className={value === "yes" ? "allow" : "reject"} disabled={!owned || submitting || !onAnswerQuestion} onClick={() => void submit(() => onAnswerQuestion!(run.id, block.blockId, block.sessionId!, block.pauseId!, value))}>{value === "yes" ? "Yes" : "No"}</button>)}{cancel}</div></section>;
  if (block.status === "awaiting_user_input") return <section className="harness-pause" aria-label={`${label} question`}><strong>{label} needs input</strong>{block.question && <p>{block.question}</p>}<textarea aria-label={`Answer ${label}`} rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} /><div><button disabled={!owned || submitting || !answer.trim() || !onAnswerQuestion} onClick={() => void submit(() => onAnswerQuestion!(run.id, block.blockId, block.sessionId!, block.pauseId!, answer))}>Answer and resume</button>{cancel}</div></section>;
  if (block.status === "waiting_timer") return <section className="harness-pause" aria-label={`${label} timer pause`}><strong>{label} is waiting for a timer</strong>{block.waitingUntil && <span>Scheduled for {new Date(block.waitingUntil).toLocaleString()}</span>}<div><button className="allow" disabled={!identified || submitting || !onResumePause} onClick={() => void submit(() => onResumePause!(run.id, block.blockId, block.pauseId!))}>Resume now</button>{cancel}</div></section>;
  if (block.status === "retry_scheduled") return <section className="harness-pause" aria-label={`${label} retry pause`}><strong>{label} is waiting to retry</strong>{block.error && <p>{block.error}</p>}{block.retryAt && <span>Scheduled for {new Date(block.retryAt).toLocaleString()}</span>}<div><button className="allow" disabled={!identified || submitting || !onRetryPause} onClick={() => void submit(() => onRetryPause!(run.id, block.blockId, block.pauseId!))}>Retry now</button>{cancel}</div></section>;
  return null;
}

function SchemaEditor({ title, schema, onChange }: { title: string; schema?: HarnessDataSchema; onChange(schema?: HarnessDataSchema): void }) {
  const serialized = schema ? JSON.stringify(schema, null, 2) : "";
  const [value, setValue] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => { setValue(serialized); setError(undefined); }, [serialized]);
  const update = (next: string) => {
    setValue(next);
    if (!next.trim()) { setError(undefined); onChange(undefined); return; }
    try {
      const parsed: unknown = JSON.parse(next);
      if (!isDataSchema(parsed)) throw new Error("Use a schema object with a supported type");
      setError(undefined); onChange(parsed);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invalid JSON schema"); }
  };
  return <label> {title}<textarea aria-label={title} rows={5} value={value} placeholder={'{"type":"object","required":["featureId"],"properties":{"featureId":{"type":"string"}}}'} onChange={(event) => update(event.target.value)} />{error && <small className="error">{error}</small>}</label>;
}

function isDataSchema(value: unknown, depth = 0): value is HarnessDataSchema {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 10) return false;
  const schema = value as Record<string, unknown>;
  if (!['string', 'number', 'boolean', 'object', 'array'].includes(String(schema.type))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string" && key.length > 0))) return false;
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties) || !Object.values(schema.properties).every((property) => isDataSchema(property, depth + 1)))) return false;
  return schema.items === undefined || isDataSchema(schema.items, depth + 1);
}

function BlockRunDetails({ block, state, tasks, onClose }: { block: HarnessBlock; state?: HarnessRun["blocks"][number]; tasks?: HarnessRun["children"]; onClose(): void }) {
  return <section className="harness-run-details" aria-label={`${block.label} run details`}>
    <header><div><strong>{block.label}</strong><span className={`harness-run-state ${state?.status ?? "idle"}`}>{state?.status ?? "not run"}</span></div><button title="Close run details" onClick={onClose}>×</button></header>
    <div className="harness-run-details-body">{!state ? <p className="harness-detail-empty">This block has not run yet.</p> : <>
      {tasks?.length ? <section className="harness-execution-log"><strong>Owned implementation tasks</strong>{tasks.map((child) => <LogSection key={`${child.provider}:${child.taskId}`} title={`${child.taskId} · ${child.provider}`} value={`Recovery attempts: ${child.recoveryAttempts}/3${child.failureReason ? `\nFailure: ${child.failureReason.replaceAll("_", " ")}` : ""}${child.retryAt ? `\nRetry after: ${new Date(child.retryAt).toLocaleString()}` : ""}${child.recoveryError ? `\nLast recovery error: ${child.recoveryError}` : ""}`} error={Boolean(child.recoveryError)} />)}</section> : null}
      {block.watchdog && <p className="harness-detail-empty">Core-managed watchdog · no model calls{state.waitingUntil ? ` · Next check: ${new Date(state.waitingUntil).toLocaleString()}` : ""}</p>}
      {(state.failureReason || state.recoveryAttempts) && <p className="harness-detail-empty">{state.failureReason ? `Failure: ${state.failureReason.replaceAll("_", " ")} · ` : ""}Automatic recovery attempts: {state.recoveryAttempts ?? 0}/3{state.retryAt ? ` · Retry after: ${new Date(state.retryAt).toLocaleString()}` : ""}</p>}
      <div className="harness-detail-meta"><span>Provider: {state.provider ?? block.provider ?? "default"}</span>{state.workspace && <span>Persistent session: active</span>}{state.selectedRoute && <span>Route: {state.selectedRoute}</span>}{state.startedAt && <span>Started: {new Date(state.startedAt).toLocaleString()}</span>}</div>
      {state.log?.length ? <details className="harness-execution-log"><summary>Execution log ({state.log.length})</summary><div className="harness-execution-log-entries">{state.log.map((entry, index) => <LogEntry key={`${entry.timestamp}-${index}`} entry={entry} />)}</div></details> : null}
      {state.structuredInput !== undefined && <LogSection title="Validated input" value={JSON.stringify(state.structuredInput, null, 2)} />}
      {state.structuredOutput !== undefined && <LogSection title="Validated output" value={JSON.stringify(state.structuredOutput, null, 2)} />}
      {state.iterations?.length ? <div className="harness-iteration-list"><strong>Stack items ({state.iterations.length}/{state.plannedRuns ?? state.iterations.length})</strong>{state.iterations.map((iteration) => <details key={iteration.index} open={iteration.index === state.iterations!.length}><summary><span>Item {iteration.index}</span><span className={`harness-run-state ${iteration.status}`}>{iteration.status}</span></summary>{iteration.prompt && <LogSection title="Prompt" value={iteration.prompt} />}{iteration.output && <LogSection title="Answer" value={iteration.output} />}{iteration.error && <LogSection title="Error" value={iteration.error} error />}</details>)}</div> : <>{state.prompt && <LogSection title="Prompt" value={state.prompt} />}{state.output && <LogSection title="Answer" value={state.output} />}{state.error && <LogSection title="Error" value={state.error} error />}</>}
    </>}</div>
  </section>;
}

function LogSection({ title, value, error }: { title: string; value: string; error?: boolean }) {
  return <section className={`harness-log${error ? " error" : ""}`}><strong>{title}</strong><pre>{value}</pre></section>;
}

function LogEntry({ entry }: { entry: HarnessLogEntry }) {
  return <details className={`harness-log-entry ${entry.kind}`} open={entry.kind === "error"}><summary><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span>{entry.kind}</span></summary><pre>{entry.message}</pre></details>;
}

const BLOCK_WIDTH = 176;
const BLOCK_HEIGHT = 116;
const activeRunStatuses = new Set<HarnessRun["status"]>(["queued", "running", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"]);

function availabilityIssues(draft: HarnessDefinition | undefined, providers: AiProviderDescriptor[], agents: AgentFile[], defaultProvider: AiProvider | undefined, modelsByProvider: Record<string, AiModel[]>): HarnessValidationIssue[] {
  if (!draft) return [];
  const issues: HarnessValidationIssue[] = [];
  for (const block of draft.blocks) {
    if (flowBlockTypes.includes(block.type) && block.type !== "ai") continue;
    const provider = block.provider ?? defaultProvider;
    if (provider && providers.length && !providers.some((item) => item.id === provider)) issues.push({ code: "unavailable-provider", blockId: block.id, message: `Block '${block.label || block.id}' uses unavailable provider '${provider}'` });
    const models = provider ? modelsByProvider[provider] : undefined;
    if (block.model && models && !models.some((model) => model.id === block.model && model.available !== false)) issues.push({ code: "unavailable-model", blockId: block.id, message: `Block '${block.label || block.id}' uses unavailable model '${block.model}'` });
    if (block.agent && agents.length && !agents.some((agent) => agent.scope === block.agent!.scope && agent.name === block.agent!.name)) issues.push({ code: "unavailable-agent", blockId: block.id, message: `Block '${block.label || block.id}' uses unavailable agent '${block.agent.name}'` });
  }
  return issues;
}

function executionBehavior(block: HarnessBlock, edges: HarnessDefinition["edges"]): string {
  if (flowBlockTypes.includes(block.type)) return `Follow connections pass output to each follower. ${edges.some((edge) => edge.from === block.id && edge.type === "use") ? "Use connections make blocks available as MCP tools. " : ""}${edges.some((edge) => edge.from === block.id && edge.type === "path") ? "The AI chooses one path, which receives its final output." : ""}`;
  if (block.watchdog) return "Core watchdogs run independently, watch retryable delivery failures, and have no graph connections.";
  const incoming = block.join === "any" ? "starts when any incoming synchronous path completes" : "waits for every incoming synchronous path";
  const outgoing = block.routing === "ai" ? "asks the model to choose one named outgoing path" : "starts every outgoing path";
  const edgeBehavior = edges.some((edge) => edge.from === block.id && edge.execution === "async") ? " Async paths continue without waiting." : "";
  return `This block ${incoming} and ${outgoing}.${edgeBehavior}`;
}

function previewPrompt(template: string, input: string): string {
  return template.replace(/\{\{\s*(input|blocks\.([A-Za-z0-9_-]+)\.output|iteration)\s*\}\}/g, (_match, variable: string, blockId?: string) => variable === "input" ? input || "[workflow input]" : variable === "iteration" ? "[iteration]" : `[output from ${blockId}]`);
}

export function responsePreview(output?: string, status?: HarnessRun["blocks"][number]["status"]): string {
  if (!output?.trim()) return status === "running" ? "Waiting for response…" : "No response yet";
  const compact = output.trim().replace(/\s+/g, " ");
  return compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
}

export function dragPosition(clientX: number, clientY: number, canvasLeft: number, canvasTop: number, scrollLeft: number, scrollTop: number, grabX: number, grabY: number): HarnessBlock["position"] {
  return { x: Math.max(8, clientX - canvasLeft + scrollLeft - grabX), y: Math.max(8, clientY - canvasTop + scrollTop - grabY) };
}

export function edgePath(from: HarnessBlock, to: HarnessBlock, loop = false, lane = 0): string {
  const fromCenter = { x: from.position.x + BLOCK_WIDTH / 2, y: from.position.y + BLOCK_HEIGHT / 2 };
  const toCenter = { x: to.position.x + BLOCK_WIDTH / 2, y: to.position.y + BLOCK_HEIGHT / 2 };
  if (loop) {
    const startY = fromCenter.y + BLOCK_HEIGHT / 2; const endY = toCenter.y + BLOCK_HEIGHT / 2; const bendY = Math.max(startY, endY) + 58;
    return `M ${fromCenter.x} ${startY} C ${fromCenter.x} ${bendY}, ${toCenter.x} ${bendY}, ${toCenter.x} ${endY}`;
  }
  const horizontal = Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y);
  if (horizontal) {
    const direction = toCenter.x >= fromCenter.x ? 1 : -1;
    const startX = fromCenter.x + direction * BLOCK_WIDTH / 2; const endX = toCenter.x - direction * BLOCK_WIDTH / 2;
    const bend = Math.max(36, Math.abs(endX - startX) / 2);
    return `M ${startX} ${fromCenter.y} C ${startX + direction * bend} ${fromCenter.y + lane * 2}, ${endX - direction * bend} ${toCenter.y + lane * 2}, ${endX} ${toCenter.y}`;
  }
  const direction = toCenter.y >= fromCenter.y ? 1 : -1;
  const startY = fromCenter.y + direction * BLOCK_HEIGHT / 2; const endY = toCenter.y - direction * BLOCK_HEIGHT / 2;
  const bend = Math.max(36, Math.abs(endY - startY) / 2);
  return `M ${fromCenter.x} ${startY} C ${fromCenter.x} ${startY + direction * bend}, ${toCenter.x} ${endY - direction * bend}, ${toCenter.x} ${endY}`;
}

const flowBlockTypes: HarnessBlock["type"][] = ["ai", "text", "timer", "user_prompt", "yes_no_prompt", "script", "start_button", "start_input"];
const blockTypeLabels: Partial<Record<HarnessBlock["type"], string>> = { ai: "AI Agent", text: "Text input", timer: "Timer", user_prompt: "User Prompt", yes_no_prompt: "Yes/No Prompt", script: "Script execution", start_button: "Start button", start_input: "Start with text" };
