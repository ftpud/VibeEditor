import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

type Props = {
  message: string;
  selectedCount: number;
  operationRunning: boolean;
  committing: boolean;
  onMessageChange(message: string): void;
  onCommit(message: string): void;
  stagedCount?: number;
  onAmend?(): void;
  /** Commits, then pushes only if the commit succeeded. */
  onCommitAndPush?(message: string): void;
  pushing?: boolean;
};

export function isCommitShortcut(event: Pick<KeyboardEvent<HTMLTextAreaElement>, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

export function GitCommitPanel({ message, selectedCount, operationRunning, committing, onMessageChange, onCommit, stagedCount = 0, onAmend, onCommitAndPush, pushing = false }: Props) {
  const [draft, setDraft] = useState(message);
  const pendingSave = useRef<ReturnType<typeof setTimeout>>();
  const lastPublished = useRef(message);
  const publish = useCallback((next: string) => {
    if (pendingSave.current) clearTimeout(pendingSave.current);
    pendingSave.current = undefined;
    if (next === lastPublished.current) return;
    lastPublished.current = next;
    onMessageChange(next);
  }, [onMessageChange]);
  useEffect(() => () => { if (pendingSave.current) clearTimeout(pendingSave.current); }, []);
  useEffect(() => {
    if (message === lastPublished.current) return;
    if (pendingSave.current) clearTimeout(pendingSave.current);
    pendingSave.current = undefined;
    lastPublished.current = message;
    setDraft(message);
  }, [message]);
  const updateDraft = (next: string) => {
    setDraft(next);
    if (pendingSave.current) clearTimeout(pendingSave.current);
    pendingSave.current = setTimeout(() => publish(next), 500);
  };
  const canCommit = !operationRunning && selectedCount > 0 && Boolean(draft.trim());
  const commit = () => { publish(draft); onCommit(draft); };
  return <form className="git-commit-panel" onSubmit={(event) => { event.preventDefault(); if (canCommit) commit(); }}>
    <textarea
      aria-label="Commit message"
      aria-keyshortcuts="Control+Enter Meta+Enter"
      placeholder="Commit message"
      value={draft}
      disabled={operationRunning}
      onChange={(event) => updateDraft(event.target.value)}
      onBlur={() => publish(draft)}
      onKeyDown={(event) => { if (canCommit && isCommitShortcut(event)) { event.preventDefault(); commit(); } }}
    />
    <footer><span>{selectedCount} selected</span>{onAmend && <button className="git-amend-button" type="button" title={stagedCount ? `Amend using ${stagedCount} staged change${stagedCount === 1 ? "" : "s"}` : "Stage changes before amending"} disabled={operationRunning || stagedCount === 0} onClick={onAmend}>Amend staged{stagedCount > 0 ? ` (${stagedCount})` : ""}</button>}<span className="git-commit-shortcut" title="Commit selected files"><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd></span>{onCommitAndPush && <button type="button" className="git-commit-push-button" title="Commit the selected files, then push" disabled={!canCommit} onClick={() => { publish(draft); onCommitAndPush(draft); }}>{pushing ? "Pushing..." : "Commit & Push"}</button>}<button disabled={!canCommit}>{committing ? "Committing..." : "Commit"}</button></footer>
  </form>;
}
