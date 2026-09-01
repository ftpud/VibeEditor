import Editor from "@monaco-editor/react";
import { ArrowUpRight, Bookmark, CaseSensitive, ChevronDown, ChevronRight, FileCode2, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchReplacePreview, SearchResult, WorkspaceSearchQueries, WorkspaceSearchQuery } from "@remote-ide/protocol";
import type { editor } from "monaco-editor";
import type { CoreClient } from "./client";
import { configureMonacoThemes, monacoTheme } from "./theme";

const languageByExtension: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", html: "html",
  css: "css", md: "markdown", java: "java", py: "python", yaml: "yaml", yml: "yaml", mta: "yaml", mtaext: "yaml",
  xml: "xml", cds: "sap-cds", http: "http", txt: "plaintext"
};

function resultParts(path: string): { filename: string; directory: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? { filename: path, directory: "" } : { filename: path.slice(separator + 1) || path, directory: path.slice(0, separator) };
}

function highlightMatch(preview: string, query: string, matchCase: boolean) {
  if (!query) return preview || " ";
  const index = (matchCase ? preview : preview.toLocaleLowerCase()).indexOf(matchCase ? query : query.toLocaleLowerCase());
  if (index < 0) return preview || " ";
  return <>{preview.slice(0, index)}<mark>{preview.slice(index, index + query.length)}</mark>{preview.slice(index + query.length)}</>;
}

function contextLine(line: { line: number; text: string; truncated: boolean }) {
  return <span className="find-context-line" key={line.line}><span>{line.line}</span><code title={line.text}>{line.text}{line.truncated && "…"}</code></span>;
}

const searchKey = (search: WorkspaceSearchQuery) => `${search.query}\0${search.path}\0${search.matchCase ? "1" : "0"}\0${search.include ?? ""}\0${search.exclude ?? ""}`;
const sameSearch = (left: WorkspaceSearchQuery, right: WorkspaceSearchQuery) => searchKey(left) === searchKey(right);

export function FindInFilesDialog({ client, rootAlias = "workspace", rootIds, rootAliases = {}, scope, queries = {}, onQueriesChange, onClose, onNavigate }: { client: CoreClient; rootAlias?: string; rootIds?: string[]; rootAliases?: Record<string, string>; scope: string; queries?: WorkspaceSearchQueries; onQueriesChange?(queries: WorkspaceSearchQueries): void; onClose(): void; onNavigate(result: SearchResult, matchLength: number): void }) {
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replacePreview, setReplacePreview] = useState<SearchReplacePreview>();
  const [replaceStatus, setReplaceStatus] = useState("");
  const [searchPath, setSearchPath] = useState(scope);
  const [matches, setMatches] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult>();
  const [previewContent, setPreviewContent] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const previewEditorRef = useRef<editor.IStandaloneCodeEditor>();
  const searchVersion = useRef(0);
  const groups = useMemo(() => {
    const byPath = new Map<string, SearchResult[]>();
    for (const match of matches) { const key = `${match.rootId}\0${match.path}`; byPath.set(key, [...(byPath.get(key) ?? []), match]); }
    return [...byPath.entries()];
  }, [matches]);
  const currentSearch = (): WorkspaceSearchQuery | undefined => query.trim() ? { query: query.trim(), path: searchPath, ...(matchCase ? { matchCase: true } : {}), ...(include.trim() ? { include: include.trim() } : {}), ...(exclude.trim() ? { exclude: exclude.trim() } : {}) } : undefined;
  const reuse = (saved: WorkspaceSearchQuery) => { setQuery(saved.query); setMatchCase(Boolean(saved.matchCase)); setSearchPath(saved.path); setInclude(saved.include ?? ""); setExclude(saved.exclude ?? ""); };
  const addRecent = (saved: WorkspaceSearchQuery) => onQueriesChange?.({ ...queries, recent: [saved, ...(queries.recent ?? []).filter((item) => !sameSearch(item, saved))].slice(0, 10) });
  const saveCurrent = () => { const saved = currentSearch(); if (!saved) return; onQueriesChange?.({ ...queries, saved: [saved, ...(queries.saved ?? []).filter((item) => !sameSearch(item, saved))].slice(0, 20) }); };
  const remove = (kind: "recent" | "saved", saved: WorkspaceSearchQuery) => onQueriesChange?.({ ...queries, [kind]: (queries[kind] ?? []).filter((item) => !sameSearch(item, saved)) });
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => setSearchPath(scope), [scope]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [onClose]);

  useEffect(() => {
    const version = ++searchVersion.current;
    if (!query.trim()) { setMatches([]); setSelected(undefined); setTruncated(false); setLoading(false); setError(""); return; }
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void (rootIds?.length ? client.request("filesystem.searchRoots", { rootIds, query, path: searchPath, matchCase, ...(include.trim() ? { include: include.trim() } : {}), ...(exclude.trim() ? { exclude: exclude.trim() } : {}) }) : client.request("filesystem.search", { query, path: searchPath, matchCase, ...(include.trim() ? { include: include.trim() } : {}), ...(exclude.trim() ? { exclude: exclude.trim() } : {}) })).then((result) => {
        if (version !== searchVersion.current) return;
        setMatches(result.matches); setSelected(result.matches[0]); setCollapsedPaths(new Set()); setTruncated(result.truncated); const saved = currentSearch(); if (saved) addRecent(saved);
      }).catch((searchError: unknown) => {
        if (version !== searchVersion.current) return;
        setMatches([]); setSelected(undefined); setTruncated(false); setError(searchError instanceof Error ? searchError.message : "Search failed");
      }).finally(() => { if (version === searchVersion.current) setLoading(false); });
    }, 600);
    return () => clearTimeout(timer);
  }, [client, exclude, include, matchCase, query, searchPath]);

  const createReplacePreview = () => {
    if (!query.trim()) return;
    setReplaceStatus("");
    void client.request("filesystem.replacePreview", { query, replacement, path: searchPath, matchCase, ...(include.trim() ? { include: include.trim() } : {}), ...(exclude.trim() ? { exclude: exclude.trim() } : {}) }).then((result) => setReplacePreview(result)).catch((replaceError: unknown) => setReplaceStatus(replaceError instanceof Error ? replaceError.message : "Could not create replacement preview"));
  };
  const applyReplace = () => {
    if (!replacePreview || !window.confirm(`Replace in ${replacePreview.files.length} file(s)? This writes all unchanged previewed files.`)) return;
    void client.request("filesystem.replaceApply", { previewId: replacePreview.id, confirmed: true }).then((result) => { setReplaceStatus(`${result.applied.length} file(s) replaced${result.failures.length ? `; ${result.failures.map((failure) => `${failure.path}: ${failure.message}`).join("; ")}` : ""}`); setReplacePreview(undefined); }).catch((replaceError: unknown) => setReplaceStatus(replaceError instanceof Error ? replaceError.message : "Replacement failed"));
  };

  useEffect(() => {
    if (!selected) { setPreviewContent(""); setPreviewError(""); return; }
    let current = true;
    setPreviewError("");
    void client.request("filesystem.readRootFile", { targetRootId: selected.rootId, path: selected.path }).then((result) => {
      if (current) setPreviewContent(result.content);
    }).catch((readError: unknown) => {
      if (current) { setPreviewContent(""); setPreviewError(readError instanceof Error ? readError.message : "Could not load preview"); }
    });
    return () => { current = false; };
  }, [client, selected]);

  useEffect(() => {
    if (!selected || !previewEditorRef.current) return;
    previewEditorRef.current.setSelection({ startLineNumber: selected.line, startColumn: selected.column, endLineNumber: selected.line, endColumn: selected.column + query.length });
    previewEditorRef.current.revealLineInCenter(selected.line);
  }, [previewContent, query.length, selected]);

  const selectedParts = selected ? resultParts(selected.path) : undefined;
  return <div className="dialog-overlay find-dialog-overlay" onMouseDown={onClose}>
    <section className="find-dialog" role="dialog" aria-modal="true" aria-label="Find in Files" onMouseDown={(event) => event.stopPropagation()}>
      <header><div className="find-dialog-heading"><h2>Find in Files <small className="root-badge">{rootAlias}</small></h2><span title={searchPath || rootAlias}>{searchPath || rootAlias}</span></div><button type="button" title="Close" aria-label="Close" onClick={onClose}><X size={15} /></button></header>
      <div className="find-controls">
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Text to find" aria-label="Text to find" maxLength={200} />
        <label className="match-case" title="Match case"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} /><CaseSensitive size={17} /></label>
        <span className="find-progress" role="status" aria-live="polite">{loading ? "Searching..." : query ? `${matches.length} matches` : ""}</span>
      </div>
      <div className="find-filter-controls">
        <input value={include} onChange={(event) => setInclude(event.target.value)} placeholder="Include globs (e.g. src/**/*.ts)" aria-label="Include globs" maxLength={200} />
        <input value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="Exclude globs (e.g. **/*.test.ts)" aria-label="Exclude globs" maxLength={200} />
        <input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="Replace with" aria-label="Replace with" maxLength={10000} />
        <button type="button" onClick={createReplacePreview} disabled={!query.trim()}>Preview replace</button>
      </div>
      <div className="find-query-library" aria-label="Search history and saved searches">
        <div><span>Recent</span>{queries.recent?.map((saved) => <span className="find-query" key={`recent:${searchKey(saved)}`}><button type="button" onClick={() => reuse(saved)}>{saved.query}</button><button type="button" aria-label={`Remove recent search ${saved.query}`} title="Remove" onClick={() => remove("recent", saved)}><Trash2 size={12} /></button></span>)}</div>
        <div><span>Saved</span><button type="button" aria-label="Save current search" title="Save current search" disabled={!query.trim()} onClick={saveCurrent}><Bookmark size={13} /></button>{queries.saved?.map((saved) => <span className="find-query" key={`saved:${searchKey(saved)}`}><button type="button" onClick={() => reuse(saved)}>{saved.query}</button><button type="button" aria-label={`Delete saved search ${saved.query}`} title="Delete" onClick={() => remove("saved", saved)}><Trash2 size={12} /></button></span>)}</div>
      </div>
      {error && <div className="find-error" role="alert">{error}</div>}
      {(replacePreview || replaceStatus) && <section className="find-replace-preview" aria-label="Replace preview">{replacePreview && <><span>{replacePreview.files.length} file(s) previewed{replacePreview.truncated ? "; limited result set" : ""}</span><button type="button" onClick={applyReplace}>Replace all previewed files</button>{replacePreview.files.map((file) => <details key={file.path}><summary>{file.path} ({file.occurrences.length})</summary>{file.occurrences.map((occurrence) => <div key={`${occurrence.line}:${occurrence.column}`}><code>{occurrence.line}:{occurrence.column} − {occurrence.before}</code><code>+ {occurrence.after}</code></div>)}</details>)}</>}{replaceStatus && <div role="status">{replaceStatus}</div>}</section>}
      <div className="find-split">
        <section className="find-results-pane" aria-label="Search results" aria-busy={loading}>
          <div className="find-pane-header"><Search size={13} /><span className="find-pane-title">Occurrences</span>{truncated && <span className="find-pane-meta">First 500</span>}</div>
          <div className="find-results">
            {!loading && !error && matches.length === 0 && query && <div className="find-empty">No matches</div>}
            {groups.map(([groupKey, group]) => {
              const path = group[0]!.path; const resultRootId = group[0]!.rootId;
              const { filename, directory } = resultParts(path);
              const collapsed = collapsedPaths.has(groupKey);
              return <section className="find-result-group" key={groupKey} aria-label={`${rootAliases[resultRootId] ?? resultRootId}: ${path}, ${group.length} match${group.length === 1 ? "" : "es"}`}>
                <button type="button" className="find-result-group-header" aria-expanded={!collapsed} onClick={() => setCollapsedPaths((paths) => { const next = new Set(paths); if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey); return next; })}>
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="find-result-file" title={filename}>{filename}</span>
                  <small className="root-badge">{rootAliases[resultRootId] ?? resultRootId}</small>
                  {directory && <span className="find-result-path" title={directory}>{directory}</span>}
                  <span className="find-group-count">{group.length}</span>
                </button>
                {!collapsed && group.map((match, index) => <button type="button" className={selected === match ? "selected" : ""} key={`${match.line}:${match.column}:${index}`} title={path} aria-label={`${path}, line ${match.line}, column ${match.column}`} onClick={() => setSelected(match)} onDoubleClick={() => onNavigate(match, query.length)}>
                  <span className="find-match-content">
                    {match.context?.truncatedBefore && <span className="find-context-omission" aria-label="Earlier lines omitted">…</span>}
                    {match.context?.before.map(contextLine)}
                    <span className="find-context-line find-context-match"><span>{match.line}</span><code title={match.preview}>{highlightMatch(match.preview, query, matchCase)}{match.previewTruncated && "…"}</code></span>
                    {match.context?.after.map(contextLine)}
                    {match.context?.truncatedAfter && <span className="find-context-omission" aria-label="Later lines omitted">…</span>}
                  </span>
                  <span className="find-location">{match.line}:{match.column}</span>
                </button>)}
              </section>;
            })}
          </div>
        </section>
        <section className="find-preview-pane" aria-label="Result preview">
          <div className="find-pane-header"><FileCode2 size={13} /><span className="find-pane-title">Preview</span>{selectedParts && <span className="find-preview-file" title={selected!.path}>{selectedParts.filename}</span>}{selected && <button type="button" title="Open in editor" aria-label="Open in editor" onClick={() => onNavigate(selected, query.length)}><ArrowUpRight size={14} /></button>}</div>
          <div className="find-preview-editor">
            {previewError ? <div className="find-empty" role="alert">{previewError}</div> : selected ? <Editor value={previewContent} language={languageByExtension[selected.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} beforeMount={configureMonacoThemes} theme={monacoTheme()} onMount={(instance) => { previewEditorRef.current = instance; }} options={{ readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3, scrollBeyondLastLine: false, padding: { top: 6 }, renderLineHighlight: "all" }} /> : <div className="find-empty">Select a result</div>}
          </div>
        </section>
      </div>
    </section>
  </div>;
}
