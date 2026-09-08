import { useEffect, useState } from "react";
import { Check, FileCode2, GitMerge, X } from "lucide-react";
import type { GitConflictWorkspace } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { ConflictCompareEditor } from "./ConflictCompareEditor";

type Props = { client: CoreClient; initialPath: string; onClose(): void; onChanged(): void };
const languages: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", json: "json", css: "css", scss: "scss", html: "html", md: "markdown", py: "python", java: "java", cds: "sap-cds", sh: "shell", yaml: "yaml", yml: "yaml", xml: "xml", rs: "rust", go: "go", c: "c", h: "cpp", cpp: "cpp", sql: "sql" };

export function GitConflictWorkspaceDialog({ client, initialPath, onClose, onChanged }: Props) {
  const [workspace, setWorkspace] = useState<GitConflictWorkspace>();
  const [path, setPath] = useState(initialPath);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const file = workspace?.files.find((item) => item.path === path) ?? workspace?.files[0];
  const draft = file ? drafts[file.path] ?? file.result ?? "" : "";
  const language = languages[file?.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
  const edit = (value: string) => { if (file) setDrafts((previous) => ({ ...previous, [file.path]: value })); };
  useEffect(() => {
    let cancelled = false;
    void client.request("git.conflicts", {}).then((next) => { if (!cancelled) { setWorkspace(next); setPath(next.files.some((item) => item.path === initialPath) ? initialPath : next.files[0]?.path ?? initialPath); } }).catch((reason: unknown) => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, [client, initialPath]);
  const resolve = async (result: string | null) => {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const next = await client.request("git.resolveConflict", { path: file.path, result });
      setDrafts((previous) => { const remaining = { ...previous }; delete remaining[file.path]; return remaining; });
      setWorkspace(next); setPath(next.files[0]?.path ?? file.path); onChanged();
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const act = async (action: "continue" | "abort") => {
    if (action === "abort" && !confirm(`Abort this ${workspace?.operation}? Git will return to its pre-operation state.`)) return;
    setBusy(true); setError("");
    try { await client.request("git.conflictAction", { action }); onChanged(); onClose(); }
    catch (reason) {
      setError(message(reason));
      if (action === "continue") {
        try { const next = await client.request("git.conflicts", {}); setWorkspace(next); setPath(next.files[0]?.path ?? path); }
        catch { /* Preserve the original Git error. */ }
      }
    } finally { setBusy(false); }
  };
  return <div className="dialog-overlay"><section className="conflict-workspace" role="dialog" aria-modal="true" aria-label="Git conflict resolution workspace" aria-busy={busy}>
    <header><GitMerge size={22} /><div><h2>Resolve {workspace?.operation ?? "Git"} conflicts</h2><small>Compare versions, edit the result, then stage your resolution.</small></div><span className="conflict-count">{workspace ? `${workspace.files.length} remaining` : "Loading…"}</span><button disabled={busy} title="Close conflict workspace" onClick={onClose}><X size={16} /></button></header>
    {error && <div className="find-error" role="alert">{error}</div>}
    <div className="conflict-body"><nav aria-label="Conflicted paths"><div className="conflict-nav-title">Unresolved files</div>{workspace?.files.map((item) => <button disabled={busy} aria-current={item.path === file?.path ? "page" : undefined} className={item.path === file?.path ? "active" : ""} key={item.path} onClick={() => setPath(item.path)} title={item.path}><FileCode2 size={15} /><span>{item.path}</span>{drafts[item.path] !== undefined && <span title="Edited draft">•</span>}</button>)}</nav>
      <main>{file ? <>
        <ConflictCompareEditor key={file.path} path={file.path} base={file.base ?? ""} ours={file.ours} theirs={file.theirs} result={draft} language={language} busy={busy} onChange={edit} />
        <footer><span>Resolving stages this file in Git.</span><button disabled={busy} onClick={() => void resolve(null)}>Resolve as deleted</button><button className="conflict-primary" disabled={busy} onClick={() => void resolve(draft)}><Check size={14} />Mark result resolved</button></footer>
      </> : <div className="conflict-empty">{workspace ? <><Check size={32} /><h3>All conflicts resolved</h3><p>Every path has been validated and staged. Continue when ready.</p></> : <p>Loading conflict versions…</p>}</div>}</main>
    </div>
    {workspace && <aside>{workspace.recovery}</aside>}
    <footer className="conflict-actions"><button disabled={busy || !workspace?.canAbort} onClick={() => void act("abort")}>Abort {workspace?.operation}</button><button className="conflict-primary" disabled={busy || Boolean(workspace?.files.length) || !workspace?.canContinue} onClick={() => void act("continue")}>Continue {workspace?.operation}</button></footer>
  </section></div>;
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
