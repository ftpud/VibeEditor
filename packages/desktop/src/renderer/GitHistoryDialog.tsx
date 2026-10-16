import { DiffEditor } from "@monaco-editor/react";
import { GitCommitHorizontal, X } from "lucide-react";
import type { editor } from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import type { GitCommit } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { DiffNavigation } from "./DiffNavigation";
import { configureMonacoThemes, monacoTheme } from "./theme";

/** `content` is the editor buffer the selected lines refer to; Core maps them onto committed lines. */
type Props = { client: CoreClient; path: string; startLine?: number; endLine?: number; content?: string; onClose(): void };

export function GitHistoryDialog({ client, path, startLine, endLine, content, onClose }: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selected, setSelected] = useState<GitCommit>();
  const [diff, setDiff] = useState<{ originalContent: string; modifiedContent: string }>();
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor>();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const selectionHistory = startLine !== undefined && endLine !== undefined;
  useEffect(() => { void client.request("git.fileHistory", { path, ...(selectionHistory ? { startLine, endLine, ...(content !== undefined ? { content } : {}) } : {}) }).then((result) => { setCommits(result.commits); setNote(result.note ?? ""); setLoaded(true); if (result.commits[0]) void selectCommit(result.commits[0]); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load file history")); }, [client, path, startLine, endLine]);
  const selectCommit = async (commit: GitCommit) => {
    setSelected(commit); setDiff(undefined);
    // Use the file's path at that commit: before a rename it had another name.
    try { setDiff(await client.request("git.commitDiff", { hash: commit.hash, path: commit.path ?? path, ...(commit.originalPath ? { originalPath: commit.originalPath } : {}) })); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load historical diff"); }
  };
  return <div className="dialog-overlay" onMouseDown={onClose}><section className="git-history-dialog" role="dialog" aria-modal="true" aria-label="Git file history" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><h2>{selectionHistory ? "Selection History" : "File History"}</h2><span>{path}{selectionHistory ? ` · lines ${startLine}-${endLine}` : ""}</span></div><button title="Close" onClick={onClose}><X size={15} /></button></header>
    <div className="git-history-content"><aside>{note && <div className="git-history-note" role="status">{note}</div>}{commits.length === 0 && !error && loaded && !note && <div className="git-log-empty">No commits found</div>}{!loaded && !error && <div className="git-log-empty">Loading history…</div>}{commits.map((commit) => <button className={selected?.hash === commit.hash ? "selected" : ""} key={commit.hash} onClick={() => void selectCommit(commit)}><GitCommitHorizontal size={14} /><span><strong>{commit.subject}</strong><small>{commit.shortHash} · {commit.author}{commit.path && commit.path !== path ? ` · ${commit.originalPath && commit.originalPath !== commit.path ? `${commit.originalPath} → ` : ""}${commit.path}` : ""}</small></span><time>{new Date(commit.date).toLocaleString()}</time></button>)}</aside><main>{error && <div className="git-log-error">{error}</div>}{selected && diff ? <><DiffEditor original={diff.originalContent} modified={diff.modifiedContent} language={languageFor(path)} beforeMount={configureMonacoThemes} theme={monacoTheme()} onMount={(instance) => { diffEditorRef.current = instance; }} options={{ automaticLayout: true, readOnly: true, renderSideBySide: false, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }} /><DiffNavigation editorRef={diffEditorRef} /></> : <div className="git-log-empty">Select a commit</div>}</main></div>
  </section></div>;
}

function languageFor(filePath: string): string { return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", java: "java", json: "json", css: "css", html: "html", md: "markdown", py: "python", cds: "sap-cds" } as Record<string, string>)[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"; }
