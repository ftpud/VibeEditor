import { Hammer, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { JavaProjectOptions } from "@remote-ide/protocol";

type Props = {
  height: number;
  log: string;
  running: boolean;
  options: JavaProjectOptions;
  onBuild(): void;
  onRun(): void;
  onStop(): void;
  onClear(): void;
  onResizeStart(event: React.PointerEvent): void;
};

export function JavaPanel({ height, log, running, options, onBuild, onRun, onStop, onClear, onResizeStart }: Props) {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);
  return <section className="java-panel" style={{ height }}>
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
    <aside className="java-actions">
      <button title="Build Maven project" disabled={running} onClick={onBuild}><Hammer size={16} /></button>
      <button title="Run selected configuration" disabled={running || !options.selectedRunConfigurationId} onClick={onRun}><Play size={16} /></button>
      <button title="Stop Java process" disabled={!running} onClick={onStop}><Square size={15} /></button>
      <span />
      <button title="Clear build log" onClick={onClear}><Trash2 size={15} /></button>
    </aside>
    <div className="java-log-wrap">
      <header><span>Build Output</span><span className={running ? "running" : ""}>{running ? "Running" : "Idle"}</span></header>
      <pre ref={logRef}>{log || "Java build output will appear here."}</pre>
    </div>
  </section>;
}
