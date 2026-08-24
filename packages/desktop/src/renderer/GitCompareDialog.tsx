import { DiffEditor } from "@monaco-editor/react";
import { FileDiff, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitCommitFile } from "@remote-ide/protocol";
import type { CoreClient } from "./client";

type Props = { client: CoreClient; reference: string; label: string; path?: string; onClose(): void };

export function GitCompareDialog({ client, reference, label, path, onClose }: Props) {
  const [files, setFiles] = useState<GitCommitFile[]>([]);
  const [selected, setSelected] = useState<GitCommitFile>();
  const [diff, setDiff] = useState<{ originalContent: string; modifiedContent: string }>();
  const [error, setError] = useState("");
  const [position, setPosition] = useState(() => ({ x: Math.max(20, (window.innerWidth - Math.min(1120, window.innerWidth - 40)) / 2), y: Math.max(35, (window.innerHeight - Math.min(760, window.innerHeight - 70)) / 2) }));
  useEffect(() => { void client.request("git.compareFiles", { ref: reference, ...(path ? { path } : {}) }).then((result) => { setFiles(result.files); if (result.files[0]) void selectFile(result.files[0]); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not compare with local")); }, [client, reference, path]);
  const selectFile = async (file: GitCommitFile) => {
    setSelected(file); setDiff(undefined);
    try { setDiff(await client.request("git.compareDiff", { ref: reference, path: file.path, ...(file.originalPath ? { originalPath: file.originalPath } : {}) })); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load local diff"); }
  };
  const beginMove = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = { pointerX: event.clientX, pointerY: event.clientY, windowX: position.x, windowY: position.y };
    const move = (moveEvent: PointerEvent) => setPosition({ x: Math.max(0, Math.min(window.innerWidth - 260, start.windowX + moveEvent.clientX - start.pointerX)), y: Math.max(0, Math.min(window.innerHeight - 80, start.windowY + moveEvent.clientY - start.pointerY)) });
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };
  return <div className="floating-window-layer"><section className="git-history-dialog git-compare-dialog" style={{ left: position.x, top: position.y }} role="dialog" aria-label="Compare with local">
    <header onPointerDown={beginMove}><div><h2>Compare with Local</h2><span>{label}</span></div><button title="Close" onClick={onClose}><X size={15} /></button></header>
    <div className="git-history-content"><aside>{files.length === 0 && !error && <div className="git-log-empty">No differences</div>}{files.map((file) => <button className={selected?.path === file.path ? "selected" : ""} key={`${file.status}:${file.path}`} onClick={() => void selectFile(file)}><FileDiff size={14} /><span><strong>{file.path.split("/").pop()}</strong><small>{file.path}</small></span><time>{file.status}</time></button>)}</aside><main>{error && <div className="git-log-error">{error}</div>}{selected && diff ? <DiffEditor original={diff.originalContent} modified={diff.modifiedContent} language={languageFor(selected.path)} theme="vs-dark" options={{ automaticLayout: true, readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }} /> : <div className="git-log-empty">Select a changed file</div>}</main></div>
  </section></div>;
}

function languageFor(filePath: string): string { return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", java: "java", json: "json", css: "css", html: "html", md: "markdown", py: "python" } as Record<string, string>)[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"; }
