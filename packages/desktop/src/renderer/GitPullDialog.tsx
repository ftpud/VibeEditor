import type { GitPullPreview, GitPullStrategy } from "@remote-ide/protocol";
import { LoaderCircle, X } from "lucide-react";

export function GitPullDialog({ preview, busy, error, onClose, onConfirm }: { preview: GitPullPreview; busy: boolean; error?: string; onClose(): void; onConfirm(strategy: GitPullStrategy): void }) {
  const blocked = preview.blockers.length > 0;
  return <div className="dialog-overlay" onMouseDown={() => !busy && onClose()}>
    <section className="run-config-dialog git-pull-dialog" role="dialog" aria-modal="true" aria-labelledby="git-pull-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="git-pull-title">Pull from {preview.upstream}</h2><span>{preview.branch} · fetched {new Date(preview.fetchedAt).toLocaleString()}</span></div><button aria-label="Close pull preview" disabled={busy} onClick={onClose}><X size={15} /></button></header>
      <div className="git-pull-content">
        <p>{preview.behind} incoming commit{preview.behind === 1 ? "" : "s"}; {preview.ahead} local commit{preview.ahead === 1 ? "" : "s"}.</p>
        <section><strong>Incoming commits</strong>{preview.incoming.length ? <ul aria-label="Incoming commits">{preview.incoming.map((commit) => <li key={commit.hash}><code>{commit.shortHash}</code><span>{commit.subject}</span><small>{commit.author}</small></li>)}{preview.incomingTruncated && <li>More than 50 incoming commits; only the first 50 are shown.</li>}</ul> : <p>No incoming commits.</p>}</section>
        {blocked && <section className="git-pull-blockers" role="alert"><strong>Pull blocked by dirty state</strong><p>Commit or explicitly stash these paths, then preview again. No automatic stash will be created.</p><ul>{preview.blockers.slice(0, 20).map((entry) => <li key={entry.path}><code>{entry.path}</code><span>{entry.states.join(", ")}</span></li>)}{preview.blockers.length > 20 && <li>and {preview.blockers.length - 20} more…</li>}</ul></section>}
        <p className="git-rewrite-recovery">Recovery: {preview.recovery}</p>{error && <p className="git-pull-error" role="alert">{error}</p>}
        <footer><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy || blocked || preview.behind === 0} onClick={() => onConfirm("merge")}>{busy ? <LoaderCircle className="status-toast-spinner" size={14} /> : null}Merge</button><button className="primary" disabled={busy || blocked || preview.behind === 0} onClick={() => onConfirm("rebase")}>{busy ? "Rebasing…" : "Rebase"}</button></footer>
      </div>
    </section>
  </div>;
}
