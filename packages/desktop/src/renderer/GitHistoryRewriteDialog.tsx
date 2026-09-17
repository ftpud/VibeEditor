import type { GitHistoryRewritePreview } from "@remote-ide/protocol";

export function GitHistoryRewriteDialog({ action, preview, busy, onClose, onConfirm }: { action: "amend" | "undo"; preview: GitHistoryRewritePreview; busy: boolean; onClose(): void; onConfirm(confirmedRisk: boolean): void }) {
  const risk = preview.confirmationRequired;
  return <div className="dialog-overlay" onMouseDown={() => !busy && onClose()}>
    <section className="run-config-dialog git-rollback-dialog" role="alertdialog" aria-modal="true" aria-labelledby="git-rewrite-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="git-rewrite-title">{action === "amend" ? "Amend last commit?" : "Undo last local commit?"}</h2><span>{preview.commit.shortHash} · {preview.commit.subject}</span></div></header>
      <div className="git-rollback-content">
        <p>{action === "amend" ? "Only currently staged index changes will be added to the last commit. Unstaged changes stay untouched." : preview.canUndo ? "The commit will be removed with a mixed reset. Its changes return to the working tree unstaged; existing staged changes are also unstaged." : preview.undoUnavailableReason}</p>
        <p><strong>{preview.commitFiles.length}</strong> commit file{preview.commitFiles.length === 1 ? "" : "s"} affected · <strong>{preview.indexEntries.length}</strong> staged {preview.indexEntries.length === 1 ? "entry" : "entries"} · <strong>{preview.worktreeEntries.length}</strong> unstaged/untracked {preview.worktreeEntries.length === 1 ? "entry" : "entries"} preserved.</p>
        <p>{preview.publication === "unpublished" ? "The configured upstream does not contain this commit." : preview.publication === "published" ? "This commit is already in the configured upstream; rewriting it may disrupt collaborators." : "No resolvable upstream proves whether this commit was published."}</p>
        <p className="git-rewrite-recovery">Recovery: {preview.recovery}</p>
        <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className={risk ? "danger" : ""} autoFocus disabled={busy || (action === "undo" && !preview.canUndo)} onClick={() => onConfirm(risk)}>{busy ? "Rewriting…" : action === "amend" ? "Amend Commit" : "Undo Commit"}</button></footer>
      </div>
    </section>
  </div>;
}
