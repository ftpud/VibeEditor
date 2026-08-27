import Editor from "@monaco-editor/react";
import { ArrowUpRight, CaseSensitive, FileCode2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "@remote-ide/protocol";
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

export function FindInFilesDialog({ client, scope, onClose, onNavigate }: { client: CoreClient; scope: string; onClose(): void; onNavigate(result: SearchResult, matchLength: number): void }) {
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [matches, setMatches] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult>();
  const [previewContent, setPreviewContent] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const previewEditorRef = useRef<editor.IStandaloneCodeEditor>();
  const searchVersion = useRef(0);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [onClose]);

  useEffect(() => {
    const version = ++searchVersion.current;
    if (!query.trim()) { setMatches([]); setSelected(undefined); setTruncated(false); setLoading(false); setError(""); return; }
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void client.request("filesystem.search", { query, path: scope, matchCase }).then((result) => {
        if (version !== searchVersion.current) return;
        setMatches(result.matches); setSelected(result.matches[0]); setTruncated(result.truncated);
      }).catch((searchError: unknown) => {
        if (version !== searchVersion.current) return;
        setMatches([]); setSelected(undefined); setTruncated(false); setError(searchError instanceof Error ? searchError.message : "Search failed");
      }).finally(() => { if (version === searchVersion.current) setLoading(false); });
    }, 600);
    return () => clearTimeout(timer);
  }, [client, matchCase, query, scope]);

  useEffect(() => {
    if (!selected) { setPreviewContent(""); setPreviewError(""); return; }
    let current = true;
    setPreviewError("");
    void client.request("filesystem.readFile", { path: selected.path }).then((result) => {
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
      <header><div className="find-dialog-heading"><h2>Find in Files</h2><span title={scope || "Remote workspace"}>{scope || "Remote workspace"}</span></div><button type="button" title="Close" aria-label="Close" onClick={onClose}><X size={15} /></button></header>
      <div className="find-controls">
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Text to find" aria-label="Text to find" maxLength={200} />
        <label className="match-case" title="Match case"><input type="checkbox" aria-label="Match case" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} /><CaseSensitive size={17} /></label>
        <span className="find-progress" role="status" aria-live="polite">{loading ? "Searching..." : query ? `${matches.length} matches` : ""}</span>
      </div>
      {error && <div className="find-error" role="alert">{error}</div>}
      <div className="find-split">
        <section className="find-results-pane" aria-label="Search results" aria-busy={loading}>
          <div className="find-pane-header"><Search size={13} /><span className="find-pane-title">Occurrences</span>{truncated && <span className="find-pane-meta">First 500</span>}</div>
          <div className="find-results">
            {!loading && !error && matches.length === 0 && query && <div className="find-empty">No matches</div>}
            {matches.map((match, index) => {
              const { filename, directory } = resultParts(match.path);
              return <button type="button" className={selected === match ? "selected" : ""} key={`${match.path}:${match.line}:${index}`} title={match.path} aria-label={`${match.path}, line ${match.line}, column ${match.column}`} onClick={() => setSelected(match)} onDoubleClick={() => onNavigate(match, query.length)}>
                <code title={match.preview}>{match.preview || " "}</code>
                <span className="find-result-source">
                  <span className="find-result-file" title={filename}>{filename}</span>
                  {directory && <span className="find-result-path" title={directory}>{directory}</span>}
                </span>
                <span className="find-location">{match.line}:{match.column}</span>
              </button>;
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
