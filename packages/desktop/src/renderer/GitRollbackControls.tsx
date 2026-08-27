import type { GitStatusEntry } from "@remote-ide/protocol";
import { ArrowUp, LoaderCircle, RefreshCw, RotateCcw, X } from "lucide-react";
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

export function GitToolbarActions({ selectedCount, operationRunning, pushing, rollingBack, onRollbackSelected, onPush, onRefresh }: {
  selectedCount: number;
  operationRunning: boolean;
  pushing: boolean;
  rollingBack: boolean;
  onRollbackSelected(): void;
  onPush(): void;
  onRefresh(): void;
}) {
  return <div className="panel-header-actions git-toolbar-actions">
    <button className="git-rollback-selected" aria-label="Rollback Selected" title={selectedCount ? `Rollback ${selectedCount} selected change${selectedCount === 1 ? "" : "s"}` : "Rollback Selected"} disabled={operationRunning || selectedCount === 0} onClick={onRollbackSelected}>{rollingBack ? <LoaderCircle className="status-toast-spinner" size={14} /> : <RotateCcw size={14} />}<span>Rollback Selected</span></button>
    <button aria-label="Push" title={pushing ? "Pushing changes" : "Push"} disabled={operationRunning} onClick={onPush}>{pushing ? <LoaderCircle className="status-toast-spinner" size={14} /> : <ArrowUp size={14} />}</button>
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
