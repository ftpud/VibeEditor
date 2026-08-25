import { AlertCircle, AlertTriangle, RefreshCw } from "lucide-react";
import type { JavaDiagnostic } from "@remote-ide/protocol";

type Props = {
  height: number;
  diagnostics: JavaDiagnostic[];
  checking: boolean;
  onRefresh(): void;
  onOpen(diagnostic: JavaDiagnostic): void;
  onResizeStart(event: React.PointerEvent): void;
};

export function ProblemsPanel({ height, diagnostics, checking, onRefresh, onOpen, onResizeStart }: Props) {
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.length - errors;
  return <section className="problems-panel" style={{ height }}>
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
    <header><span>Problems</span><div><span className="problem-count error"><AlertCircle size={13} />{errors}</span><span className="problem-count warning"><AlertTriangle size={13} />{warnings}</span><button title="Check Java project" disabled={checking} onClick={onRefresh}><RefreshCw size={14} /></button></div></header>
    <div className="problems-list">{checking && diagnostics.length === 0 ? <div className="problems-empty">Checking Java project...</div> : diagnostics.length === 0 ? <div className="problems-empty">No Java problems found</div> : diagnostics.map((diagnostic, index) => <button key={`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${index}`} onClick={() => onOpen(diagnostic)}>
      {diagnostic.severity === "error" ? <AlertCircle className="error" size={14} /> : <AlertTriangle className="warning" size={14} />}
      <span className="problem-message">{diagnostic.message}</span><span className="problem-location">{diagnostic.path.split("/").pop()}:{diagnostic.line}</span>
    </button>)}</div>
  </section>;
}
