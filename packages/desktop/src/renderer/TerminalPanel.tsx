import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CoreClient } from "./client";
import type { TerminalGroup, TerminalTab } from "./model";
import "@xterm/xterm/css/xterm.css";

type Props = {
  client: CoreClient;
  group: TerminalGroup;
  height: number;
  onActivate(id: string): void;
  onCreate(): void;
  onClose(tab: TerminalTab): void;
  onResizeStart(event: React.PointerEvent): void;
  registerWriter(terminalId: string, writer?: (data: string) => void): void;
};

export function TerminalPanel({ client, group, height, onActivate, onCreate, onClose, onResizeStart, registerWriter }: Props) {
  return <section className="terminal-panel" style={{ height }}>
    <div className="terminal-resize-handle" onPointerDown={onResizeStart} />
    <div className="terminal-tabs" role="tablist">
      {group.tabs.map((tab) => <button key={tab.id} className={`terminal-tab ${tab.id === group.activeTabId ? "active" : ""}`} onClick={() => onActivate(tab.id)}>
        <span>{tab.title}{tab.exited ? " (exited)" : ""}</span>
        <span className="close" title={`Close ${tab.title}`} onClick={(event) => { event.stopPropagation(); onClose(tab); }}><X size={13} /></span>
      </button>)}
      <button className="terminal-action" title="New terminal" onClick={onCreate}><Plus size={15} /></button>
    </div>
    <div className="terminal-content">
      {group.tabs.map((tab) => <TerminalView key={tab.id} client={client} tab={tab} active={tab.id === group.activeTabId} registerWriter={registerWriter} />)}
    </div>
  </section>;
}

function TerminalView({ client, tab, active, registerWriter }: { client: CoreClient; tab: TerminalTab; active: boolean; registerWriter: Props["registerWriter"] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: { background: "#1e1f22", foreground: "#d4d4d4", cursor: "#d4d4d4", selectionBackground: "#4d5157" }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;
    registerWriter(tab.terminalId, (data) => terminal.write(data));
    const input = terminal.onData((data) => { void client.request("terminal.input", { terminalId: tab.terminalId, data }); });
    const observer = new ResizeObserver(() => {
      if (!container.offsetParent) return;
      fit.fit();
      if (terminal.cols > 0 && terminal.rows > 0) void client.request("terminal.resize", { terminalId: tab.terminalId, cols: terminal.cols, rows: terminal.rows });
    });
    observer.observe(container);
    requestAnimationFrame(() => { fit.fit(); terminal.focus(); });
    return () => {
      observer.disconnect(); input.dispose(); registerWriter(tab.terminalId); terminal.dispose();
    };
  }, [client, registerWriter, tab.terminalId]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => { fitRef.current?.fit(); terminalRef.current?.focus(); });
  }, [active]);

  return <div ref={containerRef} className={`terminal-instance ${active ? "active" : ""}`} />;
}
