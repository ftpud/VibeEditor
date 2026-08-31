import { DiffEditor } from "@monaco-editor/react";
import { ChevronDown, ChevronRight, ClipboardCopy, ClipboardPaste, FileDiff, GitBranch, GitCommitVertical, GitCompareArrows, Plus, RefreshCw, Search, Tag, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GitBranch as Branch, GitCommit, GitCommitFile, GitTag } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { GitCompareDialog } from "./GitCompareDialog";
import { configureMonacoThemes, monacoTheme } from "./theme";

type Props = { client: CoreClient; height: number; onResizeStart(event: React.PointerEvent): void };

export function GitLogPanel({ client, height, onResizeStart }: Props) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tags, setTags] = useState<GitTag[]>([]);
  const [branch, setBranch] = useState("");
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commit, setCommit] = useState<GitCommit>();
  const [files, setFiles] = useState<GitCommitFile[]>([]);
  const [file, setFile] = useState<GitCommitFile>();
  const [diff, setDiff] = useState<{ originalContent: string; modifiedContent: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; reference: string; label: string; path?: string; commit?: boolean; tag?: boolean }>();
  const [compare, setCompare] = useState<{ reference: string; label: string; path?: string }>();
  const copy = (value: string, label: string) => { void window.desktop?.writeClipboard(value).then(() => setError("")).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : `Could not copy ${label}`)); setMenu(undefined); };
  const copyMessage = (hash: string) => { void client.request("git.commitMessage", { hash }).then(({ message }) => copy(message, "commit message")).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not copy commit message")); };
  const [hoveredLane, setHoveredLane] = useState<string>();
  const filteredCommits = commits.filter((item) => `${item.subject} ${item.shortHash} ${item.hash} ${item.author} ${(item.refs ?? []).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const graph = useMemo(() => buildCommitGraph(commits), [commits]);
  const visibleBranches = branches.filter((item) => item.name.toLowerCase().includes(branchQuery.trim().toLowerCase()));

  const loadBranches = async () => {
    setLoading(true);
    try {
      const [result, tagResult] = await Promise.all([client.request("git.branches", {}), client.request("git.tags", {})]);
      setBranches(result.branches);
      setTags(tagResult.tags);
      setBranch((current) => current || result.branches.find((item) => item.current)?.name || result.branches[0]?.name || "");
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load branches"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadBranches(); }, [client]);
  useEffect(() => {
    if (!branch) return;
    setLoading(true); setCommit(undefined); setFiles([]); setFile(undefined); setDiff(undefined);
    void client.request("git.log", { branch, limit: 300 }).then((result) => { setCommits(result.commits); setError(""); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load Git log")).finally(() => setLoading(false));
  }, [branch, client]);

  const selectCommit = async (selected: GitCommit) => {
    setCommit(selected); setFile(undefined); setDiff(undefined);
    try { setFiles((await client.request("git.commitFiles", { hash: selected.hash })).files); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load commit files"); }
  };
  const selectFile = async (selected: GitCommitFile) => {
    if (!commit) return;
    setFile(selected); setDiff(undefined);
    try { setDiff(await client.request("git.commitDiff", { hash: commit.hash, path: selected.path, ...(selected.originalPath ? { originalPath: selected.originalPath } : {}) })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load commit diff"); }
  };
  const applyCommit = async (hash: string, createCommit: boolean) => {
    setLoading(true); setError(""); setMenu(undefined);
    try {
      await client.request("git.cherryPick", { hash, commit: createCommit });
      if (createCommit) {
        const result = await client.request("git.log", { branch, limit: 300 });
        setCommits(result.commits);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : `Could not ${createCommit ? "cherry-pick" : "apply"} commit`); }
    finally { setLoading(false); }
  };
  const createTag = async () => {
    if (!commit) return;
    const name = window.prompt(`Create a local tag at ${commit.shortHash}. This stays local; it will not be pushed.`, "");
    if (!name?.trim()) return;
    setLoading(true); setError("");
    try { const result = await client.request("git.createTag", { name: name.trim(), target: commit.hash }); setTags((current) => [...current.filter((tag) => tag.name !== result.tag.name), result.tag].sort((left, right) => left.name.localeCompare(right.name))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create local tag"); }
    finally { setLoading(false); }
  };
  const deleteTag = async (name: string) => {
    if (!window.confirm(`Delete local tag '${name}'? This does not delete or change any remote tag.`)) return;
    setLoading(true); setError(""); setMenu(undefined);
    try { await client.request("git.deleteTag", { name }); setTags((current) => current.filter((tag) => tag.name !== name)); if (branch === name) setBranch(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete local tag"); }
    finally { setLoading(false); }
  };

  return <section className="git-log-panel" style={{ height }}>
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
    <aside className="git-log-branches"><header><span>Refs</span><button title="Refresh branches and local tags" disabled={loading} onClick={() => void loadBranches()}><RefreshCw size={13} /></button></header><label className="git-branch-search"><Search size={12} /><input value={branchQuery} onChange={(event) => setBranchQuery(event.target.value)} placeholder="Find branch or tag" /></label><div className="git-branch-tree"><BranchGroup title="Local branches" branches={visibleBranches.filter((item) => !item.remote)} selected={branch} onSelect={setBranch} onContextMenu={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, reference: item.name, label: item.name }); }} /><BranchGroup title="Remote branches" branches={visibleBranches.filter((item) => item.remote)} selected={branch} onSelect={setBranch} onContextMenu={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, reference: item.name, label: item.name }); }} /><TagGroup tags={tags.filter((item) => item.name.toLowerCase().includes(branchQuery.trim().toLowerCase()))} selected={branch} disabled={loading || !commit} onSelect={setBranch} onCreate={() => void createTag()} onContextMenu={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, reference: item.name, label: item.name, tag: true }); }} /></div></aside>
    <section className="git-log-commits"><header><span>Log {branch}</span><label className="git-commit-search"><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commits" /></label></header><div>{filteredCommits.map((item) => <button className={commit?.hash === item.hash ? "selected" : ""} key={item.hash} onClick={() => void selectCommit(item)} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, reference: item.hash, label: `${item.shortHash} ${item.subject}`, commit: true }); }}><CommitGraph row={graph.rows.get(item.hash)} width={graph.width} hoveredLane={hoveredLane} onHover={setHoveredLane} /><span className="commit-subject"><span>{item.subject}</span>{item.refs?.map((ref) => <small className="commit-ref" key={ref}>{ref}</small>)}</span><span className="commit-meta">{item.shortHash} · {item.author}</span><time>{new Date(item.date).toLocaleString()}</time></button>)}</div></section>
    <section className="git-log-details"><header>{commit ? <><span>{commit.subject}</span><code>{commit.shortHash}</code></> : <span>Commit details</span>}</header>{error && <div className="git-log-error">{error}</div>}<div className="commit-files">{files.map((item) => <button className={file?.path === item.path ? "selected" : ""} key={`${item.status}:${item.path}`} onClick={() => void selectFile(item)} onContextMenu={(event) => { event.preventDefault(); if (commit) setMenu({ x: event.clientX, y: event.clientY, reference: commit.hash, label: `${commit.shortHash} · ${item.path}`, path: item.path }); }}><FileDiff size={13} /><span>{item.path}</span><code>{item.status}</code></button>)}</div><div className="commit-diff">{file && diff ? <DiffEditor original={diff.originalContent} modified={diff.modifiedContent} language={languageFor(file.path)} beforeMount={configureMonacoThemes} theme={monacoTheme()} options={{ automaticLayout: true, readOnly: true, renderSideBySide: false, minimap: { enabled: false }, fontSize: 11, scrollBeyondLastLine: false }} /> : <div className="git-log-empty">{commit ? "Select a changed file" : "Select a commit"}</div>}</div></section>
    {menu && <div className="context-menu-layer" onMouseDown={() => setMenu(undefined)}><div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - (menu.commit ? 165 : 80)) }} onMouseDown={(event) => event.stopPropagation()}>{menu.commit && <><button onClick={() => copy(menu.reference, "commit hash")}><ClipboardCopy size={14} /><span>Copy Commit Hash</span></button><button onClick={() => copyMessage(menu.reference)}><ClipboardCopy size={14} /><span>Copy Commit Message</span></button><button disabled={loading} onClick={() => void applyCommit(menu.reference, true)}><GitCommitVertical size={14} /><span>Cherry-pick Commit</span></button><button disabled={loading} onClick={() => void applyCommit(menu.reference, false)}><ClipboardPaste size={14} /><span>Apply to Working Tree</span></button></>}<button onClick={() => { setCompare({ reference: menu.reference, label: menu.label, ...(menu.path ? { path: menu.path } : {}) }); setMenu(undefined); }}><GitCompareArrows size={14} /><span>Compare with Local</span></button>{menu.tag && <button className="danger" disabled={loading} onClick={() => void deleteTag(menu.reference)}><Trash2 size={14} /><span>Delete local tag</span></button>}</div></div>}
    {compare && <GitCompareDialog client={client} reference={compare.reference} label={compare.label} path={compare.path} onClose={() => setCompare(undefined)} />}
  </section>;
}

type GraphLane = { id: string; color: string; commit: string; label?: string };
type GraphSegment = { lane: GraphLane; path: string };
type CommitGraphRow = { segments: GraphSegment[]; current: GraphLane; currentX: number; lanes: number };

const graphColors = ["#57a6ff", "#d48be8", "#62c58b", "#e7a85c", "#df7080", "#7fc8d6", "#a8b86a", "#9d91f3"];
const graphX = (index: number) => 10 + index * 15;

function buildCommitGraph(commits: GitCommit[]): { rows: Map<string, CommitGraphRow>; width: number } {
  let lanes: GraphLane[] = []; let sequence = 0; let maximumLanes = 1;
  const rows = new Map<string, CommitGraphRow>();
  const createLane = (commit: string): GraphLane => { const index = sequence++; return { id: `git-lane-${index}`, color: graphColors[index % graphColors.length]!, commit }; };
  for (const commit of commits) {
    let currentIndex = lanes.findIndex((lane) => lane.commit === commit.hash);
    if (currentIndex < 0) { lanes.unshift(createLane(commit.hash)); currentIndex = 0; }
    const before = [...lanes]; const current = before[currentIndex]!;
    if (commit.refs?.length) current.label = commit.refs.join(", ");
    const after = before.filter((_, index) => index !== currentIndex);
    const targets: { lane: GraphLane; index: number }[] = [];
    for (const [parentIndex, parent] of (commit.parents ?? []).entries()) {
      let targetIndex = after.findIndex((lane) => lane.commit === parent);
      let target = targetIndex >= 0 ? after[targetIndex]! : undefined;
      if (!target) {
        target = parentIndex === 0 ? { ...current, commit: parent } : createLane(parent);
        targetIndex = Math.min(currentIndex + parentIndex, after.length);
        after.splice(targetIndex, 0, target);
      }
      targets.push({ lane: target, index: targetIndex });
    }
    const segments: GraphSegment[] = [];
    for (const [index, lane] of before.entries()) {
      if (index === currentIndex) { segments.push({ lane, path: `M ${graphX(index)} 0 L ${graphX(index)} 24` }); continue; }
      const nextIndex = after.findIndex((candidate) => candidate.id === lane.id);
      if (nextIndex >= 0) segments.push({ lane, path: `M ${graphX(index)} 0 C ${graphX(index)} 16, ${graphX(nextIndex)} 32, ${graphX(nextIndex)} 48` });
    }
    for (const target of targets) segments.push({ lane: target.lane, path: `M ${graphX(currentIndex)} 24 C ${graphX(currentIndex)} 32, ${graphX(target.index)} 40, ${graphX(target.index)} 48` });
    maximumLanes = Math.max(maximumLanes, before.length, after.length);
    rows.set(commit.hash, { segments, current, currentX: graphX(currentIndex), lanes: Math.max(before.length, after.length) });
    lanes = after;
  }
  return { rows, width: Math.min(132, graphX(maximumLanes - 1) + 10) };
}

function CommitGraph({ row, width, hoveredLane, onHover }: { row?: CommitGraphRow; width: number; hoveredLane?: string; onHover(id?: string): void }) {
  if (!row) return <span className="git-graph-placeholder" />;
  return <svg className={`git-commit-graph ${hoveredLane ? "has-highlight" : ""}`} style={{ width }} viewBox={`0 0 ${width} 48`} preserveAspectRatio="none" onMouseLeave={() => onHover(undefined)} aria-label={row.current.label ? `Git graph: ${row.current.label}` : "Git commit graph"}>
    {row.segments.map((segment, index) => <g className={hoveredLane === segment.lane.id ? "highlighted" : hoveredLane ? "dimmed" : ""} key={`${segment.lane.id}:${index}`} onMouseEnter={() => onHover(segment.lane.id)}><title>{segment.lane.label ?? "Branch lane"}</title><path className="git-graph-hit" d={segment.path} /><path className="git-graph-line" d={segment.path} stroke={segment.lane.color} /></g>)}
    <g className={hoveredLane === row.current.id ? "highlighted" : hoveredLane ? "dimmed" : ""} onMouseEnter={() => onHover(row.current.id)}><title>{row.current.label ?? "Commit"}</title><circle className="git-graph-node-ring" cx={row.currentX} cy="24" r="6" fill={row.current.color} /><circle className="git-graph-node" cx={row.currentX} cy="24" r="3" /></g>
  </svg>;
}

function BranchGroup({ title, branches, selected, onSelect, onContextMenu }: { title: string; branches: Branch[]; selected: string; onSelect(name: string): void; onContextMenu(event: React.MouseEvent, branch: Branch): void }) {
  const [open, setOpen] = useState(true);
  const tree = useMemo(() => branchTree(branches), [branches]);
  return <div className="branch-group"><button className="branch-group-title" onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{title}</span><small>{branches.length}</small></button>{open && tree.map((node) => <BranchTreeNode key={node.path} node={node} depth={0} selected={selected} onSelect={onSelect} onContextMenu={onContextMenu} />)}</div>;
}

export function TagGroup({ tags, selected, disabled, onSelect, onCreate, onContextMenu }: { tags: GitTag[]; selected: string; disabled: boolean; onSelect(name: string): void; onCreate(): void; onContextMenu(event: React.MouseEvent, tag: GitTag): void }) {
  const [open, setOpen] = useState(true);
  return <div className="branch-group"><div className="tag-group-header"><button className="branch-group-title" onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Tag size={13} /><span>Local tags</span><small>{tags.length}</small></button><button className="tag-create" title={disabled ? "Select a commit to create a local tag" : "Create local tag at selected commit"} aria-label="Create local tag" disabled={disabled} onClick={onCreate}><Plus size={13} /></button></div>{open && <p className="tag-local-note">Create/delete affects this local repository only.</p>}{open && tags.map((tag) => <button className={`branch-row ${selected === tag.name ? "selected" : ""}`} key={tag.name} onClick={() => onSelect(tag.name)} onContextMenu={(event) => onContextMenu(event, tag)}><Tag size={13} /><span>{tag.name}</span><small title={tag.target}>{tag.target.slice(0, 7)}{tag.annotated ? " · annotated" : ""}</small></button>)}</div>;
}

type BranchNode = { name: string; path: string; branch?: Branch; children: BranchNode[] };

function branchTree(branches: Branch[]): BranchNode[] {
  const roots: BranchNode[] = [];
  for (const branch of [...branches].sort((left, right) => left.name.localeCompare(right.name))) {
    let nodes = roots; let path = "";
    for (const [index, part] of branch.name.split("/").entries()) {
      path = path ? `${path}/${part}` : part;
      let node = nodes.find((item) => item.name === part);
      if (!node) { node = { name: part, path, children: [] }; nodes.push(node); }
      if (index === branch.name.split("/").length - 1) node.branch = branch;
      nodes = node.children;
    }
  }
  return roots;
}

function BranchTreeNode({ node, depth, selected, onSelect, onContextMenu }: { node: BranchNode; depth: number; selected: string; onSelect(name: string): void; onContextMenu(event: React.MouseEvent, branch: Branch): void }) {
  const [open, setOpen] = useState(true);
  const folder = node.children.length > 0;
  return <>{<button className={`branch-row ${node.branch && selected === node.branch.name ? "selected" : ""}`} style={{ paddingLeft: 18 + depth * 13 }} onClick={() => node.branch ? onSelect(node.branch.name) : setOpen((value) => !value)} onContextMenu={(event) => { if (node.branch) onContextMenu(event, node.branch); }}>{folder ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <GitBranch size={13} />}<span>{node.name}</span>{node.branch?.current && <small>current</small>}</button>}{folder && open && node.children.map((child) => <BranchTreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} onContextMenu={onContextMenu} />)}</>;
}

function languageFor(filePath: string): string {
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", java: "java", json: "json", css: "css", html: "html", md: "markdown", py: "python", cds: "sap-cds" } as Record<string, string>)[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}
