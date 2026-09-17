import { useEffect, useRef, useState } from "react";
import { applyPatch } from "diff";
import { X } from "lucide-react";
import type { GitCommitPatch } from "@remote-ide/protocol";
import type { CoreClient } from "./client";

type Props = { client: CoreClient; hash: string; label: string; onClose(): void; onApplied(): void };

export function insertedBlock(content: string): string {
  const lines = content.split("\n").slice(1);
  return lines.flatMap((line, index) => line.startsWith("+") ? [line.slice(1) + (lines[index + 1]?.startsWith("\\ No newline") ? "" : "\n")] : []).join("");
}

export function GitCommitPatchDialog({ client, hash, label, onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<GitCommitPatch>();
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [fileIndex, setFileIndex] = useState(0);
  const [blockIndex, setBlockIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setPreview(undefined); setDrafts({}); setApplied(new Set()); setFileIndex(0); setBlockIndex(0);
    void client.request("git.commitPatch", { hash }).then((next) => { if (!cancelled) setPreview(next); }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, hash]);
  const file = preview?.files[fileIndex];
  const block = file?.hunks[blockIndex];
  const result = file ? Object.hasOwn(drafts, file.path) ? drafts[file.path] : file.indexContent : undefined;
  const changed = preview?.files.filter((item) => Object.hasOwn(drafts, item.path) && drafts[item.path] !== item.indexContent) ?? [];
  const blocks = preview?.files.flatMap((item, fi) => item.hunks.map((_, bi) => ({ fi, bi }))) ?? [];
  const position = blocks.findIndex(({ fi, bi }) => fi === fileIndex && bi === blockIndex);
  const navigate = (offset: number) => {
    const next = blocks[position + offset];
    if (next) { setFileIndex(next.fi); setBlockIndex(next.bi); setError(""); }
  };
  const edit = (content: string | null) => { if (file) setDrafts((previous) => ({ ...previous, [file.path]: content })); };
  const useBlock = (insert: boolean) => {
    if (!file || !block || typeof result !== "string") return;
    setError("");
    if (insert) {
      const start = editor.current?.selectionStart ?? result.length;
      const text = insertedBlock(block.content);
      edit(result.slice(0, start) + text + result.slice(start));
      requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(start, start + text.length); });
    } else {
      const next = applyPatch(result, `--- a/file\n+++ b/file\n${block.content}`);
      if (next === false) { setError("This block does not match the result. Edit the result manually, or place the cursor and use Insert block at cursor to insert its added lines."); return; }
      edit(next);
    }
    setApplied((previous) => new Set([...previous, block.id]));
  };
  const save = async () => {
    if (!preview || !changed.length) return;
    setBusy(true); setError("");
    try {
      await client.request("git.saveCommitResults", { hash: preview.hash, indexVersion: preview.indexVersion, files: changed.map((item) => ({ path: item.path, content: drafts[item.path]! })) });
      onApplied(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const close = () => { if (changed.length) setConfirmClose(true); else onClose(); };
  return <div className="dialog-overlay"><section className="commit-patch-dialog" role="dialog" aria-modal="true" aria-label="Apply selected commit changes" aria-busy={busy || loading}>
    <header><div><h2>Apply Selected Commit Changes</h2><small>{label}</small></div><button aria-label="Close patch picker" disabled={busy} onClick={close}><X size={16} /></button></header>
    <p>Build your result from commit blocks or edit it directly. Save results to the index (staging area); working files stay unchanged.</p>
    <div className="commit-patch-toolbar"><label>File <select aria-label="Result file" disabled={busy || loading} value={fileIndex} onChange={(event) => { setFileIndex(Number(event.target.value)); setBlockIndex(0); setError(""); }}>{preview?.files.map((item, index) => <option key={item.path} value={index}>{Object.hasOwn(drafts, item.path) && drafts[item.path] !== item.indexContent ? "● " : ""}{item.path}</option>)}</select></label><span>{position >= 0 ? `Block ${position + 1} of ${blocks.length}` : "No selectable blocks"}</span><button disabled={busy || position <= 0} onClick={() => navigate(-1)}>Previous block</button><button disabled={busy || position < 0 || position >= blocks.length - 1} onClick={() => navigate(1)}>Next block</button></div>
    {error && <div className="find-error" role="alert">{error}</div>}
    <main>{loading ? <p>Loading commit changes…</p> : !file ? <p>No changes to select.</p> : <div className="commit-patch-split">
      <section className="commit-patch-source"><div className="commit-patch-pane-heading"><strong>Commit preview</strong><small>{file.path}</small></div><div className="commit-patch-block-tabs" aria-label="Commit blocks">{file.hunks.map((item, index) => <button key={item.id} disabled={busy} aria-pressed={index === blockIndex} onClick={() => setBlockIndex(index)}>Block {index + 1}{applied.has(item.id) ? " ✓" : ""}</button>)}</div>{file.reason && <p>{file.reason}</p>}{block && <div className="commit-patch-file"><pre aria-label={`${file.path} block ${blockIndex + 1} patch`}>{block.content.split("\n").map((line, index) => <span key={index} className={line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : "context"}>{line}{"\n"}</span>)}</pre></div>}<div className="commit-patch-block-actions"><button disabled={busy || !block || typeof result !== "string" || applied.has(block?.id ?? "")} onClick={() => useBlock(false)}>Apply block to result</button><button disabled={busy || !block || typeof result !== "string" || !insertedBlock(block?.content ?? "")} onClick={() => useBlock(true)}>Insert block at cursor</button><small>Apply replaces matching lines. Insert adds the block’s added lines at your cursor.</small></div></section>
      <section className="commit-patch-result"><div className="commit-patch-pane-heading"><strong>Result · editable</strong><small>{typeof result === "string" ? `${result.split("\n").length} lines` : "Unavailable"}</small></div>{file.indexContent !== undefined && !file.reason ? <><div className="commit-patch-result-actions"><label><input type="checkbox" checked={result === null} disabled={busy} onChange={(event) => edit(event.target.checked ? null : file.indexContent!)} /> Delete file from index</label><button disabled={busy || !Object.hasOwn(drafts, file.path)} onClick={() => { setDrafts((previous) => { const next = { ...previous }; delete next[file.path]; return next; }); setApplied((previous) => new Set([...previous].filter((id) => !file.hunks.some((item) => item.id === id)))); }}>Reset file</button></div>{result === null ? <p>This file will be removed from the index when you save.</p> : <textarea ref={editor} aria-label={`Result for ${file.path}`} spellCheck={false} wrap="off" disabled={busy} value={result ?? ""} onChange={(event) => edit(event.target.value)} />}</> : <p>{file.reason ?? "Result preview is unavailable. Reconnect to an updated Core."}</p>}</section>
    </div>}</main>
    <footer>{confirmClose ? <><small>Discard your unsaved result edits?</small><button disabled={busy} onClick={() => setConfirmClose(false)}>Keep editing</button><button disabled={busy} onClick={onClose}>Discard edits</button></> : <><small>{changed.length} changed {changed.length === 1 ? "file" : "files"} · Review staged changes after saving.</small><button disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy || loading || !changed.length} onClick={() => void save()}>{busy ? "Saving…" : "Save results to index"}</button></>}</footer>
  </section></div>;
}
