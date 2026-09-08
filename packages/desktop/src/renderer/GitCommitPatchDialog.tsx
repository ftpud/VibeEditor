import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { GitCommitPatch } from "@remote-ide/protocol";
import type { CoreClient } from "./client";

type Props = { client: CoreClient; hash: string; label: string; onClose(): void; onApplied(): void };
export function GitCommitPatchDialog({ client, hash, label, onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<GitCommitPatch>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setSelected(new Set()); setPreview(undefined);
    void client.request("git.commitPatch", { hash }).then((next) => { if (!cancelled) setPreview(next); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, hash, reload]);
  const apply = async () => {
    if (!preview || !selected.size) return;
    setBusy(true); setError("");
    try {
      await client.request("git.applyCommitHunks", { hash: preview.hash, indexVersion: preview.indexVersion, hunkIds: [...selected] });
      onApplied(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const total = preview?.files.reduce((sum, file) => sum + file.hunks.length, 0) ?? 0;
  return <div className="dialog-overlay"><section className="commit-patch-dialog" role="dialog" aria-modal="true" aria-label="Apply selected commit changes" aria-busy={busy || loading}>
    <header><div><h2>Apply Selected Commit Changes</h2><small>{label}</small></div><button title="Close patch picker" disabled={busy} onClick={onClose}><X size={16} /></button></header>
    <p>Choose change blocks from this commit’s patch. Apply them to the index (staging area), without creating a commit. Working files stay unchanged.</p>
    <div className="commit-patch-toolbar"><span>{selected.size} of {total} blocks selected</span><button disabled={busy || loading || !total} onClick={() => setSelected(new Set(preview?.files.flatMap((file) => file.hunks.map((hunk) => hunk.id))))}>Select all</button><button disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</button><button disabled={busy || loading} onClick={() => setReload((value) => value + 1)}>Refresh patch</button></div>
    {error && <div className="find-error" role="alert">{error}</div>}
    <main>{loading ? <p>Loading commit changes…</p> : !preview?.files.length ? <p>No changes to select.</p> : preview.files.map((file) => <section className="commit-patch-file" key={file.path}><h3>{file.path}</h3>{file.reason && <p>{file.reason}</p>}{file.hunks.map((hunk, index) => <article className={selected.has(hunk.id) ? "selected" : ""} key={hunk.id}><label><input type="checkbox" aria-label={`Select ${file.path} block ${index + 1}`} disabled={busy} checked={selected.has(hunk.id)} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(hunk.id)) next.delete(hunk.id); else next.add(hunk.id); return next; })} /><strong>Block {index + 1}</strong><code>{hunk.content.split("\n")[0]}</code></label><pre aria-label={`${file.path} block ${index + 1} patch`}>{hunk.content.split("\n").slice(1).map((line, lineIndex) => <span key={lineIndex} className={line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : "context"}>{line}{"\n"}</span>)}</pre></article>)}</section>)}</main>
    <footer><small>Review staged changes in the Git panel after applying.</small><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || loading || !selected.size} onClick={() => void apply()}>{busy ? "Applying…" : `Apply ${selected.size} selected blocks to index`}</button></footer>
  </section></div>;
}
