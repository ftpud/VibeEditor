import type { KeyboardEvent } from "react";

type Props = {
  message: string;
  selectedCount: number;
  operationRunning: boolean;
  committing: boolean;
  onMessageChange(message: string): void;
  onCommit(): void;
};

export function isCommitShortcut(event: Pick<KeyboardEvent<HTMLTextAreaElement>, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

export function GitCommitPanel({ message, selectedCount, operationRunning, committing, onMessageChange, onCommit }: Props) {
  const canCommit = !operationRunning && selectedCount > 0 && Boolean(message.trim());
  return <form className="git-commit-panel" onSubmit={(event) => { event.preventDefault(); if (canCommit) onCommit(); }}>
    <textarea
      aria-label="Commit message"
      aria-keyshortcuts="Control+Enter Meta+Enter"
      placeholder="Commit message"
      value={message}
      disabled={operationRunning}
      onChange={(event) => onMessageChange(event.target.value)}
      onKeyDown={(event) => { if (canCommit && isCommitShortcut(event)) { event.preventDefault(); onCommit(); } }}
    />
    <footer><span>{selectedCount} selected</span><span className="git-commit-shortcut" title="Commit selected files"><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd></span><button disabled={!canCommit}>{committing ? "Committing..." : "Commit"}</button></footer>
  </form>;
}
