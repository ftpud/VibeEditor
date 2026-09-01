import type { GitMergePreview } from "@remote-ide/protocol";
import { GitMerge } from "lucide-react";

export function GitMergeDialog({ preview, busy, onClose, onMerge }: { preview: GitMergePreview; busy: boolean; onClose(): void; onMerge(): void }) {
  const label = preview.outcome === "already-merged" ? "Already merged" : preview.outcome === "fast-forward" ? "Fast-forward" : "Merge commit";
  return <div className="dialog-overlay" onMouseDown={onClose}><section className="run-config-dialog git-merge-dialog" role="dialog" aria-modal="true" aria-label={`Merge ${preview.source.name}`} onMouseDown={(event) => event.stopPropagation()}>
    <header><div><h2>Merge {preview.source.name}</h2><span>{preview.source.kind.replace("-", " ")} · into {preview.branch}</span></div></header>
    <p><strong>{label}</strong> · merge base <code>{preview.mergeBase.slice(0, 12)}</code></p>
    <p>This updates the checked-out local branch only. It will not push a branch or tag.</p>
    {preview.blockers.length > 0 && <div className="find-error">{preview.blockers.join(" ")}</div>}
    <section aria-label="Incoming commits"><strong>Incoming commits ({preview.incoming.length}{preview.incomingTruncated ? "+" : ""})</strong>{preview.incoming.length ? <ul>{preview.incoming.map((commit) => <li key={commit.hash}><code>{commit.shortHash}</code> {commit.subject}</li>)}</ul> : <p>No incoming commits.</p>}</section>
    <p>{preview.recovery}</p>
    <footer><button onClick={onClose} disabled={busy}>Cancel</button><button onClick={onMerge} disabled={busy || preview.blockers.length > 0}>{busy ? "Merging…" : <><GitMerge size={14} /> {preview.outcome === "already-merged" ? "Close as already merged" : `Merge locally (${label})`}</>}</button></footer>
  </section></div>;
}
