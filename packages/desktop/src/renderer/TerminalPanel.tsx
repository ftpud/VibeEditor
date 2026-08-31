import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { ClipboardPaste, Copy, Pencil, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CoreClient } from "./client";
import type { TerminalGroup, TerminalTab } from "./model";
import type { AppTheme } from "./theme";
import "@xterm/xterm/css/xterm.css";

type Props = {
  theme: AppTheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  client: CoreClient;
  group: TerminalGroup;
  height: number;
  onActivate(id: string): void;
  onCreate(): void;
  onClose(tab: TerminalTab): void;
  onRename(tab: TerminalTab, title: string): void;
  onDuplicate(tab: TerminalTab): void;
  onMove(tabId: string, targetTabId: string): void;
  onResizeStart(event: React.PointerEvent): void;
  registerWriter(terminalId: string, writer?: (data: string) => void): void;
  highlightedTerminalIds?: Set<string>;
};

export function TerminalPanel({ theme, fontFamily, fontSize, lineHeight, client, group, height, onActivate, onCreate, onClose, onRename, onDuplicate, onMove, onResizeStart, registerWriter, highlightedTerminalIds }: Props) {
  return <section className="terminal-panel" style={{ height }}>
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
    <div className="terminal-tabs" role="tablist">
      {group.tabs.map((tab) => <TerminalTabButton key={tab.id} tab={tab} active={tab.id === group.activeTabId} highlighted={highlightedTerminalIds?.has(tab.terminalId)} onActivate={onActivate} onClose={onClose} onRename={onRename} onDuplicate={onDuplicate} onMove={onMove} />)}
      <button className="terminal-action" title="New terminal" onClick={onCreate}><Plus size={15} /></button>
    </div>
    <div className="terminal-content">
      {group.tabs.filter((tab) => tab.id === group.activeTabId).map((tab) => <TerminalRecoveryNotice key={tab.id} tab={tab} />)}
      {group.tabs.map((tab) => <TerminalView key={tab.id} theme={theme} fontFamily={fontFamily} fontSize={fontSize} lineHeight={lineHeight} client={client} tab={tab} active={tab.id === group.activeTabId} registerWriter={registerWriter} />)}
    </div>
  </section>;
}

export function TerminalTabButton({ tab, active, highlighted, onActivate, onClose, onRename, onDuplicate, onMove }: { tab: TerminalTab; active: boolean; highlighted?: boolean; onActivate(id: string): void; onClose(tab: TerminalTab): void; onRename?(tab: TerminalTab, title: string): void; onDuplicate?(tab: TerminalTab): void; onMove?(tabId: string, targetTabId: string): void }) {
  const statusLabel = tab.status === "running" ? "running" : tab.status;
  const visibleStatus = tab.status === "running" ? "" : ` (${tab.status})`;
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);
  const beginRename = () => { setMenu(undefined); setDraft(tab.title); setRenaming(true); };
  const finishRename = () => {
    if (!renaming) return;
    setRenaming(false);
    const title = draft.trim();
    if (title && title !== tab.title) onRename?.(tab, title);
  };
  return <>{renaming ? <div className={`terminal-tab terminal-tab-renaming ${active ? "active" : ""}`}>
    <input ref={renameInputRef} aria-label={`Rename ${tab.title}`} value={draft} maxLength={100} onChange={(event) => setDraft(event.target.value)} onBlur={finishRename} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finishRename(); } else if (event.key === "Escape") { event.preventDefault(); setRenaming(false); } }} />
  </div> : <button
    className={`terminal-tab ${active ? "active" : ""} ${highlighted ? "run-config-running" : ""}`}
    role="tab"
    aria-selected={active}
    title={`${tab.title} — ${statusLabel}. Middle-click to close.`}
    onMouseDown={(event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onClose(tab);
    }}
    onClick={(event) => { if (event.button === 0) onActivate(tab.id); }}
    onDoubleClick={(event) => { if (event.button === 0 && onRename) { event.preventDefault(); beginRename(); } }}
    draggable
    onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.id); }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
    onDrop={(event) => { event.preventDefault(); const sourceId = event.dataTransfer.getData("text/plain"); if (sourceId && sourceId !== tab.id) onMove?.(sourceId, tab.id); }}
    onContextMenu={(event) => { event.preventDefault(); setMenu({ x: Math.min(event.clientX, window.innerWidth - 160), y: Math.min(event.clientY, window.innerHeight - 74) }); }}
  >
    <span>{tab.title}{visibleStatus}</span>
    <span className="close" title={`Close ${tab.title}`} onClick={(event) => { event.stopPropagation(); onClose(tab); }}><X size={13} /></span>
  </button>}
    {menu && <div className="terminal-context-menu terminal-tab-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
      <button onClick={beginRename}><Pencil size={14} /><span>Rename</span></button>
      <button onClick={() => { setMenu(undefined); onDuplicate?.(tab); }}><Copy size={14} /><span>Duplicate</span></button>
    </div>}
  </>;
}

export function TerminalRecoveryNotice({ tab }: { tab: TerminalTab }) {
  const [recoveryVisible, setRecoveryVisible] = useState(Boolean(tab.recovery));
  useEffect(() => {
    setRecoveryVisible(Boolean(tab.recovery));
    if (!tab.recovery) return;
    const timer = window.setTimeout(() => setRecoveryVisible(false), 6_000);
    return () => window.clearTimeout(timer);
  }, [tab.recovery, tab.terminalId]);
  if (recoveryVisible && tab.recovery === "reattached") return <div className="terminal-recovery-notice live" role="status">Live process reattached — this is the same Core-owned terminal process.</div>;
  if (recoveryVisible && tab.recovery === "recreated") return <div className="terminal-recovery-notice" role="status">New shell created because Core no longer has the previous terminal session. It starts in this task workspace; the former process, environment, and working directory were not restored.</div>;
  if (tab.status === "exited") return <div className="terminal-recovery-notice exited" role="status">This terminal process exited{tab.exitCode === undefined ? "" : ` with code ${tab.exitCode}`} and cannot accept input.</div>;
  if (tab.status === "unavailable") return <div className="terminal-recovery-notice exited" role="status">The previous terminal session is unavailable and no replacement shell was started.</div>;
  return null;
}

function TerminalView({ theme, fontFamily, fontSize, lineHeight, client, tab, active, registerWriter }: { theme: AppTheme; fontFamily: string; fontSize: number; lineHeight: number; client: CoreClient; tab: TerminalTab; active: boolean; registerWriter: Props["registerWriter"] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number }>();

  const paste = (text: string) => {
    const cleaned = text.replace(/[\u0000\uFEFF]/g, "").replace(/(?:\r\n|\r|\n)+$/, "");
    if (cleaned && tab.status === "running") void client.request("terminal.input", { terminalId: tab.terminalId, data: cleaned });
    terminalRef.current?.focus();
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily,
      fontSize,
      lineHeight,
      scrollback: 5000,
      theme: theme === "light" ? { background: "#ffffff", foreground: "#2b2d30", cursor: "#2b2d30", selectionBackground: "#b9d7ff" } : { background: "#1e1f22", foreground: "#d4d4d4", cursor: "#d4d4d4", selectionBackground: "#4d5157" }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((event, url) => { if (event.ctrlKey || event.metaKey) void window.desktop?.openExternal(url); }));
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || (!event.ctrlKey && !event.metaKey)) return true;
      if (event.key.toLowerCase() === "c" && terminal.hasSelection()) { event.preventDefault(); void window.desktop?.writeClipboard(terminal.getSelection()); return false; }
      if (event.key.toLowerCase() === "v") { event.preventDefault(); void window.desktop?.readClipboard().then(paste); return false; }
      return true;
    });
    const handlePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      paste(event.clipboardData?.getData("text/plain") ?? "");
    };
    container.addEventListener("paste", handlePaste, true);
    terminalRef.current = terminal;
    fitRef.current = fit;
    registerWriter(tab.terminalId, (data) => terminal.write(data));
    const input = terminal.onData((data) => { if (tab.status === "running") void client.request("terminal.input", { terminalId: tab.terminalId, data }); });
    const observer = new ResizeObserver(() => {
      if (!container.offsetParent) return;
      fit.fit();
      if (tab.status === "running" && terminal.cols > 0 && terminal.rows > 0) void client.request("terminal.resize", { terminalId: tab.terminalId, cols: terminal.cols, rows: terminal.rows });
    });
    observer.observe(container);
    requestAnimationFrame(() => { fit.fit(); terminal.focus(); });
    return () => {
      container.removeEventListener("paste", handlePaste, true);
      observer.disconnect(); input.dispose(); registerWriter(tab.terminalId); terminal.dispose();
    };
  }, [client, fontFamily, fontSize, lineHeight, registerWriter, tab.status, tab.terminalId, theme]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => { fitRef.current?.fit(); terminalRef.current?.focus(); });
  }, [active]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("blur", close); };
  }, [contextMenu]);

  return <><div ref={containerRef} className={`terminal-instance ${active ? "active" : ""}`} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 150), y: Math.min(event.clientY, window.innerHeight - 42) }); }} />
    {contextMenu && <div className="terminal-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
      <button onClick={() => { setContextMenu(undefined); void window.desktop?.readClipboard().then(paste); }}><ClipboardPaste size={14} /><span>Paste</span></button>
    </div>}
  </>;
}
