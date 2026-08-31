import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { commandEnabled, rankCommands, type Command, type CommandContext } from "./command-registry";

export function CommandPalette({ commands, context, onClose }: { commands: Command[]; context: CommandContext; onClose(): void }) {
  const [query, setQuery] = useState(""); const [activeIndex, setActiveIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null); const active = useRef<HTMLButtonElement>(null);
  const results = useMemo(() => rankCommands(commands, query), [commands, query]);
  const selected = Math.min(activeIndex, Math.max(0, results.length - 1));
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { active.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const execute = (command: Command) => { if (!commandEnabled(command, context)) return; onClose(); void command.execute(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => results.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0); return; }
    if (event.key === "Enter" && results[selected]) { event.preventDefault(); execute(results[selected]!); }
  };
  return <div className="dialog-overlay quick-open-overlay" onMouseDown={onClose}><section className="quick-open-dialog command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
    <h2 id="command-palette-title" className="visually-hidden">Command Palette</h2>
    <div className="quick-open-input"><Search size={16} aria-hidden="true" /><input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} placeholder="Search commands" aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="command-palette-results" aria-activedescendant={results.length ? `command-${selected}` : undefined} autoComplete="off" spellCheck={false} /><kbd>Esc</kbd></div>
    <div id="command-palette-results" className="quick-open-results" role="listbox" aria-label="Commands">{results.length === 0 ? <div className="quick-open-empty" role="status">No commands match “{query}”</div> : results.map((command, index) => { const enabled = commandEnabled(command, context); return <button ref={index === selected ? active : undefined} id={`command-${index}`} key={command.id} type="button" role="option" aria-selected={index === selected} aria-disabled={!enabled} disabled={!enabled} className={index === selected ? "selected" : ""} onMouseMove={() => setActiveIndex(index)} onClick={() => execute(command)}><span className="command-category">{command.category}</span><span className="quick-open-name">{command.label}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}{!enabled && <span className="command-unavailable">Unavailable</span></button>; })}</div>
    <footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> run</span><span>{results.length} commands</span></footer>
  </section></div>;
}
