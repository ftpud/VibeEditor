import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JavaDebugVariable, ProtocolOperations } from "@remote-ide/protocol";
export type DebugInspect = (reference: string, start?: number) => Promise<ProtocolOperations["java.debug.variables"]["result"]>;

export function DebugVariable({ variable, onInspect, depth = 0, disabled = false, initialExpanded = false }: { variable: JavaDebugVariable; onInspect: DebugInspect; depth?: number; disabled?: boolean; initialExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded);
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
  useEffect(() => { if (initialExpanded) void load(); }, []);
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
