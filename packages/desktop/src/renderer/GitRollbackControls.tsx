import type { GitStatusEntry, GitUpstreamStatus } from "@remote-ide/protocol";
import { ArrowDown, ArrowUp, LoaderCircle, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

export function isUntrackedGitEntry(entry: GitStatusEntry): boolean {
  return entry.indexStatus === "?" && entry.worktreeStatus === "?";
}

export function isNewGitEntry(entry: GitStatusEntry): boolean {
  return isUntrackedGitEntry(entry) || entry.indexStatus === "A" || entry.worktreeStatus === "A";
}

export function selectedGitEntries(entries: GitStatusEntry[], paths: Set<string>): GitStatusEntry[] {
  return entries.filter((entry) => paths.has(entry.path));
}

export async function executeRollbackSelection<T extends { rolledBack: string[]; failures: { path: string; message: string }[] }>(
  entries: GitStatusEntry[],
  deleteUntracked: boolean,
  request: (paths: string[], deleteUntracked: boolean) => Promise<T>,
  refreshAfterSuccess: (result: T) => Promise<void>
): Promise<T> {
  const result = await request(entries.map((entry) => entry.path), deleteUntracked);
  if (result.rolledBack.length > 0) await refreshAfterSuccess(result);
  return result;
}

export function shouldApplyGitStatus(requestId: number, latestRequestId: number, requestedWorkspace: string, activeWorkspace: string): boolean {
  return requestId === latestRequestId && requestedWorkspace === activeWorkspace;
}

export function GitToolbarActions({ selectedCount, operationRunning, pushing, fetching, rollingBack, upstream, onRollbackSelected, onUndoLastCommit, onPush, onFetch, onRefresh }: {
  selectedCount: number;
  operationRunning: boolean;
  pushing: boolean;
  fetching: boolean;
  rollingBack: boolean;
  upstream?: GitUpstreamStatus;
  onRollbackSelected(): void;
  onUndoLastCommit(): void;
  onPush(): void;
  onFetch(): void;
  onRefresh(): void;
}) {
  return <div className="panel-header-actions git-toolbar-actions">
    <button aria-label="Undo last local commit" title="Undo last local commit" disabled={operationRunning} onClick={onUndoLastCommit}><RotateCcw size={14} /></button>
    <button className="git-rollback-selected" aria-label="Rollback Selected" title={selectedCount ? `Rollback ${selectedCount} selected change${selectedCount === 1 ? "" : "s"}` : "Rollback Selected"} disabled={operationRunning || selectedCount === 0} onClick={onRollbackSelected}>{rollingBack ? <LoaderCircle className="status-toast-spinner" size={14} /> : <RotateCcw size={14} />}<span>Rollback Selected</span></button>
    <button className="git-push-button" aria-label={upstream && upstream.ahead > 0 ? `Push ${upstream.ahead} unpushed commit${upstream.ahead === 1 ? "" : "s"}` : "Push"} title={pushing ? "Pushing changes" : upstream && upstream.ahead > 0 ? `${upstream.ahead} commit${upstream.ahead === 1 ? "" : "s"} ahead of ${upstream.upstream}` : upstream ? `Push (up to date with ${upstream.upstream})` : "Push (branch is not published)"} disabled={operationRunning} onClick={onPush}>{pushing ? <LoaderCircle className="status-toast-spinner" size={14} /> : <ArrowUp size={14} />}{upstream && upstream.ahead > 0 && <span className="git-push-badge" aria-hidden="true">{upstream.ahead > 99 ? "99+" : upstream.ahead}</span>}</button>
    <button className="git-fetch-button" aria-label={fetching ? "Cancel Git fetch" : upstream?.behind ? `Fetch remote changes; ${upstream.behind} commit${upstream.behind === 1 ? "" : "s"} behind` : "Fetch remote changes"} title={fetching ? "Cancel Git fetch" : upstream ? `${upstream.behind} behind ${upstream.upstream}${upstream.lastFetch ? `; last fetched ${new Date(upstream.lastFetch).toLocaleString()}` : ""}` : "Fetch remote changes"} disabled={operationRunning && !fetching} onClick={onFetch}>{fetching ? <LoaderCircle className="status-toast-spinner" size={14} /> : <ArrowDown size={14} />}{upstream && upstream.behind > 0 && <span className="git-push-badge" aria-hidden="true">{upstream.behind > 99 ? "99+" : upstream.behind}</span>}</button>
    <button aria-label="Refresh Git status" title="Refresh Git status" disabled={operationRunning} onClick={onRefresh}><RefreshCw size={14} /></button>
  </div>;
}

export function RollbackSelectedDialog({ entries, busy, onClose, onConfirm }: { entries: GitStatusEntry[]; busy: boolean; onClose(): void; onConfirm(deleteUntracked: boolean): void }) {
  const [deletionConfirmed, setDeletionConfirmed] = useState(false);
  const untracked = entries.filter(isUntrackedGitEntry);
  const newFiles = entries.filter(isNewGitEntry);
  const requiresDeletionConfirmation = newFiles.length > 0;
  const visibleEntries = entries.slice(0, 8);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [busy, onClose]);
  return <div className="dialog-overlay" onMouseDown={() => { if (!busy) onClose(); }}>
    <section className="run-config-dialog git-rollback-dialog" role="alertdialog" aria-modal="true" aria-labelledby="git-rollback-title" aria-describedby="git-rollback-description" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="git-rollback-title">Rollback selected changes?</h2><span>{entries.length} selected path{entries.length === 1 ? "" : "s"}</span></div><button aria-label="Close rollback confirmation" title="Close" disabled={busy} onClick={onClose}><X size={15} /></button></header>
      <div className="git-rollback-content">
        <p id="git-rollback-description">All staged and unstaged changes for these paths will be restored to HEAD. Renames and conflicts will also be reset. This cannot be undone.</p>
        <ul aria-label="Paths to rollback">{visibleEntries.map((entry) => <li key={entry.path}><code>{entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}</code><span>{isUntrackedGitEntry(entry) ? "untracked" : `${entry.indexStatus}${entry.worktreeStatus}`.trim()}</span></li>)}{entries.length > visibleEntries.length && <li className="git-rollback-more">and {entries.length - visibleEntries.length} more path{entries.length - visibleEntries.length === 1 ? "" : "s"}…</li>}</ul>
        {requiresDeletionConfirmation && <label className="git-rollback-delete-confirm"><input type="checkbox" checked={deletionConfirmed} disabled={busy} onChange={(event) => setDeletionConfirmed(event.target.checked)} /><span>I understand {newFiles.length} selected new file{newFiles.length === 1 ? "" : "s"}, including {untracked.length} untracked, will be permanently deleted.</span></label>}
        <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="danger" autoFocus={!requiresDeletionConfirmation} disabled={busy || (requiresDeletionConfirmation && !deletionConfirmed)} onClick={() => onConfirm(untracked.length > 0)}>{busy ? "Rolling back…" : "Rollback Selected"}</button></footer>
      </div>
    </section>
  </div>;
}
