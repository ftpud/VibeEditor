import { AlertCircle, AlertTriangle, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RootedJavaDiagnostic } from "@remote-ide/protocol";

type Props = { height: number; diagnostics: RootedJavaDiagnostic[]; checking: boolean; onRefresh(): void; onOpen(diagnostic: RootedJavaDiagnostic): void; onResizeStart(event: React.PointerEvent): void; };

function sourceOf(diagnostic: RootedJavaDiagnostic): string {
  const source = (diagnostic as RootedJavaDiagnostic & { source?: unknown }).source;
  return typeof source === "string" ? source : "";
}

export function ProblemsPanel({ height, diagnostics, checking, onRefresh, onOpen, onResizeStart }: Props) {
  const [query, setQuery] = useState("");
  const [showErrors, setShowErrors] = useState(true);
  const [showWarnings, setShowWarnings] = useState(true);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return diagnostics.filter((diagnostic) => {
      if (diagnostic.severity === "error" ? !showErrors : !showWarnings) return false;
      return !needle || `${diagnostic.message} ${diagnostic.path} ${sourceOf(diagnostic)}`.toLocaleLowerCase().includes(needle);
    });
  }, [diagnostics, query, showErrors, showWarnings]);

  useEffect(() => { setSelected((index) => Math.min(index, Math.max(0, visible.length - 1))); }, [visible.length]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView?.({ block: "nearest" }); }, [selected]);

  const clearFilter = (event: React.KeyboardEvent | React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); setQuery(""); };
  const escapeFilter = (event: React.KeyboardEvent) => { if (event.key === "Escape" && query) clearFilter(event); };
  const navigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { escapeFilter(event); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length) setSelected((index) => Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
      return;
    }
    if (event.key === "Enter") { const diagnostic = visible[selected]; if (diagnostic) { event.preventDefault(); onOpen(diagnostic); } }
  };

  return <section className="problems-panel" style={{ height }}>
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
    <header><span>Problems</span><div>
      <button type="button" className={`problem-toggle error${showErrors ? " active" : ""}`} aria-label={`Errors (${errors})`} aria-pressed={showErrors} onClick={() => { setShowErrors((value) => !value); setSelected(0); }}><AlertCircle size={13} /><span>{errors}</span></button>
      <button type="button" className={`problem-toggle warning${showWarnings ? " active" : ""}`} aria-label={`Warnings (${warnings})`} aria-pressed={showWarnings} onClick={() => { setShowWarnings((value) => !value); setSelected(0); }}><AlertTriangle size={13} /><span>{warnings}</span></button>
      <button type="button" title="Check Java project" aria-label="Check Java project" disabled={checking} onClick={onRefresh}><RefreshCw size={14} /></button>
    </div></header>
    <div className="problems-filter"><Search size={13} aria-hidden="true" /><input aria-label="Filter problems" placeholder="Filter problems" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={escapeFilter} />{query && <button type="button" aria-label="Clear problems filter" onClick={clearFilter}><X size={12} /></button>}</div>
    <div ref={listRef} className="problems-list" role="listbox" aria-label="Problems" aria-activedescendant={visible.length ? `${listId}-${selected}` : undefined} tabIndex={0} onKeyDown={navigate}>
      {checking && diagnostics.length === 0 ? <div className="problems-empty">Checking Java project...</div>
        : diagnostics.length === 0 ? <div className="problems-empty">No Java problems found</div>
          : visible.length === 0 ? <div className="problems-empty">No problems match the current filters</div>
            : visible.map((diagnostic, index) => {
              const source = sourceOf(diagnostic);
              return <button type="button" role="option" id={`${listId}-${index}`} aria-selected={index === selected} tabIndex={-1} key={`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${index}`} onMouseEnter={() => setSelected(index)} onClick={() => { setSelected(index); onOpen(diagnostic); }}>
                {diagnostic.severity === "error" ? <AlertCircle className="error" size={14} /> : <AlertTriangle className="warning" size={14} />}
                <span className="problem-message">{diagnostic.message}</span><span className="problem-location" title={diagnostic.path}>{source && <span>{source} · </span>}{diagnostic.path.split("/").pop()}:{diagnostic.line}</span>
              </button>;
            })}
    </div>
  </section>;
}
