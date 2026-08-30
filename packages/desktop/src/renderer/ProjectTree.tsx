import { Braces, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Coffee, File, FileCode2, FileJson, FileText, Folder, FolderOpen, Hash, LocateFixed } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FileColor, FileTreeNode } from "@remote-ide/protocol";
import { projectTreeActions, type ProjectTreeAction } from "./project-tree-actions";

type VisibleNode = { node: FileTreeNode; depth: number };

export function filterProjectTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node) => {
    if (node.type === "file") return `${node.name} ${node.path}`.toLowerCase().includes(needle) ? [node] : [];
    const children = filterProjectTree(node.children ?? [], needle);
    return `${node.name} ${node.path}`.toLowerCase().includes(needle) || children.length > 0 ? [{ ...node, children }] : [];
  });
}

function directoryPaths(nodes: FileTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "directory" ? [node.path, ...directoryPaths(node.children ?? [])] : []);
}

function ancestorPaths(nodes: FileTreeNode[], target: string, ancestors: string[] = []): string[] | undefined {
  for (const node of nodes) {
    if (node.path === target) return ancestors;
    if (node.type === "directory") {
      const found = ancestorPaths(node.children ?? [], target, [...ancestors, node.path]);
      if (found) return found;
    }
  }
  return undefined;
}

function visibleNodes(nodes: FileTreeNode[], expanded: Set<string>, depth = 0): VisibleNode[] {
  return nodes.flatMap((node) => [{ node, depth }, ...(node.type === "directory" && expanded.has(node.path) ? visibleNodes(node.children ?? [], expanded, depth + 1) : [])]);
}

function countFiles(nodes: FileTreeNode[]): number {
  return nodes.reduce((total, node) => total + (node.type === "file" ? 1 : countFiles(node.children ?? [])), 0);
}

export function ProjectTree({ nodes, query, activePath, fileColors, gitStatuses, onAction, onContextMenu }: {
  nodes: FileTreeNode[];
  query: string;
  activePath?: string;
  fileColors: Record<string, FileColor>;
  gitStatuses: Record<string, "M" | "C">;
  onAction(action: ProjectTreeAction, node: FileTreeNode): void;
  onContextMenu(node: FileTreeNode, x: number, y: number): void;
}) {
  const filtered = useMemo(() => filterProjectTree(nodes, query), [nodes, query]);
  const allDirectories = useMemo(() => directoryPaths(nodes), [nodes]);
  const filtering = Boolean(query.trim());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(nodes.length === 1 && nodes[0]?.type === "directory" ? [nodes[0].path] : []));
  const effectiveExpanded = useMemo(() => filtering ? new Set(directoryPaths(filtered)) : expanded, [expanded, filtered, filtering]);
  const visible = useMemo(() => visibleNodes(filtered, effectiveExpanded), [effectiveExpanded, filtered]);
  const [focusedPath, setFocusedPath] = useState<string>();
  const [revealTarget, setRevealTarget] = useState<string>();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!activePath) return;
    const ancestors = ancestorPaths(nodes, activePath);
    if (ancestors?.length) setExpanded((current) => new Set([...current, ...ancestors]));
  }, [activePath, nodes]);

  useEffect(() => {
    if (focusedPath && !visible.some(({ node }) => node.path === focusedPath)) setFocusedPath(visible[0]?.node.path);
  }, [focusedPath, visible]);

  useEffect(() => {
    if (!revealTarget || !visible.some(({ node }) => node.path === revealTarget)) return;
    const row = rowRefs.current.get(revealTarget);
    setFocusedPath(revealTarget); row?.focus(); row?.scrollIntoView({ block: "nearest" }); setRevealTarget(undefined);
  }, [revealTarget, visible]);

  const revealActiveFile = () => {
    if (!activePath) return;
    const ancestors = ancestorPaths(nodes, activePath);
    if (!ancestors) return; // The active tab may not be represented by this loaded tree.
    setExpanded((current) => new Set([...current, ...ancestors]));
    setRevealTarget(activePath);
  };

  const focusAt = (index: number) => {
    const item = visible[Math.max(0, Math.min(index, visible.length - 1))];
    if (!item) return;
    setFocusedPath(item.node.path);
    rowRefs.current.get(item.node.path)?.focus();
  };
  const toggle = (path: string, open?: boolean) => setExpanded((current) => {
    const next = new Set(current);
    const shouldOpen = open ?? !next.has(path);
    shouldOpen ? next.add(path) : next.delete(path);
    return next;
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = visible.findIndex(({ node }) => node.path === focusedPath);
    if (index < 0) return;
    const item = visible[index]!;
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(visible.length - 1);
    else if (event.key === "ArrowRight" && item.node.type === "directory") effectiveExpanded.has(item.node.path) ? focusAt(index + 1) : toggle(item.node.path, true);
    else if (event.key === "ArrowLeft") {
      if (item.node.type === "directory" && effectiveExpanded.has(item.node.path)) toggle(item.node.path, false);
      else {
        const parent = [...visible.slice(0, index)].reverse().find((candidate) => candidate.depth < item.depth);
        if (parent) focusAt(visible.indexOf(parent));
      }
    } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c" && projectTreeActions({ node: item.node }).copyAbsolutePath) onAction("copyAbsolutePath", item.node);
    else if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "c" && projectTreeActions({ node: item.node }).copyRelativePath) onAction("copyRelativePath", item.node);
    else if (event.key === "Enter" || event.key === " ") item.node.type === "file" ? onAction("open", item.node) : toggle(item.node.path);
    else if (event.key === "F2" && projectTreeActions({ node: item.node }).rename) onAction("rename", item.node);
    else if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
      const bounds = rowRefs.current.get(item.node.path)?.getBoundingClientRect();
      onContextMenu(item.node, bounds?.left ?? 0, bounds?.bottom ?? 0);
    }
    else return;
    event.preventDefault();
  };

  return <>
    <div className="project-tree-actions">
      <span>{filtering ? `${countFiles(filtered)} matching file${countFiles(filtered) === 1 ? "" : "s"}` : `${countFiles(nodes)} files`}</span>
      <button title="Reveal active file" aria-label="Reveal active file" disabled={!activePath || !ancestorPaths(nodes, activePath)} onClick={revealActiveFile}><LocateFixed size={13} /></button>
      <button title="Expand all folders" aria-label="Expand all folders" disabled={filtering || allDirectories.every((path) => expanded.has(path))} onClick={() => setExpanded(new Set(allDirectories))}><ChevronsUpDown size={13} /></button>
      <button title="Collapse all folders" aria-label="Collapse all folders" disabled={filtering || expanded.size === 0} onClick={() => setExpanded(new Set())}><ChevronsDownUp size={13} /></button>
    </div>
    <div className="tree" role="tree" aria-label="Project files" onKeyDown={onKeyDown}>
      {visible.length === 0 ? <div className="filter-empty">No matching files</div> : visible.map(({ node, depth }, index) => {
        const open = node.type === "directory" && effectiveExpanded.has(node.path);
        return node.type === "directory" ? <button key={node.path} ref={(element) => { element ? rowRefs.current.set(node.path, element) : rowRefs.current.delete(node.path); }} role="treeitem" aria-level={depth + 1} aria-expanded={open} tabIndex={(focusedPath ?? visible[0]?.node.path) === node.path ? 0 : -1} className={`tree-row ${fileColors[node.path] ? `file-color-${fileColors[node.path]}` : ""}`} style={{ paddingLeft: 7 + depth * 13 }} onFocus={() => setFocusedPath(node.path)} onContextMenu={(event) => { event.preventDefault(); onContextMenu(node, event.clientX, event.clientY); }} onClick={() => toggle(node.path)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{open ? <FolderOpen className="folder-kind-icon" size={15} /> : <Folder className="folder-kind-icon" size={15} />}<span>{node.name}</span>
        </button> : <ProjectFileRow key={node.path} node={node} depth={depth} selected={activePath === node.path} focused={(focusedPath ?? visible[0]?.node.path) === node.path} color={fileColors[node.path]} gitStatus={gitStatuses[node.path]} setRef={(element) => { element ? rowRefs.current.set(node.path, element) : rowRefs.current.delete(node.path); }} onFocus={() => setFocusedPath(node.path)} onOpen={() => onAction("open", node)} onContextMenu={onContextMenu} />;
      })}
    </div>
  </>;
}

function ProjectFileRow({ node, depth, selected, focused, color: rowColor, gitStatus, setRef, onFocus, onOpen, onContextMenu }: { node: FileTreeNode; depth: number; selected: boolean; focused: boolean; color?: FileColor; gitStatus?: "M" | "C"; setRef(element: HTMLButtonElement | null): void; onFocus(): void; onOpen(node: FileTreeNode): void; onContextMenu(node: FileTreeNode, x: number, y: number): void }) {
  const extension = node.name.split(".").pop()?.toLowerCase() ?? "";
  const appearance: Record<string, { color: string; Icon: typeof File }> = {
    ts: { color: "#5e9fd6", Icon: FileCode2 }, tsx: { color: "#5e9fd6", Icon: FileCode2 }, js: { color: "#d9c65c", Icon: FileCode2 }, jsx: { color: "#d9c65c", Icon: FileCode2 }, json: { color: "#c9b45d", Icon: FileJson }, xml: { color: "#d7a85e", Icon: FileCode2 }, html: { color: "#e8845b", Icon: FileCode2 }, css: { color: "#8d7bd8", Icon: Hash }, md: { color: "#78a7cf", Icon: FileText }, java: { color: "#d58b59", Icon: Coffee }, py: { color: "#63a86f", Icon: FileCode2 }, yaml: { color: "#ca6b75", Icon: Braces }, yml: { color: "#ca6b75", Icon: Braces }, mta: { color: "#ca6b75", Icon: Braces }, mtaext: { color: "#ca6b75", Icon: Braces }, cds: { color: "#5aa7a0", Icon: FileCode2 }
  };
  const { color, Icon } = appearance[extension] ?? { color: "#9aa0a8", Icon: File };
  return <button ref={setRef} role="treeitem" aria-level={depth + 1} tabIndex={focused ? 0 : -1} className={`tree-row file-row ${selected ? "selected" : ""} ${rowColor ? `file-color-${rowColor}` : ""}`} style={{ paddingLeft: 7 + depth * 13 }} onFocus={onFocus} onContextMenu={(event) => { event.preventDefault(); onContextMenu(node, event.clientX, event.clientY); }} onClick={() => onOpen(node)}>
    <span className="tree-indent" /><Icon className="file-kind-icon" color={color} size={14} /><span className="tree-file-name">{node.name}</span>{gitStatus && <span className={`tree-git-status ${gitStatus === "C" ? "created" : "modified"}`}>{gitStatus}</span>}
  </button>;
}
