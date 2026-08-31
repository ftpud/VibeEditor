import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { GitStatusEntry } from "@remote-ide/protocol";

type Props = { entries: GitStatusEntry[]; error: string; emptyMessage?: string; groupTitle?: string; selectedPaths?: Set<string>; onTogglePath?(path: string): void; activePath?: string; onOpenDiff(entry: GitStatusEntry): void; onOpenConflict?(entry: GitStatusEntry): void; onOpenFile(entry: GitStatusEntry): void; onContextMenu?(event: ReactMouseEvent, entry: GitStatusEntry): void };

function focusRelativeRow(event: KeyboardEvent<HTMLElement>, direction: -1 | 1 | "first" | "last") {
  const rows = [...(event.currentTarget.closest(".git-changes")?.querySelectorAll<HTMLElement>("[data-git-row]") ?? [])];
  const current = rows.indexOf(event.currentTarget);
  const target = direction === "first" ? rows[0] : direction === "last" ? rows.at(-1) : rows[current + direction];
  if (target) { event.preventDefault(); target.focus(); }
}

function rowNavigation(event: KeyboardEvent<HTMLButtonElement>, onEnter: () => void, onSpace?: () => void) {
  if (event.key === "ArrowDown") return focusRelativeRow(event, 1);
  if (event.key === "ArrowUp") return focusRelativeRow(event, -1);
  if (event.key === "Home") return focusRelativeRow(event, "first");
  if (event.key === "End") return focusRelativeRow(event, "last");
  if (event.key === "Enter") { event.preventDefault(); onEnter(); }
  if (event.key === " " && onSpace) { event.preventDefault(); onSpace(); }
}

export function GitChangesView({ entries, error, emptyMessage = "No local changes", groupTitle, selectedPaths, onTogglePath, activePath, onOpenDiff, onOpenConflict, onOpenFile, onContextMenu }: Props) {
  if (error) return <div className="git-empty error" role="alert">{error}</div>;
  if (entries.length === 0) return <div className="git-empty">{emptyMessage}</div>;
  const groups = groupTitle ? [{ title: groupTitle, entries }] : [
    { title: "Conflicts", entries: entries.filter((entry) => entry.indexStatus === "U" || entry.worktreeStatus === "U" || ["AA", "DD"].includes(entry.indexStatus + entry.worktreeStatus)) },
    { title: "Untracked", entries: entries.filter((entry) => entry.indexStatus === "?" && entry.worktreeStatus === "?") },
    { title: "Staged", entries: entries.filter((entry) => entry.indexStatus !== " " && entry.indexStatus !== "?" && entry.indexStatus !== "U" && !["AA", "DD"].includes(entry.indexStatus + entry.worktreeStatus)) },
    { title: "Changes", entries: entries.filter((entry) => entry.indexStatus === " " && entry.worktreeStatus !== " " && entry.worktreeStatus !== "?" && entry.worktreeStatus !== "U") }
  ].filter((group) => group.entries.length > 0);
  return <div className="git-changes" aria-label="Git changes. Enter reviews a change; Space selects it for commit.">{groups.map((group) => <GitChangeGroup key={group.title} title={group.title} entries={group.entries} selectedPaths={selectedPaths} onTogglePath={onTogglePath} activePath={activePath} onOpenDiff={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} onContextMenu={onContextMenu} />)}</div>;
}

function GitChangeGroup({ title, entries, selectedPaths, onTogglePath, activePath, onOpenDiff, onOpenConflict, onOpenFile, onContextMenu }: Omit<Props, "error" | "emptyMessage" | "groupTitle"> & { title: string }) {
  const [expanded, setExpanded] = useState(true);
  const selectable = Boolean(onTogglePath);
  const selectedCount = entries.filter((entry) => selectedPaths?.has(entry.path)).length;
  const allSelected = entries.length > 0 && selectedCount === entries.length;
  const toggleAll = () => entries.forEach((entry) => { if ((selectedPaths?.has(entry.path) ?? false) === allSelected) onTogglePath?.(entry.path); });
  const toggle = () => setExpanded((current) => !current);
  return <section className={`git-group git-group-${title.toLowerCase()}`}>
    <button data-git-row className="git-group-title" aria-expanded={expanded} onClick={toggle} onKeyDown={(event) => { rowNavigation(event, toggle); if (event.key === "ArrowRight" && !expanded) { event.preventDefault(); toggle(); } if (event.key === "ArrowLeft" && expanded) { event.preventDefault(); toggle(); } }}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{selectable && <input type="checkbox" aria-label={`Select all ${title.toLowerCase()} files`} checked={allSelected} ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }} onClick={(event) => event.stopPropagation()} onChange={toggleAll} />}<span>{title}</span><span className="git-count">{entries.length}</span>
    </button>
    {expanded && <GitStatusTree entries={entries} selectedPaths={selectedPaths} onTogglePath={onTogglePath} activePath={activePath} onOpenDiff={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} onContextMenu={onContextMenu} />}
  </section>;
}

type GitTreeNode = { type: "directory"; name: string; path: string; children: GitTreeNode[] } | { type: "file"; name: string; path: string; entry: GitStatusEntry };
type TreeProps = Omit<Props, "error" | "emptyMessage" | "groupTitle">;

function GitStatusTree({ entries, selectedPaths, onTogglePath, activePath, onOpenDiff, onOpenConflict, onOpenFile, onContextMenu }: TreeProps) {
  const nodes = useMemo(() => buildGitTree(entries), [entries]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(collectGitDirectories(nodes)));
  useEffect(() => setExpanded((current) => new Set([...current, ...collectGitDirectories(nodes)])), [nodes]);
  const renderNodes = (items: GitTreeNode[], depth: number): ReactNode => items.map((node) => {
    if (node.type === "directory") {
      const open = expanded.has(node.path); const descendantPaths = collectGitFiles(node); const selectedCount = descendantPaths.filter((path) => selectedPaths?.has(path)).length; const allSelected = descendantPaths.length > 0 && selectedCount === descendantPaths.length;
      const toggle = () => setExpanded((current) => { const next = new Set(current); open ? next.delete(node.path) : next.add(node.path); return next; });
      const toggleAll = () => descendantPaths.forEach((path) => { if ((selectedPaths?.has(path) ?? false) === allSelected) onTogglePath?.(path); });
      return <div key={node.path}>
        <button data-git-row className="git-file-row git-directory-row" aria-expanded={open} style={{ paddingLeft: (onTogglePath ? 9 : 27) + depth * 13 }} onClick={toggle} onKeyDown={(event) => { rowNavigation(event, toggle); if (event.key === "ArrowRight" && !open) { event.preventDefault(); toggle(); } if (event.key === "ArrowLeft" && open) { event.preventDefault(); toggle(); } }}>
          {onTogglePath && <input type="checkbox" aria-label={`Select all changes under ${node.path}`} checked={allSelected} ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }} onClick={(event) => event.stopPropagation()} onChange={toggleAll} />}{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span className="git-file-name">{node.name}</span>
        </button>{open && renderNodes(node.children, depth + 1)}
      </div>;
    }
    const entry = node.entry; const deleted = entry.indexStatus === "D" || entry.worktreeStatus === "D"; const status = entry.indexStatus === "?" ? "U" : `${entry.indexStatus}${entry.worktreeStatus}`.trim(); const kind = entry.indexStatus === "U" || entry.worktreeStatus === "U" ? "conflict" : entry.indexStatus === "?" ? "untracked" : deleted ? "deleted" : entry.indexStatus === "A" ? "added" : "modified"; const checked = selectedPaths?.has(entry.path) ?? false; const active = activePath === entry.path;
    const conflicted = entry.states.includes("conflict"); const review = () => conflicted && onOpenConflict ? onOpenConflict(entry) : onOpenDiff(entry); const openFile = () => { if (!deleted) onOpenFile(entry); };
    return <button data-git-row key={node.path} className={`git-file-row ${checked ? "checked-for-commit" : ""} ${active ? "active-diff" : ""}`} aria-current={active ? "page" : undefined} style={{ paddingLeft: (onTogglePath ? 9 : 27) + depth * 13 }} title={deleted ? `${entry.path} (deleted)` : `${entry.path} — Enter: review diff; Shift+Enter: open file`} onClick={review} onDoubleClick={openFile} onKeyDown={(event) => { if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); openFile(); return; } rowNavigation(event, review, onTogglePath ? () => onTogglePath(entry.path) : undefined); }} onContextMenu={onContextMenu ? (event) => onContextMenu(event, entry) : undefined}>
      {onTogglePath && <input type="checkbox" aria-label={`Select ${entry.path} for commit`} checked={checked} onClick={(event) => event.stopPropagation()} onChange={() => onTogglePath(entry.path)} />}<FileCode2 size={14} /><span className="git-file-name">{node.name}</span><span className={`git-status ${kind}`}>{status}</span>
    </button>;
  });
  return <>{renderNodes(nodes, 0)}</>;
}

function buildGitTree(entries: GitStatusEntry[]): GitTreeNode[] {
  const root: GitTreeNode[] = []; const splitPaths = entries.map((entry) => entry.path.split("/")); let sharedDepth = 0; const maximumSharedDepth = Math.max(0, Math.min(...splitPaths.map((parts) => parts.length)) - 1);
  while (sharedDepth < maximumSharedDepth && splitPaths.every((parts) => parts[sharedDepth] === splitPaths[0]?.[sharedDepth])) sharedDepth += 1;
  for (const entry of entries) { const fullParts = entry.path.split("/"); const parts = fullParts.slice(sharedDepth); let children = root; let currentPath = fullParts.slice(0, sharedDepth).join("/"); for (let index = 0; index < parts.length; index += 1) { const name = parts[index]!; currentPath = currentPath ? `${currentPath}/${name}` : name; if (index === parts.length - 1) children.push({ type: "file", name, path: currentPath, entry }); else { let directory = children.find((node): node is Extract<GitTreeNode, { type: "directory" }> => node.type === "directory" && node.name === name); if (!directory) { directory = { type: "directory", name, path: currentPath, children: [] }; children.push(directory); } children = directory.children; } } }
  const sort = (nodes: GitTreeNode[]) => { nodes.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name)); for (const node of nodes) if (node.type === "directory") sort(node.children); }; sort(root); return compactGitDirectories(root);
}
function compactGitDirectories(nodes: GitTreeNode[]): GitTreeNode[] { return nodes.map((node) => { if (node.type === "file") return node; let compacted: Extract<GitTreeNode, { type: "directory" }> = { ...node, children: compactGitDirectories(node.children) }; while (compacted.children.length === 1 && compacted.children[0]?.type === "directory") { const child = compacted.children[0]; compacted = { ...compacted, name: `${compacted.name}/${child.name}`, path: child.path, children: child.children }; } return compacted; }); }
function collectGitDirectories(nodes: GitTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? [node.path, ...collectGitDirectories(node.children)] : []); }
function collectGitFiles(node: GitTreeNode): string[] { return node.type === "file" ? [node.entry.path] : node.children.flatMap(collectGitFiles); }
