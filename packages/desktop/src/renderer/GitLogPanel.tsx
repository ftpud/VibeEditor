import { DiffEditor } from "@monaco-editor/react";
import { ChevronDown, ChevronRight, FileDiff, GitBranch, GitCompareArrows, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitBranch as Branch, GitCommit, GitCommitFile } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { GitCompareDialog } from "./GitCompareDialog";
import { configureMonacoThemes, monacoTheme } from "./theme";

type Props = { client: CoreClient; height: number; onResizeStart(event: React.PointerEvent): void };

export function GitLogPanel({ client, height, onResizeStart }: Props) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState("");
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commit, setCommit] = useState<GitCommit>();
  const [files, setFiles] = useState<GitCommitFile[]>([]);
  const [file, setFile] = useState<GitCommitFile>();
  const [diff, setDiff] = useState<{ originalContent: string; modifiedContent: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; reference: string; label: string; path?: string }>();
  const [compare, setCompare] = useState<{ reference: string; label: string; path?: string }>();
  const filteredCommits = commits.filter((item) => `${item.subject} ${item.shortHash} ${item.hash} ${item.author} ${(item.refs ?? []).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));

  const loadBranches = async () => {
    setLoading(true);
    try {
      const result = await client.request("git.branches", {});
      setBranches(result.branches);
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

  return <section className="git-log-panel" style={{ height }}>
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
    <aside className="git-log-branches"><header><span>Branches</span><button title="Refresh branches" disabled={loading} onClick={() => void loadBranches()}><RefreshCw size={13} /></button></header><BranchGroup title="Local" branches={branches.filter((item) => !item.remote)} selected={branch} onSelect={setBranch} onContextMenu={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, reference: item.name, label: item.name }); }} /><BranchGroup title="Remote" branches={branches.filter((item) => item.remote)} selected={branch} onSelect={setBranch} onContextMenu={(event, item) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, reference: item.name, label: item.name }); }} /></aside>
    <section className="git-log-commits"><header><span>Log {branch}</span><label className="git-commit-search"><Search size={12} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commits" /></label></header><div>{filteredCommits.map((item) => <button className={commit?.hash === item.hash ? "selected" : ""} key={item.hash} onClick={() => void selectCommit(item)} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, reference: item.hash, label: `${item.shortHash} ${item.subject}` }); }}><pre className="git-commit-graph" title={`${item.parents?.length ?? 0} parent${item.parents?.length === 1 ? "" : "s"}`}>{item.graph ?? "*"}</pre><span className="commit-subject"><span>{item.subject}</span>{item.refs?.map((ref) => <small className="commit-ref" key={ref}>{ref}</small>)}</span><span className="commit-meta">{item.shortHash} · {item.author}</span><time>{new Date(item.date).toLocaleString()}</time></button>)}</div></section>
    <section className="git-log-details"><header>{commit ? <><span>{commit.subject}</span><code>{commit.shortHash}</code></> : <span>Commit details</span>}</header>{error && <div className="git-log-error">{error}</div>}<div className="commit-files">{files.map((item) => <button className={file?.path === item.path ? "selected" : ""} key={`${item.status}:${item.path}`} onClick={() => void selectFile(item)} onContextMenu={(event) => { event.preventDefault(); if (commit) setMenu({ x: event.clientX, y: event.clientY, reference: commit.hash, label: `${commit.shortHash} · ${item.path}`, path: item.path }); }}><FileDiff size={13} /><span>{item.path}</span><code>{item.status}</code></button>)}</div><div className="commit-diff">{file && diff ? <DiffEditor original={diff.originalContent} modified={diff.modifiedContent} language={languageFor(file.path)} beforeMount={configureMonacoThemes} theme={monacoTheme()} options={{ automaticLayout: true, readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 11, scrollBeyondLastLine: false }} /> : <div className="git-log-empty">{commit ? "Select a changed file" : "Select a commit"}</div>}</div></section>
    {menu && <div className="context-menu-layer" onMouseDown={() => setMenu(undefined)}><div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 50) }} onMouseDown={(event) => event.stopPropagation()}><button onClick={() => { setCompare({ reference: menu.reference, label: menu.label, ...(menu.path ? { path: menu.path } : {}) }); setMenu(undefined); }}><GitCompareArrows size={14} /><span>Compare with Local</span></button></div></div>}
    {compare && <GitCompareDialog client={client} reference={compare.reference} label={compare.label} path={compare.path} onClose={() => setCompare(undefined)} />}
  </section>;
}

function BranchGroup({ title, branches, selected, onSelect, onContextMenu }: { title: string; branches: Branch[]; selected: string; onSelect(name: string): void; onContextMenu(event: React.MouseEvent, branch: Branch): void }) {
  const [open, setOpen] = useState(true);
  return <div className="branch-group"><button className="branch-group-title" onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{title}</span><small>{branches.length}</small></button>{open && branches.map((item) => <button className={`branch-row ${selected === item.name ? "selected" : ""}`} key={item.name} onClick={() => onSelect(item.name)} onContextMenu={(event) => onContextMenu(event, item)}><GitBranch size={13} /><span>{item.name}</span>{item.current && <small>current</small>}</button>)}</div>;
}

function languageFor(filePath: string): string {
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", java: "java", json: "json", css: "css", html: "html", md: "markdown", py: "python", cds: "sap-cds" } as Record<string, string>)[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}
