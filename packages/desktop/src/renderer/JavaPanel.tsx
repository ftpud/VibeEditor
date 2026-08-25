import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, Bug, CornerDownRight, Hammer, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { JavaDebugState, JavaProjectOptions, ProtocolOperations } from "@remote-ide/protocol";

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
  onClear(): void;
  onResizeStart(event: React.PointerEvent): void;
};

export function JavaPanel({ height, log, running, options, debugState, onBuild, onRun, onDebug, onStop, onDebugCommand, onClear, onResizeStart }: Props) {
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
        <button title="Continue" disabled={debugState.status !== "paused"} onClick={() => onDebugCommand("continue")}><ArrowRight size={14} /></button>
        <button title="Step over" disabled={debugState.status !== "paused"} onClick={() => onDebugCommand("stepOver")}><CornerDownRight size={14} /></button>
        <button title="Step into" disabled={debugState.status !== "paused"} onClick={() => onDebugCommand("stepInto")}><ArrowDownToLine size={14} /></button>
        <button title="Step out" disabled={debugState.status !== "paused"} onClick={() => onDebugCommand("stepOut")}><ArrowUpFromLine size={14} /></button>
      </div>
      {debugState.status === "paused" ? <>
        <div className="debug-location">{debugState.className}.{debugState.method}<span>:{debugState.line}</span></div>
        <div className="debug-section-title">Variables</div>
        <div className="debug-variables">{debugState.variables.length === 0 ? <div className="debug-empty">No local variables</div> : debugState.variables.map((variable) => <div className="debug-variable" key={variable.name}><span>{variable.name}</span><code>{variable.value}</code></div>)}</div>
      </> : <div className="debug-empty">Waiting for a breakpoint</div>}
    </aside>}
  </section>;
}
