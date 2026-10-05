import { DebugVariable } from "./DebugVariable";
import { readSettingNumber, writeSetting } from "./settings";
import { Settings, RefreshCw, ArrowDownToLine, ArrowRight, ArrowUpFromLine, Bug, CornerDownRight, Hammer, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JavaApplyChangesResult, JavaDebugState, JavaProjectOptions, ProtocolOperations } from "@remote-ide/protocol";

type Props = {
  height: number;
  log: string;
  running: boolean;
  options: JavaProjectOptions;
  debugState: JavaDebugState;
  onConfigure(): void;
  onBuild(): void;
  onRun(): void;
  onDebug(): void;
  onStop(): void;
  onDebugCommand(command: ProtocolOperations["java.debug.command"]["payload"]["command"]): void;
  onApplyChanges(): Promise<JavaApplyChangesResult>;
  onInspect(reference: string, start?: number): Promise<ProtocolOperations["java.debug.variables"]["result"]>;
  onClear(): void;
  onResizeStart(event: React.PointerEvent): void;
  onHeightChange?(height: number): void;
};

export function JavaPanel({ height, log, running, options, debugState, onConfigure, onBuild, onRun, onDebug, onStop, onDebugCommand, onApplyChanges, onInspect, onClear, onResizeStart, onHeightChange }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const [debugWidth, setDebugWidth] = useState(() => readSettingNumber("debugger.width", 380, 180, 1200));
  useEffect(() => writeSetting("debugger.width", String(debugWidth)), [debugWidth]);
  const resizeCleanup = useRef<(() => void) | undefined>();
  useEffect(() => () => resizeCleanup.current?.(), []);
  const resizeDebugger = (event: React.PointerEvent) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeCleanup.current?.();
    const startX = event.clientX; const startWidth = debugWidth;
    const move = (event: PointerEvent) => setDebugWidth(Math.max(180, Math.min((panelRef.current?.clientWidth ?? 1000) - 140, startWidth + startX - event.clientX)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
    resizeCleanup.current = end;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
  };
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
  return <section ref={panelRef} className="java-panel" style={{ height }}>
    <div className="terminal-resize-handle" role="separator" aria-label="Resize debugger height" aria-orientation="horizontal" aria-valuenow={height} tabIndex={0} onPointerDown={onResizeStart} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      onHeightChange?.(Math.max(140, Math.min(window.innerHeight - 150, height + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 30 : 10))));
    }} />
    <aside className="java-actions">
      <button title="Build Maven project" disabled={running} onClick={onBuild}><Hammer size={16} /></button>
      <button title="Run selected configuration" disabled={running || !options.selectedRunConfigurationId} onClick={onRun}><Play size={16} /></button>
      <button title="Debug selected configuration" disabled={running || !options.selectedRunConfigurationId} onClick={onDebug}><Bug size={16} /></button>
      <button title="Stop Java process" disabled={!running} onClick={onStop}><Square size={15} /></button>
      <button title="Edit Java run/debug configuration" onClick={onConfigure}><Settings size={16} /></button>
      <span />
      <button title="Clear build log" onClick={onClear}><Trash2 size={15} /></button>
    </aside>
    <div className="java-log-wrap">
      <header><span>Build Output</span><span className={running ? "running" : ""}>{running ? "Running" : "Idle"}</span></header>
      <pre ref={logRef}>{log || "Java build output will appear here."}</pre>
    </div>
    {debugState.status !== "stopped" && <aside className="debug-view" style={{ width: debugWidth }}>
      <div className="debug-resize-handle" role="separator" aria-label="Resize debugger width" aria-orientation="vertical" aria-valuenow={debugWidth} tabIndex={0} onPointerDown={resizeDebugger} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        setDebugWidth(Math.max(180, Math.min((panelRef.current?.clientWidth || 1000) - 140, debugWidth + (event.key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? 30 : 10))));
      }} />
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
