import { ArrowUp, Check, ChevronDown, GitBranch, GitCompareArrows, LoaderCircle, MoreVertical, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GitBranch as Branch } from "@remote-ide/protocol";

type Props = {
  current: string;
  menu?: { branches: Branch[]; loading: boolean };
  onToggle(): void;
  onClose(): void;
  onRefresh(): void;
  onCreate(): void;
  onCheckout(branch: Branch): Promise<void> | void;
  onRename(branch: Branch): void;
  onDelete(branch: Branch): void;
  onPublish(branch: Branch): void;
  onSetUpstream(branch: Branch): void;
};

export function BranchPicker({ current, menu, onToggle, onClose, onRefresh, onCreate, onCheckout, onRename, onDelete, onPublish, onSetUpstream }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"local" | "remote">("local");
  const [actions, setActions] = useState<string>();
  const [switching, setSwitching] = useState<string>();
  const open = !!menu;
  useEffect(() => {
    if (!open) { setQuery(""); setActions(undefined); return; }
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) closeRef.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeRef.current(); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const branches = (menu?.branches ?? []).filter((branch) => branch.remote === (scope === "remote") && branch.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  const checkout = async (branch: Branch) => { if (branch.current || switching) return; setSwitching(branch.name); try { await onCheckout(branch); } finally { setSwitching(undefined); } };
  return <div className="branch-picker" ref={root}>
    <button ref={trigger} className="branch-picker-trigger" aria-label="Git branches" aria-expanded={open} aria-haspopup="dialog" onClick={onToggle}><GitBranch size={15} /><span>{current || "No branch"}</span><ChevronDown size={13} /></button>
    {menu && <section className="branch-picker-popover" role="dialog" aria-label="Switch branch" onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-branch-row]:not(:disabled)")];
      if (!rows.length) return;
      event.preventDefault(); const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    }}>
      <header><div><strong>Switch branch</strong><small>Select a branch to check it out</small></div><button className="icon-button" aria-label="Refresh branches" onClick={onRefresh}><RefreshCw size={15} /></button></header>
      <label className="branch-picker-search"><Search size={15} /><input autoFocus aria-label="Find a branch" placeholder="Find a branch…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="branch-picker-scopes" role="tablist" aria-label="Branch location">{(["local", "remote"] as const).map((value) => <button key={value} role="tab" aria-selected={scope === value} onClick={() => { setScope(value); setActions(undefined); }}>{value === "local" ? "Local" : "Remote"}<span>{menu.branches.filter((branch) => branch.remote === (value === "remote")).length}</span></button>)}</div>
      <div className="branch-picker-list" aria-busy={menu.loading}>
        {menu.loading ? <div className="branch-picker-empty"><LoaderCircle size={18} className="status-toast-spinner" />Loading branches…</div> : !branches.length ? <div className="branch-picker-empty">{query ? "No branches match your search" : `No ${scope} branches`}</div> : branches.map((branch) => <div className={`branch-picker-item ${branch.current ? "current" : ""}`} key={branch.name}>
          <div className="branch-picker-item-row"><button data-branch-row className="branch-picker-checkout" title={branch.current ? `Current branch: ${branch.name}` : `Checkout ${branch.name}`} disabled={!!switching} onClick={() => void checkout(branch)}><GitBranch size={15} /><span>{branch.name}</span>{switching === branch.name ? <LoaderCircle size={15} className="status-toast-spinner" /> : branch.current ? <Check size={15} /> : <small>Checkout</small>}</button><button className="icon-button" aria-label={`Actions for ${branch.name}`} aria-expanded={actions === branch.name} onClick={() => setActions(actions === branch.name ? undefined : branch.name)}><MoreVertical size={15} /></button></div>
          {actions === branch.name && <div className="branch-picker-actions">{!branch.remote && <><button disabled={branch.current} onClick={() => onRename(branch)}><Pencil size={13} />Rename</button><button onClick={() => onPublish(branch)}><ArrowUp size={13} />Publish</button><button onClick={() => onSetUpstream(branch)}><GitCompareArrows size={13} />Set upstream</button></>}<button className="danger" disabled={branch.current} onClick={() => onDelete(branch)}><Trash2 size={13} />Delete</button></div>}
        </div>)}
      </div>
      <footer><button onClick={onCreate}><Plus size={15} />Create a branch</button><kbd>esc to close</kbd></footer>
    </section>}
  </div>;
}
