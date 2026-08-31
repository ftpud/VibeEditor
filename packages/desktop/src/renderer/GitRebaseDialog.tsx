import type { GitRebaseAction, GitRebasePreview, GitRebaseTodoItem } from "@remote-ide/protocol";
import { ArrowDown, ArrowUp, LoaderCircle, X } from "lucide-react";
import { useState } from "react";

const actions: GitRebaseAction[] = ["pick", "squash", "fixup", "reword", "drop"];

export function GitRebaseDialog({ preview, busy, error, onClose, onConfirm }: { preview: GitRebasePreview; busy: boolean; error?: string; onClose(): void; onConfirm(items: GitRebaseTodoItem[]): void }) {
  const [items, setItems] = useState(preview.items); const blocked = preview.blockers.length > 0; const invalid = planError(items);
  const move = (index: number, offset: number) => setItems((current) => { const target = index + offset; if (target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target]!, next[index]!]; return next; });
  const update = (index: number, change: Partial<GitRebaseTodoItem>) => setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...change } : item));
  return <div className="dialog-overlay" onMouseDown={() => !busy && onClose()}><section className="run-config-dialog git-rebase-dialog" role="dialog" aria-modal="true" aria-labelledby="git-rebase-title" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><h2 id="git-rebase-title">Interactive rebase planner</h2><span>{preview.branch} · {preview.items.length} unpublished commit{preview.items.length === 1 ? "" : "s"} above {preview.upstream}</span></div><button aria-label="Close rebase planner" disabled={busy} onClick={onClose}><X size={15} /></button></header>
    <div className="git-rebase-content"><p>Review the complete todo list before Git rewrites any commit. Commits run from top to bottom.</p>
      {blocked && <section className="git-rebase-blockers" role="alert"><strong>Rebase blocked</strong><ul>{preview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></section>}
      <ol aria-label="Interactive rebase todo list">{items.map((item, index) => <li key={item.commit.hash} className={item.action === "drop" ? "drop" : ""}>
        <span className="git-rebase-move"><button aria-label={`Move ${item.commit.subject} up`} disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button><button aria-label={`Move ${item.commit.subject} down`} disabled={busy || index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button></span>
        <select aria-label={`Action for ${item.commit.subject}`} disabled={busy} value={item.action} onChange={(event) => { const action = event.target.value as GitRebaseAction; update(index, { action, ...(action === "reword" && item.message === undefined ? { message: item.commit.subject } : {}) }); }}>{actions.map((action) => <option key={action}>{action}</option>)}</select>
        <code>{item.commit.shortHash}</code><span className="git-rebase-subject">{item.commit.subject}<small>{item.commit.author}</small></span>
        {item.action === "reword" && <input aria-label={`New message for ${item.commit.subject}`} value={item.message ?? item.commit.subject} onChange={(event) => update(index, { message: event.target.value })} />}
      </li>)}</ol>
      {preview.truncated && <p role="alert">The history exceeds the 50-commit planner limit.</p>}<p className="git-rewrite-recovery">Recovery: {preview.recovery}</p>{(error || (!blocked && invalid)) && <p className="git-pull-error" role="alert">{error ?? invalid}</p>}
      <footer><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || blocked || Boolean(invalid)} onClick={() => onConfirm(items)}>{busy ? <><LoaderCircle className="status-toast-spinner" size={14} /> Rebasing…</> : "Start rebase"}</button></footer>
    </div>
  </section></div>;
}

export function planError(items: GitRebaseTodoItem[]): string {
  let retained = false;
  for (const item of items) { if ((item.action === "squash" || item.action === "fixup") && !retained) return `${item.action} cannot be the first retained action.`; if (item.action === "reword" && !(item.message ?? item.commit.subject).trim()) return "Reword actions require a commit message."; if (item.action !== "drop") retained = true; }
  return "";
}
