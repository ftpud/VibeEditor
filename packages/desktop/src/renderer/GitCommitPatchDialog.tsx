import { useCallback, useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { X } from "lucide-react";
import type { GitCommitPatch } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { applyBlock } from "./conflict-merge";
import { buildCommitResultPreview, commitResultStates, hasConflictMarkers, type CommitResultPreview } from "./commit-result-preview";
import { CommitResultEditor } from "./CommitResultEditor";

type Props = { client: CoreClient; hash: string; label: string; onClose(): void; onApplied(): void };
type FilePreview = { comparison?: CommitResultPreview; error?: string };
export function GitCommitPatchDialog({ client, hash, label, onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<GitCommitPatch>();
  const [comparisons, setComparisons] = useState<Record<string, FilePreview>>({});
  const [drafts, setDrafts] = useState<Record<string, string | null>>({});
  const [fileIndex, setFileIndex] = useState(0);
  const [blockIndex, setBlockIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const resultEditor = useRef<editor.IStandaloneCodeEditor>();
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setPreview(undefined); setDrafts({}); setComparisons({}); setFileIndex(0); setBlockIndex(0);
    void (async () => {
      const next = await client.request("git.commitPatch", { hash });
      const loaded = await Promise.all(next.files.map(async (file): Promise<[string, FilePreview]> => {
        if (file.reason || file.indexContent === undefined) return [file.path, { error: file.reason ?? "Result preview unavailable." }];
        try {
          const [source, local] = await Promise.all([
            client.request("git.commitDiff", { hash: next.hash, path: file.path }),
            client.request("filesystem.readFile", { path: file.path }).then((value) => value.content).catch((reason: unknown) => {
              if (reason instanceof Error && reason.message.startsWith("FILE_NOT_FOUND:")) return "";
              throw reason;
            })
          ]);
          return [file.path, { comparison: buildCommitResultPreview(source.originalContent, local, source.modifiedContent) }];
        } catch (reason) { return [file.path, { error: reason instanceof Error ? reason.message : String(reason) }]; }
      }));
      if (!cancelled) {
        setPreview(next); setComparisons(Object.fromEntries(loaded));
        setDrafts(Object.fromEntries(loaded.flatMap(([path, value]) => value.comparison ? [[path, value.comparison.initial]] : [])));
      }
    })().catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, hash]);
  const file = preview?.files[fileIndex];
  const comparison = file ? comparisons[file.path]?.comparison : undefined;
  const block = comparison?.blocks[blockIndex];
  const result = file ? drafts[file.path] : undefined;
  const states = comparison ? commitResultStates(comparison, result ?? "") : [];
  const changed = preview?.files.filter((item) => Object.hasOwn(drafts, item.path) && drafts[item.path] !== item.indexContent) ?? [];
  const unresolved = Object.entries(drafts).some(([, value]) => value !== null && hasConflictMarkers(value));
  const blocks = preview?.files.flatMap((item, fi) => comparisons[item.path]?.comparison?.blocks.map((_, bi) => ({ fi, bi })) ?? []) ?? [];
  const position = blocks.findIndex(({ fi, bi }) => fi === fileIndex && bi === blockIndex);
  const navigate = (offset: number) => {
    const next = blocks[position + offset];
    if (next) { setFileIndex(next.fi); setBlockIndex(next.bi); setError(""); }
  };
  const filePath = file?.path;
  const edit = useCallback((content: string | null) => { if (filePath) setDrafts((previous) => ({ ...previous, [filePath]: content })); }, [filePath]);
  const useBlock = (side: "ours" | "theirs") => {
    if (!comparison || !block || typeof result !== "string") return;
    try { edit(applyBlock(comparison.base, result, block, side, comparison.blocks)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const insertBlock = () => {
    const instance = resultEditor.current;
    if (!block || !instance) return;
    const position = instance.getPosition();
    if (!position) return;
    instance.executeEdits("insert-commit-block", [{ range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: position.column, endColumn: position.column }, text: block.theirs }]);
    instance.focus();
  };
  const save = async () => {
    if (!preview || !changed.length || unresolved) return;
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
    <p>All commit blocks are previewed against your local working file. Edit the result, then save to the index. Local edits in the result will also be staged; working files stay unchanged.</p>
    <div className="commit-patch-toolbar"><label>File <select aria-label="Result file" disabled={busy || loading} value={fileIndex} onChange={(event) => { setFileIndex(Number(event.target.value)); setBlockIndex(0); setError(""); }}>{preview?.files.map((item, index) => <option key={item.path} value={index}>{drafts[item.path] !== undefined && drafts[item.path] !== item.indexContent ? "● " : ""}{item.path}</option>)}</select></label><span>{position >= 0 ? `Block ${position + 1} of ${blocks.length}` : "No incoming blocks"}</span><button disabled={busy || position <= 0} onClick={() => navigate(-1)}>Previous block</button><button disabled={busy || position < 0 || position >= blocks.length - 1} onClick={() => navigate(1)}>Next block</button></div>
    {error && <div className="find-error" role="alert">{error}</div>}
    <main>{loading ? <p>Building local comparison…</p> : !file ? <p>No changes to select.</p> : <div className="commit-patch-split">
      <section className="commit-patch-source"><div className="commit-patch-pane-heading"><strong>Commit blocks</strong><small>{file.path}</small></div><div className="commit-patch-block-tabs" aria-label="Commit blocks">{comparison?.blocks.map((item, index) => <button key={index} className={states[index]?.conflict ? "conflict" : "clean"} disabled={busy} aria-pressed={index === blockIndex} onClick={() => setBlockIndex(index)}>Block {index + 1} · {states[index]?.conflict ? "Conflict / review" : "Clean"}<small>Local line {item.oursLine}</small></button>)}</div>{block && <div className="commit-patch-file"><pre aria-label={`Incoming block ${blockIndex + 1}`}>{block.theirs || "(Delete these lines)"}</pre></div>}<div className="commit-patch-block-actions"><button disabled={busy || !block || typeof result !== "string"} onClick={() => useBlock("theirs")}>Apply block to result</button><button disabled={busy || !block || typeof result !== "string"} onClick={() => useBlock("ours")}>Keep local block</button><button disabled={busy || !block?.theirs || typeof result !== "string"} onClick={insertBlock}>Insert block at cursor</button><small>Select a block to reveal its location in the result. Apply uses the commit version; Keep local excludes it.</small></div></section>
      <section className="commit-patch-result"><div className="commit-patch-pane-heading"><strong>Local → Result · editable diff</strong><span className="commit-result-legend clean">Blue · clean</span><span className="commit-result-legend conflict">Red · conflict / review</span></div>{comparison ? <><div className="commit-patch-result-actions"><label><input type="checkbox" checked={result === null} disabled={busy} onChange={(event) => edit(event.target.checked ? null : comparison.initial)} /> Delete file from index</label><button disabled={busy} onClick={() => edit(comparison.initial)}>Reset preview</button></div>{result === null ? <p>This file will be removed from the index when you save.</p> : <CommitResultEditor key={file.path} path={file.path} preview={comparison} result={result ?? ""} selected={blockIndex} busy={busy} onChange={edit} onEditor={(instance) => { resultEditor.current = instance; }} />}</> : <p role="alert">{comparisons[file.path]?.error ?? file.reason ?? "Preview unavailable."}</p>}</section>
    </div>}</main>
    <footer>{confirmClose ? <><small>Discard your unsaved result edits?</small><button disabled={busy} onClick={() => setConfirmClose(false)}>Keep editing</button><button disabled={busy} onClick={onClose}>Discard edits</button></> : <><small>{unresolved ? "Resolve the red conflict markers before saving." : `${changed.length} changed files · Review staged changes after saving.`}</small><button disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy || loading || !changed.length || unresolved} onClick={() => void save()}>{busy ? "Saving…" : "Save results to index"}</button></>}</footer>
  </section></div>;
}
