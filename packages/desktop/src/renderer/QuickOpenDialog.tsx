import { File, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { FileTreeNode } from "@remote-ide/protocol";

export type QuickOpenFile = Pick<FileTreeNode, "name" | "path" | "type">;

export function workspaceFiles(nodes: FileTreeNode[]): QuickOpenFile[] {
  const files: QuickOpenFile[] = [];
  const visit = (items: FileTreeNode[]) => {
    for (const item of items) item.type === "file" ? files.push(item) : visit(item.children ?? []);
  };
  visit(nodes);
  return files;
}

function subsequenceScore(candidate: string, query: string): number | undefined {
  let score = 0; let queryIndex = 0; let previous = -2;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    score += index === previous + 1 ? 12 : 3;
    if (index === 0 || "/._- ".includes(candidate[index - 1]!)) score += 10;
    score -= Math.min(index - previous - 1, 8);
    previous = index; queryIndex += 1;
  }
  return queryIndex === query.length ? score - candidate.length * 0.08 : undefined;
}

export function rankQuickOpenFiles(files: QuickOpenFile[], rawQuery: string, limit = 100): QuickOpenFile[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return files.slice(0, limit);
  return files.flatMap((file) => {
    const path = file.path.toLocaleLowerCase(); const name = file.name.toLocaleLowerCase();
    const pathScore = subsequenceScore(path, query); const nameScore = subsequenceScore(name, query);
    if (pathScore === undefined) return [];
    let score = pathScore;
    if (nameScore !== undefined) score = Math.max(score, nameScore + 45);
    if (name === query) score += 1000;
    else if (name.startsWith(query)) score += 220;
    else if (path.startsWith(query)) score += 80;
    return [{ file, score }];
  }).sort((a, b) => b.score - a.score || a.file.path.length - b.file.path.length || a.file.path.localeCompare(b.file.path))
    .slice(0, limit).map(({ file }) => file);
}

function pathParts(path: string): { name: string; directory: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? { name: path, directory: "" } : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}

export function QuickOpenDialog({ files, onClose, onOpen }: { files: QuickOpenFile[]; onClose(): void; onOpen(file: QuickOpenFile): void }) {
  const [query, setQuery] = useState(""); const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null); const activeRef = useRef<HTMLButtonElement>(null); const activeIndexRef = useRef(0);
  const results = useMemo(() => rankQuickOpenFiles(files, query), [files, query]);
  const selectedIndex = results.length ? Math.min(activeIndex, results.length - 1) : 0;
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [selectedIndex]);
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = results.length ? (activeIndexRef.current + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0;
      activeIndexRef.current = next; setActiveIndex(next);
      return;
    }
    const active = results[Math.min(activeIndexRef.current, Math.max(0, results.length - 1))];
    if (event.key === "Enter" && active) { event.preventDefault(); onOpen(active); }
  };
  return <div className="dialog-overlay quick-open-overlay" onMouseDown={onClose}>
    <section className="quick-open-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-open-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
      <h2 id="quick-open-title" className="visually-hidden">Go to File</h2>
      <div className="quick-open-input"><Search size={16} aria-hidden="true" /><input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); activeIndexRef.current = 0; setActiveIndex(0); }} placeholder="Search files by name or path" aria-label="Search workspace files" role="combobox" aria-expanded="true" aria-controls="quick-open-results" aria-activedescendant={results.length ? `quick-open-result-${selectedIndex}` : undefined} autoComplete="off" spellCheck={false} /><kbd>Esc</kbd></div>
      <div id="quick-open-results" className="quick-open-results" role="listbox" aria-label="Workspace files">
        {files.length === 0 ? <div className="quick-open-empty" role="status">No files in this workspace</div> : results.length === 0 ? <div className="quick-open-empty" role="status">No files match “{query}”</div> : results.map((file, index) => {
          const parts = pathParts(file.path); const selected = index === selectedIndex;
          return <button ref={selected ? activeRef : undefined} id={`quick-open-result-${index}`} key={file.path} type="button" role="option" aria-selected={selected} className={selected ? "selected" : ""} onMouseMove={() => { activeIndexRef.current = index; setActiveIndex(index); }} onClick={() => onOpen(file)} title={file.path}><File size={15} aria-hidden="true" /><span className="quick-open-name">{parts.name}</span>{parts.directory && <span className="quick-open-path">{parts.directory}</span>}</button>;
        })}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span>{results.length} {results.length === 1 ? "file" : "files"}</span></footer>
    </section>
  </div>;
}
