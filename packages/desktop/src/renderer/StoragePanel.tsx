import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert, Database, HardDrive, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import type { StorageCleanup, StorageSnapshot, StorageUsage } from "@remote-ide/protocol";
import type { CoreClient } from "./client";

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** exponent).toLocaleString(undefined, { maximumFractionDigits: exponent > 1 ? 2 : 1 })} ${units[exponent - 1]}`;
}

export function StoragePanel({ client, onClose }: { client: CoreClient; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<StorageSnapshot>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const [selection, setSelection] = useState<{ request: StorageCleanup; label: string; bytes: number }>();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const mounted = useRef(true);
  const busy = pending || snapshot?.phase === "scanning" || snapshot?.phase === "cleaning";
  useEffect(() => {
    mounted.current = true; let timer: ReturnType<typeof setTimeout> | undefined; let stopped = false;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const load = async (scan: boolean) => {
      try {
        const value = await client.request(scan ? "storage.scan" : "storage.status", {});
        if (stopped) return;
        setSnapshot(value); setPending(false); setError("");
        timer = setTimeout(() => void load(false), value.phase === "scanning" || value.phase === "cleaning" ? 800 : 3000);
      } catch (error) { if (!stopped) { setPending(false); setError(error instanceof Error ? error.message : "Could not load storage"); timer = setTimeout(() => void load(false), 3000); } }
    };
    void load(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0]!, last = controls[controls.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key, true);
    return () => { mounted.current = false; stopped = true; clearTimeout(timer); document.removeEventListener("keydown", key, true); previous?.focus(); };
  }, [client]);
  const refresh = async () => {
    setPending(true); setSelection(undefined); setError("");
    try { const value = await client.request("storage.scan", {}); if (mounted.current) setSnapshot(value); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Could not refresh storage"); }
    finally { if (mounted.current) setPending(false); }
  };
  const cleanup = async () => {
    if (!selection || busy) return;
    setPending(true); setError("");
    try { const value = await client.request("storage.cleanup", selection.request); if (mounted.current) { setSnapshot(value); setSelection(undefined); } }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Cleanup failed"); }
    finally { if (mounted.current) setPending(false); }
  };
  const action = (row: StorageUsage, age: StorageCleanup["age"], label: string) => {
    const bytes = row.cleanable[age] ?? 0;
    return <button disabled={busy || !bytes || snapshot?.phase !== "ready"} onClick={() => setSelection({ request: { scanId: snapshot!.id, category: row.id, age }, bytes, label: `${row.label}: ${label.toLowerCase()}` })} title={bytes ? `${formatStorageBytes(bytes)} eligible${row.id === "workflows" ? " (estimated)" : ""}` : "No eligible data"}><Trash2 size={13} />{label}</button>;
  };
  return createPortal(<div className="dialog-overlay storage-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="storage-panel" ref={panel} role="dialog" aria-modal="true" aria-labelledby="storage-title">
      <header className="storage-header"><div className="storage-heading"><HardDrive size={23} /><div><h2 id="storage-title">Server storage</h2><p>{snapshot?.server ?? "Connected server"} · Shared Vibe storage for this SSH account</p></div></div><button aria-label="Close storage" onClick={onClose}><X size={18} /></button></header>
      <div className="storage-scroll">
        <div className="storage-overview"><div><span>Vibe-managed storage</span><strong>{snapshot ? formatStorageBytes(snapshot.totalBytes) : "Calculating…"}</strong><small>{busy ? "Totals update as the scan progresses" : "Allocated disk space · links are not counted as workspace copies"}</small></div><div className="storage-disk"><Database size={18} /><div><span>{snapshot?.disk ? `${formatStorageBytes(snapshot.disk.available)} available` : "Checking disk…"}</span>{snapshot?.disk && <small>of {formatStorageBytes(snapshot.disk.total)} on the storage volume</small>}</div></div></div>
        <div className={`storage-status ${snapshot?.phase === "error" || error ? "storage-error" : ""}`} role="status" aria-live="polite">{busy ? <LoaderCircle size={15} className="storage-spin" /> : error || snapshot?.phase === "error" ? <CircleAlert size={15} /> : <Check size={15} />}<span>{error || snapshot?.message || "Starting storage scan…"}</span><button disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} />Recalculate</button></div>
        {selection && <div className="storage-confirm" role="alertdialog" aria-label="Confirm storage cleanup"><div><strong>{selection.label}</strong><p>Remove {selection.request.category === "workflows" ? "approximately " : "up to "}{formatStorageBytes(selection.bytes)}? {selection.request.age === "versions" ? "Other Vibe servers and their agents/terminals for this SSH account will be stopped. Agents using obsolete runtimes will also stop. This connection, the current release and current agent runtime remain. Obsolete versions and source caches will be removed; later connections may download/build again." : selection.request.age === "inactive" ? "Finished and unregistered workspaces, build files and their checkpoints will be permanently removed, including uncommitted changes. Root, active, selected and busy workspaces stay. Git branches are preserved." : selection.request.age === "finished" ? "Task workspaces and their build files will be permanently removed. Git branches are preserved. Busy, selected and dirty tasks are skipped." : `Data ${selection.request.age === "older" ? "older than seven days" : "from before today"} will be permanently removed. Active data is retained.`}</p>{selection.request.age === "inactive" && <label className="storage-ack"><input type="checkbox" checked={selection.request.discardChanges ?? false} onChange={(event) => setSelection({ ...selection, request: { ...selection.request, discardChanges: event.target.checked } })} />Discard uncommitted changes in inactive workspaces</label>}{selection.request.age === "versions" && <label className="storage-ack"><input type="checkbox" checked={selection.request.closeOtherSessions ?? false} onChange={(event) => setSelection({ ...selection, request: { ...selection.request, closeOtherSessions: event.target.checked } })} />Close other Vibe sessions for this SSH account</label>}</div><div><button disabled={busy} onClick={() => setSelection(undefined)}>Cancel</button><button className="storage-delete" disabled={busy || selection.request.scanId !== snapshot?.id || selection.request.age === "inactive" && !selection.request.discardChanges || selection.request.age === "versions" && !selection.request.closeOtherSessions} onClick={() => void cleanup()}><Trash2 size={14} />Remove data</button></div></div>}
        <div className="storage-categories">{snapshot?.categories.map((row) => <article className="storage-card" key={row.id}>
          <div className="storage-card-heading"><h3>{row.label}</h3><strong>{formatStorageBytes(row.bytes)}</strong></div>
          <div className="storage-bar" role="img" aria-label={`${row.label}: ${row.segments.map((segment) => `${segment.label} ${formatStorageBytes(segment.bytes)}`).join(", ") || "Empty"}`}>{row.segments.map((segment) => <span key={segment.id} className={`storage-segment storage-${segment.id}`} style={{ width: `${row.bytes ? segment.bytes / row.bytes * 100 : 0}%` }} title={`${segment.label}: ${formatStorageBytes(segment.bytes)}`} />)}</div>
          <div className="storage-legend">{row.segments.map((segment) => <span key={segment.id}><i className={`storage-${segment.id}`} />{segment.label}<b>{formatStorageBytes(segment.bytes)}</b></span>)}{!row.bytes && <span>Empty</span>}</div>
          <p>{row.description}</p>
          {!!row.entries?.length && <details className="storage-details"><summary>Review {row.entries.length} stored workspaces / versions</summary><ul>{row.entries.map((entry) => <li key={entry.path}><strong>{entry.label}</strong> · {entry.state} · {formatStorageBytes(entry.bytes)}<br /><code>{entry.path}</code></li>)}</ul></details>}
          {["tasks", "sessions", "workflows", "checkpoints", "logs", "runtime"].includes(row.id) && <footer><small>{formatStorageBytes(row.id === "runtime" ? row.cleanable.versions ?? 0 : row.id === "tasks" ? row.cleanable.inactive ?? row.cleanable.finished : row.cleanable.week)} reclaimable{row.id === "workflows" ? " (estimated)" : ""}</small><div>{row.id === "tasks" ? <>{action(row, "finished", "Remove finished")}{action(row, "inactive", "Keep root & active")}</> : row.id === "runtime" ? action(row, "versions", "Keep current version") : <>{action(row, "older", "Remove older than 7 days")}{action(row, "week", "Keep today only")}</>}</div></footer>}
        </article>)}</div>
        {!!snapshot?.warnings.length && <details className="storage-details" open><summary>Scan and cleanup notices ({snapshot.warnings.length})</summary><ul>{snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
        <details className="storage-details"><summary>Scope & calculation</summary><p>Today starts at midnight on the server. “Previous 7 days” excludes today; “older” means more than seven days ago. Keep today only removes eligible data from before today. Totals include all Vibe projects in the paths below, not arbitrary files elsewhere on the server. Shared hardlinks across separate storage units may count more than once. Provider databases and configuration stay protected. Version removal stops other verified Vibe sessions under this SSH account; unrelated SSH sessions and other users are unaffected.</p><ul>{snapshot?.paths.map((entry) => <li key={entry}><code>{entry}</code></li>)}</ul></details>
      </div>
      <footer className="storage-footer"><span>{snapshot?.updatedAt ? `Updated ${new Date(snapshot.updatedAt).toLocaleTimeString()}` : ""}</span><span>Cleanup continues if you close this panel</span></footer>
    </section>
  </div>, document.body);
}
