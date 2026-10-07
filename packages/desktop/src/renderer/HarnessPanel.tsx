import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
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
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [connectFrom, setConnectFrom] = useState<string>();
  const [connectionType, setConnectionType] = useState<"use" | "follow" | "path">("follow");
  const [startInputs, setStartInputs] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [createTemplate, setCreateTemplate] = useState<"" | "five-minute-check-in" | "git-review-commit">("");
  const [createName, setCreateName] = useState<string>();
  const [mode, setMode] = useState<"view" | "edit">("edit");
  const [editorSurface, setEditorSurface] = useState<"canvas" | "list">("canvas");
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [listConnectionTarget, setListConnectionTarget] = useState("");
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, AiModel[]>>({});
  const [remoteValidationIssues, setRemoteValidationIssues] = useState<HarnessValidationIssue[]>([]);
  const [saveConflict, setSaveConflict] = useState<{ local: HarnessDefinition; remote: HarnessDefinition; comparing: boolean }>();
  const [validationAnnouncement, setValidationAnnouncement] = useState("");
  const [runAnnouncement, setRunAnnouncement] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const pendingScroll = useRef<{ left: number; top: number }>();
  const [canvasViewport, setCanvasViewport] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const updateCanvasViewport = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) setCanvasViewport({ left: canvas.scrollLeft, top: canvas.scrollTop, width: canvas.clientWidth, height: canvas.clientHeight });
  }, []);
  const changeZoom = useCallback((requested: number, clientX?: number, clientY?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const next = Math.max(0.25, Math.min(2, requested));
    if (next === zoomRef.current) return;
    const bounds = canvas.getBoundingClientRect();
    const x = clientX === undefined ? canvas.clientWidth / 2 : clientX - bounds.left - canvas.clientLeft;
    const y = clientY === undefined ? canvas.clientHeight / 2 : clientY - bounds.top - canvas.clientTop;
    const ratio = next / zoomRef.current;
    pendingScroll.current = { left: ((pendingScroll.current?.left ?? canvas.scrollLeft) + x) * ratio - x, top: ((pendingScroll.current?.top ?? canvas.scrollTop) + y) * ratio - y };
    zoomRef.current = next;
    setZoom(next);
  }, []);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && pendingScroll.current) {
      canvas.scrollLeft = pendingScroll.current.left;
      canvas.scrollTop = pendingScroll.current.top;
      pendingScroll.current = undefined;
    }
    updateCanvasViewport();
  }, [draft?.id, updateCanvasViewport, zoom]);
  const drag = useRef<{ id: string; ids: string[]; positions: Map<string, HarnessBlock["position"]>; grabX: number; grabY: number }>();
  const ignoreNextBlockClick = useRef(false);
  const selected = harnesses.find((item) => item.id === selectedId);
  useEffect(() => { if (!selectedId && harnesses[0]) setSelectedId(harnesses[0].id); }, [harnesses, selectedId]);
  useEffect(() => { const next = selected ? structuredClone(selected) : undefined; setDraft(next); setBaseline(next); setSelectedBlockId(undefined); setSelectedBlockIds([]); setSelectedEdgeId(undefined); setListConnectionTarget(""); setSaveConflict(undefined); }, [selected?.id, selected?.version]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.shiftKey) return;
      // Shift can remap vertical wheel motion to deltaX on Windows.
      const delta = event.deltaY || (event.shiftKey ? event.deltaX : 0);
      event.preventDefault();
      if (!delta) return;
      const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      changeZoom(zoomRef.current * Math.exp(-Math.max(-100, Math.min(100, pixels)) * 0.002), event.clientX, event.clientY);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [Boolean(draft), changeZoom]);
  useEffect(() => {
    window.addEventListener("resize", updateCanvasViewport);
    return () => window.removeEventListener("resize", updateCanvasViewport);
  }, [updateCanvasViewport]);
  const canvasWidth = Math.max(1200, ...draft?.blocks.map((block) => block.position.x + BLOCK_WIDTH + 80) ?? []);
  const canvasHeight = Math.max(800, ...draft?.blocks.map((block) => block.position.y + BLOCK_HEIGHT + 80) ?? []);
  const fitCanvasToBlocks = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !draft?.blocks.length) return;
    const next = fitCanvasViewport(draft.blocks, canvas.clientWidth, canvas.clientHeight);
    const zoomChanged = next.zoom !== zoomRef.current;
    pendingScroll.current = zoomChanged ? { left: next.scrollLeft, top: next.scrollTop } : undefined;
    zoomRef.current = next.zoom;
    setZoom(next.zoom);
    // Changing only the scroll position does not cause a render, so apply it now too.
    canvas.scrollLeft = next.scrollLeft;
    canvas.scrollTop = next.scrollTop;
  }, [draft?.blocks]);
  const autoLayout = () => {
    if (!draft || mode !== "edit") return;
    setDraft({ ...draft, blocks: autoLayoutBlocks(draft.blocks, draft.edges) });
    setSelectedEdgeId(undefined);
  };
  const alignSelectedBlocks = (alignment: WorkflowBlockAlignment) => {
    if (!draft || selectedBlockIds.length < 2) return;
    setDraft({ ...draft, blocks: alignBlocks(draft.blocks, selectedBlockIds, alignment) });
  };
  const block = draft?.blocks.find((item) => item.id === selectedBlockId);
  const blockProvider = block && ["ai", "prompt", "task", "review"].includes(block.type) ? block.provider ?? defaultProvider : undefined;
  const blockModels = blockProvider ? modelsByProvider[blockProvider] ?? [] : [];
  const selectedBlockModel = blockModels.find((model) => model.id === block?.model);
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
  const validationAnnouncementKey = validationIssues.map((issue) => `${issue.code}:${issue.blockId ?? issue.edgeId ?? "workflow"}`).join("|");
  useEffect(() => {
    if (!draft) return;
    setValidationAnnouncement(validationIssues.length ? `${validationIssues.length} workflow validation issue${validationIssues.length === 1 ? "" : "s"}. ${validationIssues[0]?.message ?? ""}` : "Workflow validation has no issues.");
  }, [draft?.id, validationAnnouncementKey]);
  useEffect(() => {
    if (run) setRunAnnouncement(`Workflow run ${run.id} is ${run.status.replaceAll("_", " ")}.`);
  }, [run?.id, run?.status]);
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
    setDraft({ ...draft, blocks: [...draft.blocks, next] }); setSelectedBlockId(id); setSelectedBlockIds([id]);
  };
  const removeBlock = (id: string) => {
    if (!draft || mode !== "edit") return;
    setDraft({ ...draft, blocks: draft.blocks.filter((item) => item.id !== id), edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id) });
    setSelectedBlockId((current) => current === id ? undefined : current); setSelectedBlockIds((current) => current.filter((selected) => selected !== id)); setConnectFrom((current) => current === id ? undefined : current);
  };
  const removeEdge = (id: string) => { if (!draft || mode !== "edit") return; setDraft({ ...draft, edges: draft.edges.filter((edge) => edge.id !== id) }); setSelectedEdgeId(undefined); };
  const connectTo = (id: string) => {
    if (!draft || mode !== "edit") return;
    if (!connectFrom || connectFrom === id) return;
    if (draft.edges.some((edge) => edge.from === connectFrom && edge.to === id && (edge.type ?? "follow") === connectionType)) onError("These blocks are already connected");
    else { setDraft({ ...draft, edges: [...draft.edges, { id: crypto.randomUUID(), from: connectFrom, to: id, type: connectionType, label: draft.blocks.find((item) => item.id === id)?.label ?? "Next" }] }); }

    setConnectFrom(undefined);
  };
  const beginConnection = (id: string) => {
    setConnectionType("follow");
    setConnectFrom((current) => current === id ? undefined : id);
  };
  const keyboardActivate = (event: ReactKeyboardEvent<HTMLButtonElement>, action: () => void) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); event.stopPropagation(); action();
  };
  const selectBlock = (id: string, extend = false) => {
    const next = extend ? (selectedBlockIds.includes(id) ? selectedBlockIds.filter((selected) => selected !== id) : [...selectedBlockIds, id]) : [id];
    setSelectedBlockIds(next);
    setSelectedBlockId(next.includes(id) ? id : next.at(-1));
    setSelectedEdgeId(undefined);
    return next;
  };
  const pointerDown = (event: ReactPointerEvent, item: HarnessBlock) => {
    if (mode !== "edit" || event.button !== 0) return;
    const target = event.currentTarget as HTMLElement; target.setPointerCapture(event.pointerId);
    const bounds = target.getBoundingClientRect();
    const ids = selectBlock(item.id, event.ctrlKey || event.metaKey);
    ignoreNextBlockClick.current = true;
    drag.current = { id: item.id, ids, positions: new Map(draft?.blocks.filter((block) => ids.includes(block.id)).map((block) => [block.id, block.position])), grabX: (event.clientX - bounds.left) / zoom, grabY: (event.clientY - bounds.top) / zoom };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft || mode !== "edit" || !drag.current) return;
    const bounds = event.currentTarget.getBoundingClientRect(); const item = drag.current;
    const position = dragPosition(event.clientX, event.clientY, bounds.left + event.currentTarget.clientLeft, bounds.top + event.currentTarget.clientTop, event.currentTarget.scrollLeft, event.currentTarget.scrollTop, item.grabX, item.grabY, zoom);
    const origin = item.positions.get(item.id)!;
    const delta = { x: position.x - origin.x, y: position.y - origin.y };
    setDraft({ ...draft, blocks: draft.blocks.map((block) => { const start = item.positions.get(block.id); return start ? { ...block, position: { x: Math.max(8, start.x + delta.x), y: Math.max(8, start.y + delta.y) } } : block; }) });
  };
  const moveViewportFromMinimap = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.detail === 0 ? bounds.width / 2 : event.clientX - bounds.left;
    const y = event.detail === 0 ? bounds.height / 2 : event.clientY - bounds.top;
    const next = minimapScrollPosition(x, y, bounds.width, bounds.height, canvasWidth, canvasHeight, zoom, canvas.clientWidth, canvas.clientHeight);
    canvas.scrollLeft = next.left;
    canvas.scrollTop = next.top;
    updateCanvasViewport();
  };
  const minimap = minimapViewport(canvasWidth, canvasHeight, zoom, canvasViewport);
  const showMinimap = (draft?.blocks.length ?? 0) > 1 && canvasViewport.width > 0 && (canvasWidth * zoom > canvasViewport.width || canvasHeight * zoom > canvasViewport.height);

  return <div className={`harness-panel ${mode}`}>
    <div className="visually-hidden" role="status" aria-label="Workflow validation status" aria-live="polite" aria-atomic="true">{validationAnnouncement}</div>
    <div className="visually-hidden" role="status" aria-label="Workflow run status" aria-live="polite" aria-atomic="true">{runAnnouncement}</div>
    {diagnostics.length > 0 && <div className="harness-connect-hint" role="alert"><strong>Workflow state recovered from backup</strong><ul>{diagnostics.map((diagnostic, index) => <li key={`${diagnostic.source}:${diagnostic.detectedAt}:${index}`}>{diagnostic.source}: {diagnostic.reason}</li>)}</ul></div>}
    {createName !== undefined ? <form className="harness-create" onSubmit={(event) => { event.preventDefault(); void create(); }}><input autoFocus aria-label="Workflow name" value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="New Workflow" /><select aria-label="Workflow template" value={createTemplate} onChange={(event) => { const template = event.target.value as typeof createTemplate; setCreateTemplate(template); if (template && createName === "New Workflow") setCreateName(template === "git-review-commit" ? "Review, commit & ask to push" : "Five-minute workspace check-in"); }}><option value="">Blank workflow</option><option value="five-minute-check-in">Five-minute workspace check-in · all blocks</option><option value="git-review-commit">Review, commit & ask to push · Git command blocks</option></select><button type="submit" disabled={!createName.trim()}>Create</button><button type="button" title="Cancel workflow creation" onClick={() => setCreateName(undefined)}><X size={14} /></button></form> : <div className="harness-picker"><select aria-label="Selected workflow" value={selectedId ?? ""} onChange={(event) => { const nextId = event.target.value || undefined; if (nextId !== selectedId && discardDraft()) setSelectedId(nextId); }}><option value="">Select a workflow</option>{harnesses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{mode === "edit" && <><button title="Create workflow" onClick={() => { if (discardDraft()) setCreateName("New Workflow"); }}><Plus size={14} /></button><button title="Delete workflow" disabled={!draft} onClick={() => void remove()}><Trash2 size={14} /></button></>}<div className="harness-mode" role="group" aria-label="Workflow mode"><button className={mode === "view" ? "active" : ""} onClick={() => { if (mode !== "view" && !discardDraft()) return; setMode("view"); setConnectFrom(undefined); }}>View</button><button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>Edit</button></div>{mode === "edit" && <div className="harness-mode" role="group" aria-label="Workflow editor surface"><button className={editorSurface === "canvas" ? "active" : ""} onClick={() => setEditorSurface("canvas")}>Canvas</button><button className={editorSurface === "list" ? "active" : ""} onClick={() => setEditorSurface("list")}>List</button></div>}</div>}
    {!draft ? <div className="harness-empty"><strong>Build an AI workflow</strong><span>Add a start block, connect followers, and give AI Agents tools and paths.</span><button onClick={() => setCreateName("New Workflow")}><Plus size={14} /> Create workflow</button></div> : <>
      {mode === "edit" ? <><div className="harness-toolbar"><input aria-label="Workflow name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><select aria-label="Add block type" value="" onChange={(event) => { if (event.target.value) addBlock(event.target.value as HarnessBlock["type"]); }}><option value="">+ Add block</option>{flowBlockTypes.map((type) => <option key={type} value={type}>{blockTypeLabels[type]}</option>)}</select><button title="Save workflow" disabled={!dirty || saving || validationIssues.length > 0} onClick={() => void save()}><Save size={14} /> {saving ? "Saving" : "Save"}</button></div><details className="harness-settings"><summary>Execution settings</summary><label>Concurrent blocks<input aria-label="Workflow concurrency" type="number" min="1" max="32" value={draft.settings?.concurrency ?? 4} onChange={(event) => { const concurrency = Number(event.target.value); setDraft({ ...draft, settings: { ...draft.settings, concurrency } }); }} /></label><label>Retry attempts<input aria-label="Workflow retry attempts" type="number" min="1" max="10" value={draft.settings?.retry?.maxAttempts ?? 3} onChange={(event) => { const maxAttempts = Number(event.target.value); setDraft({ ...draft, settings: { ...draft.settings, retry: { ...draft.settings?.retry, maxAttempts } } }); }} /></label><label>Output limit<input aria-label="Workflow output limit" type="number" min="1000" max="200000" step="1000" value={draft.settings?.outputLimitChars ?? 200000} onChange={(event) => { const outputLimitChars = Number(event.target.value); setDraft({ ...draft, settings: { ...draft.settings, outputLimitChars } }); }} /></label><label>Log entries<input aria-label="Workflow log limit" type="number" min="10" max="500" value={draft.settings?.logLimitEntries ?? 500} onChange={(event) => { const logLimitEntries = Number(event.target.value); setDraft({ ...draft, settings: { ...draft.settings, logLimitEntries } }); }} /></label><small>Defaults: 4 concurrent blocks, 3 retry attempts, 200,000 output characters, and 500 log entries.</small></details></> : <div className="harness-view-summary"><strong>{draft.name}</strong>{workflowRuns.length ? <select aria-label="Selected workflow run" value={run?.id ?? ""} onChange={(event) => setSelectedRunId(event.target.value)}>{workflowRuns.map((item) => <option key={item.id} value={item.id}>{activeRunStatuses.has(item.status) ? "● " : ""}{item.status} · {new Date(item.createdAt).toLocaleString()} · {item.input.slice(0, 50)}</option>)}</select> : <span>No runs yet</span>}{activeRuns.length > 1 && <small>{activeRuns.length} active runs</small>}</div>}
      {validationIssues.length > 0 && <div className="harness-connect-hint" role="alert"><strong>{validationIssues.length} workflow issue{validationIssues.length === 1 ? "" : "s"}</strong><ul>{validationIssues.map((issue, index) => <li key={`${issue.code}:${issue.blockId ?? issue.edgeId ?? index}`}><button onClick={() => { if (issue.blockId) { setSelectedBlockId(issue.blockId); setSelectedEdgeId(undefined); } else if (issue.edgeId) { setSelectedEdgeId(issue.edgeId); setSelectedBlockId(undefined); } }}>{issue.message}</button></li>)}</ul></div>}
      {saveConflict && <div className="harness-conflict" role="alert"><strong>This workflow was changed elsewhere.</strong><span>The saved version is {saveConflict.remote.version}; your draft is version {saveConflict.local.version}.</span><div><button onClick={() => { const next = structuredClone(saveConflict.remote); setDraft(next); setBaseline(next); setSaveConflict(undefined); }}>Reload</button><button onClick={() => setSaveConflict((current) => current ? { ...current, comparing: !current.comparing } : current)}>{saveConflict.comparing ? "Hide comparison" : "Compare"}</button><button onClick={() => void saveAsCopy()} disabled={saving}>Save as copy</button></div>{saveConflict.comparing && <div className="harness-conflict-comparison"><section><strong>Your draft</strong><pre>{JSON.stringify(saveConflict.local, null, 2)}</pre></section><section><strong>Saved workflow</strong><pre>{JSON.stringify(saveConflict.remote, null, 2)}</pre></section></div>}</div>}
      {mode === "edit" && editorSurface === "canvas" && connectFrom && <div className="harness-connect-hint">Select an input port to connect from <strong>{blockById.get(connectFrom)?.label}</strong>. <select aria-label="New connection type" value={connectionType} onChange={(event) => setConnectionType(event.target.value as typeof connectionType)}><option value="follow">Follow · pass output when done</option>{blockById.get(connectFrom)?.type === "ai" && <><option value="use">Use · expose as an MCP tool</option><option value="path">Path · AI chooses</option></>}</select> <button onClick={() => setConnectFrom(undefined)}>Cancel</button></div>}
      {mode === "edit" && selectedEdge && <div className="harness-connect-hint harness-edge-controls">Selected connection: <strong>{blockById.get(selectedEdge.from)?.label} → {blockById.get(selectedEdge.to)?.label}</strong><label>Type<select aria-label="Connection type" value={selectedEdge.type ?? "follow"} onChange={(event) => setDraft({ ...draft, edges: draft.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, type: event.target.value as "use" | "follow" | "path", loop: undefined, execution: undefined } : edge) })}><option value="follow">Follow</option>{blockById.get(selectedEdge.from)?.type === "ai" && <><option value="use">Use</option><option value="path">Path</option></>}</select></label>{selectedEdge.type === "path" && <label>Path name<input aria-label="Path name" value={selectedEdge.label ?? ""} onChange={(event) => setDraft({ ...draft, edges: draft.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, label: event.target.value } : edge) })} /></label>}<button onClick={() => removeEdge(selectedEdge.id)}>Remove connection</button></div>}
      {(mode === "view" || editorSurface === "canvas") && <><div className="harness-zoom" role="group" aria-label="Workflow zoom">
        <button aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => changeZoom(zoomRef.current / 1.2)}>−</button>
        <button aria-label="Reset workflow zoom" title="Reset zoom to 100%" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button aria-label="Zoom in" disabled={zoom >= 2} onClick={() => changeZoom(zoomRef.current * 1.2)}>+</button>
        <button aria-label="Fit workflow to canvas" title="Fit all blocks in the canvas" disabled={!draft.blocks.length} onClick={fitCanvasToBlocks}>Fit</button>
        {mode === "edit" && <button aria-label="Automatically lay out workflow" title="Arrange blocks by workflow connections" disabled={draft.blocks.length < 2} onClick={autoLayout}>Layout</button>}
        {mode === "edit" && selectedBlockIds.length > 1 && <span className="harness-alignment" role="group" aria-label="Align selected workflow blocks"><button aria-label="Align selected blocks left" title="Align left" onClick={() => alignSelectedBlocks("left")}>Left</button><button aria-label="Align selected blocks center" title="Align horizontal centers" onClick={() => alignSelectedBlocks("center")}>Center</button><button aria-label="Align selected blocks right" title="Align right" onClick={() => alignSelectedBlocks("right")}>Right</button><button aria-label="Align selected blocks top" title="Align top" onClick={() => alignSelectedBlocks("top")}>Top</button><button aria-label="Align selected blocks middle" title="Align vertical centers" onClick={() => alignSelectedBlocks("middle")}>Middle</button><button aria-label="Align selected blocks bottom" title="Align bottom" onClick={() => alignSelectedBlocks("bottom")}>Bottom</button></span>}
        {mode === "edit" && selectedBlockIds.length > 0 && <button aria-label="Clear selected workflow blocks" title="Clear block selection" onClick={() => { setSelectedBlockIds([]); setSelectedBlockId(undefined); }}>Clear selection</button>}
        <small>Pinch or Shift+scroll to zoom</small>
      </div>
      <div ref={canvasRef} aria-label="Workflow canvas" className={`harness-canvas ${mode}`} onScroll={updateCanvasViewport} onClick={(event) => { if (event.target === event.currentTarget) { setSelectedEdgeId(undefined); setSelectedBlockId(undefined); setSelectedBlockIds([]); } }} onPointerMove={pointerMove} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
        {showMinimap && <button className="harness-minimap" aria-label="Workflow minimap" title="Click to move the workflow viewport" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); moveViewportFromMinimap(event); }}>
          {draft.blocks.map((block) => <span key={block.id} className="harness-minimap-block" style={{ left: `${block.position.x / canvasWidth * 100}%`, top: `${block.position.y / canvasHeight * 100}%`, width: `${BLOCK_WIDTH / canvasWidth * 100}%`, height: `${BLOCK_HEIGHT / canvasHeight * 100}%` }} />)}
          <span className="harness-minimap-viewport" style={{ left: `${minimap.left}%`, top: `${minimap.top}%`, width: `${minimap.width}%`, height: `${minimap.height}%` }} />
        </button>}
        <div className="harness-canvas-extent" style={{ width: canvasWidth * zoom, height: canvasHeight * zoom }}>
        <div className="harness-canvas-content" style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${zoom})` }}>
        <svg aria-label="Workflow connections" style={{ width: canvasWidth, height: canvasHeight }}><defs><marker id={arrowMarkerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" /></marker></defs>{draft.edges.map((edge) => { const from = blockById.get(edge.from); const to = blockById.get(edge.to); if (!from || !to) return null; const lane = draft.edges.filter((item) => item.from === edge.from && item.to === edge.to).findIndex((item) => item.id === edge.id) * 16; const labelX = (from.position.x + to.position.x) / 2 + BLOCK_WIDTH / 2; const labelY = (from.position.y + to.position.y) / 2 + BLOCK_HEIGHT / 2 - 7 + lane + (edge.loop ? 45 : 0); const title = edge.loop ? `${from.label} loops to ${to.label}` : `${from.label} then ${to.label}`; const traces = animatedTraces.filter((trace) => trace.edgeId === edge.id); const path = edgePath(from, to, edge.loop, lane); return <g key={edge.id}><path className={`harness-edge ${edge.type ?? "follow"}${edge.loop ? " loop" : ""}${selectedEdgeId === edge.id ? " selected" : ""}`} d={path} markerEnd={`url(#${arrowMarkerId})`} role={mode === "edit" ? "button" : undefined} aria-label={mode === "edit" ? `Select connection: ${title}` : undefined} tabIndex={mode === "edit" ? 0 : undefined} onClick={mode === "edit" ? (event) => { event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedBlockId(undefined); setSelectedBlockIds([]); } : undefined}><title>{title}</title></path>{traces.map((trace) => <path key={trace.id} className={`harness-transfer ${edge.type ?? "follow"} ${trace.direction} ${trace.status}`} d={path} pathLength={100} style={{ animationDelay: `${trace.delayMs}ms` }} aria-label={`${trace.direction === "return" ? "Output" : "Input"}: ${trace.direction === "return" ? to.label : from.label} → ${trace.direction === "return" ? from.label : to.label}`} />)}{edge.label && <text className="harness-edge-label" x={labelX} y={labelY} textAnchor="middle">{`${edge.type ?? "follow"}${edge.type === "path" ? `: ${edge.label}` : ""}`}</text>}</g>; })}</svg>
        {draft.blocks.map((item) => { const state = run?.blocks.find((block) => block.blockId === item.id); const preview = responsePreview(state?.output, state?.status); const inputActive = animatedTraces.some((trace) => { const edge = draft.edges.find((edge) => edge.id === trace.edgeId); return trace.direction === "return" ? edge?.from === item.id : edge?.to === item.id; }); const outputActive = animatedTraces.some((trace) => { const edge = draft.edges.find((edge) => edge.id === trace.edgeId); return trace.direction === "return" ? edge?.to === item.id : edge?.from === item.id; }); return <div key={item.id} className={`harness-block ${state?.status === "running" ? "working" : ""} ${selectedBlockIds.includes(item.id) ? "selected" : ""} ${connectFrom === item.id ? "connecting" : ""}`} style={{ left: item.position.x, top: item.position.y }} onPointerDown={(event) => pointerDown(event, item)} onClick={(event) => { if (mode === "view") { setSelectedBlockId(item.id); setSelectedBlockIds([item.id]); return; } if (ignoreNextBlockClick.current) { ignoreNextBlockClick.current = false; return; } selectBlock(item.id, event.ctrlKey || event.metaKey); }}><button className={`harness-port input${inputActive ? " flowing" : ""}`} tabIndex={mode === "view" ? -1 : 0} aria-label={`Connect into ${item.label}`} aria-keyshortcuts="Enter Space" title="Input: connect selected block here" disabled={!connectFrom || connectFrom === item.id} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => keyboardActivate(event, () => connectTo(item.id))} onClick={(event) => { event.stopPropagation(); connectTo(item.id); }} /><button className={`harness-port output${outputActive ? " flowing" : ""}`} disabled={mode === "view"} tabIndex={mode === "view" ? -1 : 0} aria-label={`Connect from ${item.label}`} aria-keyshortcuts="Enter Space" title={connectFrom === item.id ? "Cancel connection" : "Output: start connection"} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => keyboardActivate(event, () => beginConnection(item.id))} onClick={(event) => { event.stopPropagation(); beginConnection(item.id); }} /><header><span className={`harness-status ${state?.status ?? "idle"}`} />{item.label}</header><small>{state?.status === "running" && state.iterations?.length ? `Stack item ${state.iterations.length} of ${state.plannedRuns ?? state.iterations.length}` : state?.status === "running" ? "Running…" : state?.error ?? (item.type === "ai" || ["prompt", "task", "review"].includes(item.type) ? item.model ?? item.provider ?? "Default model" : blockTypeLabels[item.type] ?? item.type)}</small>{mode === "view" && (item.type === "start_button" || item.type === "start_input") ? <div className="harness-start" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>{item.type === "start_input" && <input aria-label={`Input for ${item.label}`} placeholder="Type text…" value={startInputs[item.id] ?? ""} onChange={(event) => setStartInputs((current) => ({ ...current, [item.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") void start(item); }} />}<button disabled={dirty || validationIssues.length > 0 || !(item.type === "start_button" ? item.prompt : startInputs[item.id])?.trim()} onClick={() => void start(item)}><Play size={12} /> Start</button></div> : <div className={`harness-response-preview ${state?.output ? "available" : ""}`} title={state?.output} aria-label={`${item.label} response preview`}>{preview}</div>}<footer><button title="Delete block" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeBlock(item.id); }}><Trash2 size={12} /></button></footer></div>; })}
        {!draft.blocks.length && <button className="harness-canvas-empty" onClick={() => addBlock()}><Plus size={16} /> Add the first AI Agent</button>}
        </div></div>
      </div></>}
      {mode === "edit" && editorSurface === "list" && <section className="harness-list-editor" aria-label="Workflow list editor">
        <ol>{draft.blocks.map((item, index) => <li key={item.id} className={selectedBlockIds.includes(item.id) ? "selected" : ""}><button aria-label={`Edit block ${item.label}`} aria-pressed={selectedBlockIds.includes(item.id)} onClick={() => { setSelectedBlockId(item.id); setSelectedBlockIds([item.id]); setSelectedEdgeId(undefined); }}><strong>{index + 1}. {item.label}</strong><small>{blockTypeLabels[item.type] ?? item.type}</small></button><button aria-label={`Remove block ${item.label}`} onClick={() => removeBlock(item.id)}>Remove</button></li>)}</ol>
        {draft.blocks.length > 1 && <section className="harness-list-connections" aria-label="Workflow list connections"><strong>Connections</strong><div><label>From<select aria-label="List connection source" value={connectFrom ?? ""} onChange={(event) => { setConnectFrom(event.target.value || undefined); setConnectionType("follow"); }}><option value="">Choose a block</option>{draft.blocks.map((block) => <option key={block.id} value={block.id}>{block.label}</option>)}</select></label><label>To<select aria-label="List connection target" value={listConnectionTarget} onChange={(event) => setListConnectionTarget(event.target.value)}><option value="">Choose a block</option>{draft.blocks.filter((block) => block.id !== connectFrom).map((block) => <option key={block.id} value={block.id}>{block.label}</option>)}</select></label><label>Type<select aria-label="List connection type" value={connectionType} onChange={(event) => setConnectionType(event.target.value as typeof connectionType)}><option value="follow">Follow</option>{blockById.get(connectFrom ?? "")?.type === "ai" && <><option value="use">Use</option><option value="path">Path</option></>}</select></label><button disabled={!connectFrom || !listConnectionTarget} onClick={() => { connectTo(listConnectionTarget); setListConnectionTarget(""); }}>Add connection</button></div>{draft.edges.length ? <ul>{draft.edges.map((edge) => <li key={edge.id}><button aria-label={`Edit connection ${blockById.get(edge.from)?.label ?? edge.from} then ${blockById.get(edge.to)?.label ?? edge.to}`} onClick={() => { setSelectedEdgeId(edge.id); setSelectedBlockId(undefined); setSelectedBlockIds([]); }}>{blockById.get(edge.from)?.label ?? edge.from} → {blockById.get(edge.to)?.label ?? edge.to} · {edge.type ?? "follow"}</button><button aria-label={`Remove connection ${edge.id}`} onClick={() => removeEdge(edge.id)}>Remove</button></li>)}</ul> : <small>No connections yet.</small>}</section>}
      </section>}
      {block && mode === "view" && <BlockRunDetails block={block} state={blockRun} tasks={run?.children?.filter((child) => child.blockId === block.id)} onClose={() => setSelectedBlockId(undefined)} />}
      {block && mode === "edit" && <div className="harness-inspector"><header><strong>Block settings</strong><button title="Close block settings" onClick={() => setSelectedBlockId(undefined)}>×</button></header>
        <label>Name<input value={block.label} onChange={(event) => updateBlock({ label: event.target.value })} /></label>
        <label>Type<select aria-label="Block type" value={block.type} onChange={(event) => updateBlock({ type: event.target.value as HarnessBlock["type"], seconds: 60, watchdog: undefined, join: undefined, routing: undefined, review: undefined, verification: undefined })}>{!flowBlockTypes.includes(block.type) && <option value={block.type}>Legacy {block.type}</option>}{flowBlockTypes.map((type) => <option key={type} value={type}>{blockTypeLabels[type]}</option>)}</select></label>
        {["ai", "prompt", "task", "review"].includes(block.type) && <><div className="harness-fields"><label>Provider<select value={block.provider ?? ""} onChange={(event) => updateBlock({ provider: event.target.value || undefined, model: undefined, reasoning: undefined })}><option value="">Default</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><ModelPicker models={blockModels} value={block.model ?? ""} label="AI model" onChange={(model) => { const selected = blockModels.find((item) => item.id === model); updateBlock({ model, reasoning: selected?.defaultReasoning || undefined }); }} /></div>{selectedBlockModel?.reasoningLevels.length ? <label>Reasoning effort<select aria-label="Workflow reasoning effort" value={block.reasoning ?? selectedBlockModel.defaultReasoning} onChange={(event) => updateBlock({ reasoning: event.target.value })}>{selectedBlockModel.reasoningLevels.map((level) => <option key={level} value={level} title={selectedBlockModel.reasoningDescriptions?.[level]}>{level}</option>)}</select></label> : null}<label>Agent preset<select value={block.agent ? `${block.agent.scope}:${block.agent.name}` : ""} onChange={(event) => { const agent = agents.find((item) => `${item.scope}:${item.name}` === event.target.value); updateBlock({ agent: agent ? { scope: agent.scope, name: agent.name } : undefined }); }}><option value="">None</option>{agents.map((item) => <option key={`${item.scope}:${item.name}`} value={`${item.scope}:${item.name}`}>{item.agent.name}</option>)}</select></label><small>One context per AI Agent in each run. Use connected blocks through MCP; choose a path before finishing.</small></>}
        {block.type === "timer" && <><label>Delay in seconds<input aria-label="Timer seconds" type="number" min="0" max="86400" value={block.seconds ?? 60} onChange={(event) => updateBlock({ seconds: Number(event.target.value) })} /></label><small>Using this block arms its countdown and returns immediately. When it fires, its follow connections receive the input used to arm it.</small></>}
        {block.type === "script" && <><label>Shell script<textarea aria-label="Shell script" rows={6} value={block.command ?? ""} onChange={(event) => updateBlock({ command: event.target.value })} /></label><small>Runs in the Core workspace. Input arrives on stdin and in VIBE_WORKFLOW_INPUT. Stdout becomes this block’s output.</small></>}
        {!["timer", "script", "start_input"].includes(block.type) && <label>{block.type === "markdown" ? "Markdown (blank uses input)" : block.type === "text" ? "Text" : ["user_prompt", "yes_no_prompt"].includes(block.type) ? "Question" : block.type === "start_button" ? "Start prompt" : "Instructions"}<textarea aria-label="Block prompt" rows={5} value={block.prompt} onChange={(event) => updateBlock({ prompt: event.target.value })} /></label>}
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

export function dragPosition(clientX: number, clientY: number, canvasLeft: number, canvasTop: number, scrollLeft: number, scrollTop: number, grabX: number, grabY: number, zoom = 1): HarnessBlock["position"] {
  return { x: Math.max(8, (clientX - canvasLeft + scrollLeft) / zoom - grabX), y: Math.max(8, (clientY - canvasTop + scrollTop) / zoom - grabY) };
}

export function fitCanvasViewport(blocks: HarnessBlock[], viewportWidth: number, viewportHeight: number, padding = 48): { zoom: number; scrollLeft: number; scrollTop: number } {
  const left = Math.min(...blocks.map((block) => block.position.x));
  const top = Math.min(...blocks.map((block) => block.position.y));
  const right = Math.max(...blocks.map((block) => block.position.x + BLOCK_WIDTH));
  const bottom = Math.max(...blocks.map((block) => block.position.y + BLOCK_HEIGHT));
  const width = right - left;
  const height = bottom - top;
  const zoom = Math.max(0.25, Math.min(2, viewportWidth / (width + padding * 2), viewportHeight / (height + padding * 2)));
  return {
    zoom,
    scrollLeft: Math.max(0, (left + width / 2) * zoom - viewportWidth / 2),
    scrollTop: Math.max(0, (top + height / 2) * zoom - viewportHeight / 2),
  };
}

export function minimapViewport(canvasWidth: number, canvasHeight: number, zoom: number, viewport: { left: number; top: number; width: number; height: number }): { left: number; top: number; width: number; height: number } {
  const width = canvasWidth * zoom;
  const height = canvasHeight * zoom;
  return {
    left: Math.max(0, Math.min(100, viewport.left / width * 100)),
    top: Math.max(0, Math.min(100, viewport.top / height * 100)),
    width: Math.max(0, Math.min(100, viewport.width / width * 100)),
    height: Math.max(0, Math.min(100, viewport.height / height * 100)),
  };
}

export function minimapScrollPosition(x: number, y: number, minimapWidth: number, minimapHeight: number, canvasWidth: number, canvasHeight: number, zoom: number, viewportWidth: number, viewportHeight: number): { left: number; top: number } {
  const contentWidth = canvasWidth * zoom;
  const contentHeight = canvasHeight * zoom;
  return {
    left: Math.max(0, Math.min(contentWidth - viewportWidth, x / minimapWidth * contentWidth - viewportWidth / 2)),
    top: Math.max(0, Math.min(contentHeight - viewportHeight, y / minimapHeight * contentHeight - viewportHeight / 2)),
  };
}

export type WorkflowBlockAlignment = "left" | "center" | "right" | "top" | "middle" | "bottom";

export function alignBlocks(blocks: HarnessBlock[], selectedIds: string[], alignment: WorkflowBlockAlignment): HarnessBlock[] {
  const selected = blocks.filter((block) => selectedIds.includes(block.id));
  if (selected.length < 2) return blocks;
  const left = Math.min(...selected.map((block) => block.position.x));
  const right = Math.max(...selected.map((block) => block.position.x + BLOCK_WIDTH));
  const top = Math.min(...selected.map((block) => block.position.y));
  const bottom = Math.max(...selected.map((block) => block.position.y + BLOCK_HEIGHT));
  return blocks.map((block) => {
    if (!selectedIds.includes(block.id)) return block;
    const position = { ...block.position };
    if (alignment === "left") position.x = left;
    if (alignment === "center") position.x = (left + right - BLOCK_WIDTH) / 2;
    if (alignment === "right") position.x = right - BLOCK_WIDTH;
    if (alignment === "top") position.y = top;
    if (alignment === "middle") position.y = (top + bottom - BLOCK_HEIGHT) / 2;
    if (alignment === "bottom") position.y = bottom - BLOCK_HEIGHT;
    return { ...block, position };
  });
}

/** Arrange executable connections from left to right while retaining a stable order for cycles and disconnected blocks. */
export function autoLayoutBlocks(blocks: HarnessBlock[], edges: HarnessDefinition["edges"]): HarnessBlock[] {
  const order = new Map(blocks.map((block, index) => [block.id, index]));
  const blockIds = new Set(order.keys());
  // Tool and loop links do not establish a downstream execution rank.
  const layoutEdges = edges.filter((edge) => !edge.loop && edge.type !== "use" && blockIds.has(edge.from) && blockIds.has(edge.to) && edge.from !== edge.to);
  const incoming = new Map(blocks.map((block) => [block.id, 0]));
  const outgoing = new Map(blocks.map((block) => [block.id, [] as string[]]));
  for (const edge of layoutEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const rank = new Map(blocks.map((block) => [block.id, 0]));
  const ready = blocks.filter((block) => incoming.get(block.id) === 0).map((block) => block.id);
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor]!;
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1));
      const remaining = (incoming.get(target) ?? 1) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  const columns = new Map<number, HarnessBlock[]>();
  for (const block of blocks) {
    const column = rank.get(block.id) ?? 0;
    const items = columns.get(column) ?? [];
    items.push(block);
    columns.set(column, items);
  }
  return blocks.map((block) => {
    const column = rank.get(block.id) ?? 0;
    const row = columns.get(column)!.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)).findIndex((item) => item.id === block.id);
    return { ...block, position: { x: 32 + column * 260, y: 32 + row * 160 } };
  });
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

const flowBlockTypes: HarnessBlock["type"][] = ["ai", "text", "timer", "user_prompt", "yes_no_prompt", "markdown", "script", "start_button", "start_input"];
const blockTypeLabels: Partial<Record<HarnessBlock["type"], string>> = { ai: "AI Agent", text: "Text input", timer: "Timer", user_prompt: "User Prompt", yes_no_prompt: "Yes/No Prompt", markdown: "Markdown document", script: "Script execution", start_button: "Start button", start_input: "Start with text" };
