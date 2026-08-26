import { DiffEditor } from "@monaco-editor/react";
import { GitCommitHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitCommit } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { configureMonacoThemes, monacoTheme } from "./theme";

type Props = { client: CoreClient; path: string; startLine?: number; endLine?: number; onClose(): void };

export function GitHistoryDialog({ client, path, startLine, endLine, onClose }: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selected, setSelected] = useState<GitCommit>();
  const [diff, setDiff] = useState<{ originalContent: string; modifiedContent: string }>();
  const [error, setError] = useState("");
  const selectionHistory = startLine !== undefined && endLine !== undefined;
  useEffect(() => { void client.request("git.fileHistory", { path, ...(selectionHistory ? { startLine, endLine } : {}) }).then((result) => { setCommits(result.commits); if (result.commits[0]) void selectCommit(result.commits[0]); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load file history")); }, [client, path, startLine, endLine]);
  const selectCommit = async (commit: GitCommit) => {
    setSelected(commit); setDiff(undefined);
    try { setDiff(await client.request("git.commitDiff", { hash: commit.hash, path })); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load historical diff"); }
  };
  return <div className="dialog-overlay" onMouseDown={onClose}><section className="git-history-dialog" role="dialog" aria-modal="true" aria-label="Git file history" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><h2>{selectionHistory ? "Selection History" : "File History"}</h2><span>{path}{selectionHistory ? ` · lines ${startLine}-${endLine}` : ""}</span></div><button title="Close" onClick={onClose}><X size={15} /></button></header>
    <div className="git-history-content"><aside>{commits.length === 0 && !error && <div className="git-log-empty">No commits found</div>}{commits.map((commit) => <button className={selected?.hash === commit.hash ? "selected" : ""} key={commit.hash} onClick={() => void selectCommit(commit)}><GitCommitHorizontal size={14} /><span><strong>{commit.subject}</strong><small>{commit.shortHash} · {commit.author}</small></span><time>{new Date(commit.date).toLocaleString()}</time></button>)}</aside><main>{error && <div className="git-log-error">{error}</div>}{selected && diff ? <DiffEditor original={diff.originalContent} modified={diff.modifiedContent} language={languageFor(path)} beforeMount={configureMonacoThemes} theme={monacoTheme()} options={{ automaticLayout: true, readOnly: true, renderSideBySide: false, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }} /> : <div className="git-log-empty">Select a commit</div>}</main></div>
  </section></div>;
}

function languageFor(filePath: string): string { return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", java: "java", json: "json", css: "css", html: "html", md: "markdown", py: "python", cds: "sap-cds" } as Record<string, string>)[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"; }
