import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, CircleAlert, CircleCheck, LoaderCircle, PackageOpen, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { GitCommitFile, GitStash, GitStashInclusion, GitStashPreview } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { requestConfirm } from "./dialogs";
import { configureMonacoThemes, monacoTheme } from "./theme";

const defaults: GitStashInclusion = { staged: true, unstaged: true, untracked: false, ignored: false };
const inclusions: { key: keyof GitStashInclusion; label: string; description: string }[] = [
  { key: "staged", label: "Staged", description: "Changes added to the index" },
  { key: "unstaged", label: "Unstaged", description: "Modified tracked files" },
  { key: "untracked", label: "Untracked", description: "New files Git does not track yet" },
  { key: "ignored", label: "Ignored", description: "Files matched by .gitignore (includes untracked)" }
];
const errorMessage = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
function relativeTime(date?: string): string {
  if (!date) return "";
  const seconds = (new Date(date).getTime() - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return "";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return "just now";
}
const statusKind = (status: string) => status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : status.startsWith("R") ? "renamed" : status === "?" ? "untracked" : "modified";

export function GitStashDialog({ client, selectedPaths, onClose, onChanged }: { client: CoreClient; selectedPaths: string[]; onClose(): void; onChanged(): void }) {
  const [stashes, setStashes] = useState<GitStash[]>();
  const [preview, setPreview] = useState<GitStashPreview>();
  const [file, setFile] = useState<GitCommitFile>();
  const [diff, setDiff] = useState<{ originalContent: string; modifiedContent: string }>();
  const [include, setInclude] = useState(defaults);
  const [message, setMessage] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const busyRef = useRef(busy); busyRef.current = busy;
  const close = useRef(onClose); close.current = onClose;

  const load = async () => {
    try { setStashes((await client.request("git.stashes", {})).stashes); }
    catch (reason) { setStashes([]); setNotice({ text: errorMessage(reason, "Could not load stashes"), error: true }); }
  };
  useEffect(() => {
    void load();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); close.current(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const choose = async (stash: GitStash) => {
    setFile(undefined); setDiff(undefined);
    try {
      const next = await client.request("git.stashPreview", { reference: stash.reference });
      setPreview(next); setNotice(undefined);
      if (next.files[0]) void chooseFile(next.stash, next.files[0]);
    } catch (reason) { setNotice({ text: errorMessage(reason, "Could not preview stash"), error: true }); }
  };
  const chooseFile = async (stash: GitStash, selected: GitCommitFile) => {
    setFile(selected); setDiff(undefined);
    // A stash is a commit on top of the HEAD it was made from.
    try { setDiff(await client.request("git.commitDiff", { hash: stash.hash, path: selected.path, ...(selected.originalPath ? { originalPath: selected.originalPath } : {}) })); }
    catch (reason) { setNotice({ text: errorMessage(reason, "Could not load the stashed change"), error: true }); }
  };
  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true); setNotice(undefined);
    try { const text = await action(); if (text) setNotice({ text, error: false }); }
    catch (reason) { setNotice({ text: errorMessage(reason, "The stash operation failed"), error: true }); }
    finally { setBusy(false); }
  };
  const create = () => run(async () => {
    const { stash } = await client.request("git.createStash", { include, ...(message.trim() ? { message: message.trim() } : {}), ...(selectedOnly ? { paths: selectedPaths } : {}) });
    setMessage(""); await load(); await choose(stash); onChanged();
    return `Stashed as ${stash.reference}`;
  });
  const apply = async (pop: boolean) => {
    if (!preview) return;
    const reference = preview.stash.reference;
    if (pop && !await requestConfirm({ title: "Pop stash?", message: `Apply ${reference} and drop it. It is kept if applying fails.`, confirmLabel: "Pop", danger: true })) return;
    await run(async () => {
      const result = pop ? await client.request("git.popStash", { reference, confirm: true }) : await client.request("git.applyStash", { reference });
      if (!result.stashRetained) { setPreview(undefined); setFile(undefined); setDiff(undefined); }
      await load(); onChanged();
      return result.outcome;
    });
  };
  const drop = async () => {
    if (!preview) return;
    const reference = preview.stash.reference;
    if (!await requestConfirm({ title: "Drop stash?", message: `Permanently drop ${reference}${preview.stash.message ? ` “${preview.stash.message}”` : ""}? This cannot be undone.`, confirmLabel: "Drop", danger: true })) return;
    await run(async () => {
      await client.request("git.dropStash", { reference, confirm: true });
      setPreview(undefined); setFile(undefined); setDiff(undefined); await load();
      return `Dropped ${reference}`;
    });
  };

  return <div className="dialog-overlay" onMouseDown={() => { if (!busy) onClose(); }}>
    <section className="git-history-dialog stash-dialog" role="dialog" aria-modal="true" aria-labelledby="stash-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div className="stash-title"><Archive size={17} /><div><h2 id="stash-title">Stash manager</h2><span>Shelve work in progress and bring it back later</span></div></div><button type="button" title="Close" aria-label="Close stash manager" disabled={busy} onClick={onClose}><X size={15} /></button></header>
      <div className="stash-body">
        <aside className="stash-sidebar">
          <form className="stash-create" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <strong>New stash</strong>
            <input aria-label="Stash message" placeholder="Message (optional)" value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} />
            <div className="stash-chips" role="group" aria-label="Include in stash">
              {inclusions.map(({ key, label, description }) => <label key={key} className={include[key] ? "on" : ""} title={description}><input type="checkbox" checked={include[key]} disabled={busy || key === "untracked" && include.ignored} onChange={(event) => setInclude((current) => ({ ...current, [key]: event.target.checked, ...(key === "ignored" && event.target.checked ? { untracked: true } : {}) }))} />{label}</label>)}
            </div>
            <label className="stash-scope"><input type="checkbox" checked={selectedOnly} disabled={busy || !selectedPaths.length} onChange={(event) => setSelectedOnly(event.target.checked)} />Selected paths only ({selectedPaths.length})</label>
            <button type="submit" className="stash-primary" disabled={busy || !Object.values(include).some(Boolean)}>{busy ? <LoaderCircle size={14} className="auth-spinner" /> : <Plus size={14} />}Create stash</button>
          </form>
          <div className="stash-list-header"><strong>Saved stashes</strong>{stashes && <span className="git-count">{stashes.length}</span>}<button type="button" title="Refresh stashes" aria-label="Refresh stashes" disabled={busy} onClick={() => void load()}><RefreshCw size={13} /></button></div>
          <div className="stash-list">
            {!stashes && <div className="stash-empty"><LoaderCircle size={15} className="auth-spinner" />Loading…</div>}
            {stashes?.length === 0 && <div className="stash-empty"><PackageOpen size={22} /><span>No stashes yet</span><small>Stashed changes appear here.</small></div>}
            {stashes?.map((stash) => <button type="button" key={stash.reference} className={preview?.stash.reference === stash.reference ? "selected" : ""} aria-current={preview?.stash.reference === stash.reference ? "true" : undefined} onClick={() => void choose(stash)}>
              <span className="stash-subject"><strong>{stash.message || "(no message)"}</strong><code>{stash.reference}</code></span>
              <small>{[stash.branch && `on ${stash.branch}`, relativeTime(stash.date)].filter(Boolean).join(" · ")}</small>
            </button>)}
          </div>
        </aside>
        <main className="stash-detail">
          {!preview ? <div className="stash-placeholder"><Archive size={30} /><strong>Select a stash</strong><span>Review its files and changes before applying it.</span></div> : <>
            <div className="stash-summary">
              <div><h3>{preview.stash.message || "(no message)"}</h3><small>{[preview.stash.reference, preview.stash.branch && `on ${preview.stash.branch}`, relativeTime(preview.stash.date), `${preview.files.length} file${preview.files.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</small></div>
              <div className="stash-actions">
                <button type="button" className="stash-primary" disabled={busy} title="Apply the changes and keep the stash" onClick={() => void apply(false)}><ArchiveRestore size={14} />Apply</button>
                <button type="button" disabled={busy} title="Apply the changes, then drop the stash" onClick={() => void apply(true)}>Pop</button>
                <button type="button" className="danger" disabled={busy} title="Delete the stash without applying it" onClick={() => void drop()}><Trash2 size={14} />Drop</button>
              </div>
            </div>
            <div className={`stash-risk ${preview.conflictRisk === "possible" ? "warning" : ""}`}>{preview.conflictRisk === "possible" ? <CircleAlert size={14} /> : <CircleCheck size={14} />}<span>{preview.conflictRisk === "possible" ? `May conflict with your current changes in ${preview.blockers.join(", ")}.` : "No overlap with your current changes."} {preview.recovery}</span></div>
            <div className="stash-review">
              <div className="stash-files" role="listbox" aria-label="Stashed files">{preview.files.map((item) => <button type="button" role="option" aria-selected={file?.path === item.path} key={`${item.status}:${item.path}`} className={file?.path === item.path ? "selected" : ""} title={item.originalPath ? `${item.originalPath} → ${item.path}` : item.path} onClick={() => void chooseFile(preview.stash, item)}><span className={`git-status ${statusKind(item.status)}`}>{item.status === "?" ? "U" : item.status[0]}</span><span className="stash-file-name">{item.path.split("/").pop()}</span><small>{item.path.split("/").slice(0, -1).join("/")}</small></button>)}</div>
              <div className="stash-diff">{file && diff ? <DiffEditor original={diff.originalContent} modified={diff.modifiedContent} language={languageFor(file.path)} beforeMount={configureMonacoThemes} theme={monacoTheme()} options={{ readOnly: true, renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true }} /> : <div className="stash-placeholder"><span>{file ? "Loading change…" : "Select a file to see its change."}</span></div>}</div>
            </div>
          </>}
        </main>
      </div>
      {notice && <footer className={`stash-notice ${notice.error ? "error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.error ? <CircleAlert size={14} /> : <CircleCheck size={14} />}<span>{notice.text}</span><button type="button" aria-label="Dismiss" onClick={() => setNotice(undefined)}><X size={13} /></button></footer>}
    </section>
  </div>;
}

function languageFor(filePath: string): string { return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", java: "java", json: "json", css: "css", html: "html", md: "markdown", py: "python" } as Record<string, string>)[filePath.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"; }
