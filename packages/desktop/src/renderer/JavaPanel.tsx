import { RefreshCw, ChevronRight, ChevronDown, ArrowDownToLine, ArrowRight, ArrowUpFromLine, Bug, CornerDownRight, Hammer, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JavaApplyChangesResult, JavaDebugVariable, JavaDebugState, JavaProjectOptions, ProtocolOperations } from "@remote-ide/protocol";

type Props = {
  height: number;
  log: string;
  running: boolean;
  options: JavaProjectOptions;
  debugState: JavaDebugState;
  onBuild(): void;
  onRun(): void;
  onDebug(): void;
  onStop(): void;
  onDebugCommand(command: ProtocolOperations["java.debug.command"]["payload"]["command"]): void;
  onApplyChanges(): Promise<JavaApplyChangesResult>;
  onInspect(reference: string, start?: number): Promise<ProtocolOperations["java.debug.variables"]["result"]>;
  onClear(): void;
  onResizeStart(event: React.PointerEvent): void;
};

export function JavaPanel({ height, log, running, options, debugState, onBuild, onRun, onDebug, onStop, onDebugCommand, onApplyChanges, onInspect, onClear, onResizeStart }: Props) {
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<JavaApplyChangesResult>();
  const [applyError, setApplyError] = useState<string>();
  const busy = applying || !!debugState.applyingChanges;
  const applySequence = useRef(0);
  useEffect(() => {
    if (debugState.status === "starting" || debugState.status === "stopped") {
      applySequence.current++;
      setApplying(false); setApplyResult(undefined); setApplyError(undefined);
    }
  }, [debugState.status]);
  useEffect(() => () => { applySequence.current++; }, []);
  const applyChanges = async () => {
    if (busy) return;
    const sequence = ++applySequence.current;
    setApplying(true); setApplyResult(undefined); setApplyError(undefined);
    try {
      const result = await onApplyChanges();
      if (applySequence.current === sequence) setApplyResult(result);
    } catch (error) {
      if (applySequence.current === sequence) setApplyError(error instanceof Error ? error.message : String(error));
    } finally { if (applySequence.current === sequence) setApplying(false); }
  };
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);
  return <section className="java-panel" style={{ height }}>
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
    <aside className="java-actions">
      <button title="Build Maven project" disabled={running} onClick={onBuild}><Hammer size={16} /></button>
      <button title="Run selected configuration" disabled={running || !options.selectedRunConfigurationId} onClick={onRun}><Play size={16} /></button>
      <button title="Debug selected configuration" disabled={running || !options.selectedRunConfigurationId} onClick={onDebug}><Bug size={16} /></button>
      <button title="Stop Java process" disabled={!running} onClick={onStop}><Square size={15} /></button>
      <span />
      <button title="Clear build log" onClick={onClear}><Trash2 size={15} /></button>
    </aside>
    <div className="java-log-wrap">
      <header><span>Build Output</span><span className={running ? "running" : ""}>{running ? "Running" : "Idle"}</span></header>
      <pre ref={logRef}>{log || "Java build output will appear here."}</pre>
    </div>
    {debugState.status !== "stopped" && <aside className="debug-view">
      <header><span>Debugger</span><span>{debugState.status}</span></header>
      <div className="debug-controls">
        <button title="Continue" disabled={debugState.status !== "paused" || busy} onClick={() => onDebugCommand("continue")}><ArrowRight size={14} /></button>
        <button title="Step over" disabled={debugState.status !== "paused" || busy} onClick={() => onDebugCommand("stepOver")}><CornerDownRight size={14} /></button>
        <button title="Step into" disabled={debugState.status !== "paused" || busy} onClick={() => onDebugCommand("stepInto")}><ArrowDownToLine size={14} /></button>
        <button title="Step out" disabled={debugState.status !== "paused" || busy} onClick={() => onDebugCommand("stepOut")}><ArrowUpFromLine size={14} /></button>
      </div>
      <button className="debug-apply" disabled={debugState.status !== "paused" || busy} title="Save edits, compile, and reload changed method bodies without restarting" onClick={() => void applyChanges()}><RefreshCw size={13} />{busy ? "Applying code changes…" : "Apply code changes"}</button>
      <details className="debug-hot-swap-hint"><summary>HotSwap limitations</summary>Pause to apply method-body edits. Changes to fields or methods may require a restart. Active calls keep their previous code until they return.</details>
      {applyError && <div className="debug-inspect-message" role="alert">{applyError}</div>}
      {applyResult && <div className="debug-apply-result" role="status">
        {applyResult.appliedClasses.length > 0 && <div>Applied {applyResult.appliedClasses.length} class{applyResult.appliedClasses.length === 1 ? "" : "es"}. Existing objects and state are preserved.</div>}
        {applyResult.deferredClasses.length > 0 && <div>{applyResult.deferredClasses.length} class{applyResult.deferredClasses.length === 1 ? "" : "es"} will use the compiled changes when first loaded.</div>}
        {!applyResult.appliedClasses.length && !applyResult.deferredClasses.length && !applyResult.failedClasses.length && <div>No compiled code changes.</div>}
        {applyResult.restartRequired && <div>Some changes require restarting the debug session.</div>}
        {applyResult.warnings?.map((warning) => <div key={warning}>{warning}</div>)}
        {applyResult.failedClasses.map((item) => <div key={item.className}>{item.className}: {item.message}</div>)}
      </div>}
      {debugState.status === "paused" ? <>
        {debugState.stopReason && <div className="debug-inspect-message" role="status">{debugState.stopReason}</div>}
        <div className="debug-location">{debugState.className}.{debugState.method}<span>:{debugState.line}</span></div>
        <div className="debug-section-title">Variables</div>
        {debugState.inspectionError && <div className="debug-inspect-message" role="alert">{debugState.inspectionError}</div>}
        <div className="debug-variables">{debugState.variables.length === 0 ? <div className="debug-empty">No local variables</div> : debugState.variables.map((variable) => <DebugVariable key={variable.reference ?? variable.name} variable={variable} onInspect={onInspect} disabled={busy} />)}</div>
      </> : <div className="debug-empty">Waiting for a breakpoint</div>}
    </aside>}
  </section>;
}

function DebugVariable({ variable, onInspect, depth = 0, disabled = false }: { variable: JavaDebugVariable; onInspect: Props["onInspect"]; depth?: number; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<JavaDebugVariable[] | undefined>();
  const [nextStart, setNextStart] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = async (start?: number) => {
    if (!variable.reference || loading) return;
    setLoading(true); setError(undefined);
    try {
      const result = await onInspect(variable.reference, start);
      if (!mounted.current) return;
      setChildren((current) => start === undefined ? result.variables : [...(current ?? []), ...result.variables]);
      setNextStart(result.nextStart);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current) setLoading(false); }
  };
  const toggle = () => { setExpanded(!expanded); if (!expanded && children === undefined) void load(); };
  return <div>
    <div className="debug-variable" style={{ paddingLeft: 9 + depth * 14 }}>
      <span className="debug-variable-name">
        {variable.reference ? <button aria-label={`${expanded ? "Collapse" : "Expand"} ${variable.name}`} aria-expanded={expanded} disabled={disabled} onClick={toggle}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="debug-variable-spacer" />}
        <span title={variable.name}>{variable.name}</span>
      </span>
      <code title={variable.value}>{variable.value}</code>
    </div>
    {expanded && <>
      {children?.map((child) => <DebugVariable key={child.reference ?? child.name} variable={child} onInspect={onInspect} disabled={disabled} depth={depth + 1} />)}
      {loading && <div className="debug-empty">Loading values…</div>}
      {error && <div className="debug-inspect-message" role="alert">{error} <button disabled={disabled} onClick={() => void load(nextStart)}>Retry</button></div>}
      {!loading && !error && children?.length === 0 && <div className="debug-empty">No fields or elements</div>}
      {!loading && nextStart !== undefined && <button className="debug-load-more" disabled={disabled} onClick={() => void load(nextStart)}>Load more elements</button>}
    </>}
  </div>;
}
