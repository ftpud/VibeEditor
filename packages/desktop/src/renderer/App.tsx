import Editor from "@monaco-editor/react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, LogOut, RefreshCw, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileTreeNode } from "@remote-ide/protocol";
import { CoreClient } from "./client";
import { initialLayout, type EditorTab, type LayoutModel } from "./model";

type ConnectionStatus = "idle" | "connecting" | "connected" | "failed" | "disconnected" | "workspace-error";
const languageByExtension: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", html: "html",
  css: "css", md: "markdown", java: "java", py: "python", yaml: "yaml", yml: "yaml", txt: "plaintext"
};

export function App() {
  const saved = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("connection") ?? "{}") as Partial<{ host: string; port: string }>; } catch { return {}; }
  }, []);
  const launchConfig = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return { host: params.get("host") ?? undefined, port: params.get("port") ?? undefined };
  }, []);
  const [host, setHost] = useState(launchConfig.host ?? saved.host ?? "127.0.0.1");
  const [port, setPort] = useState(launchConfig.port ?? saved.port ?? "7331");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [layout, setLayout] = useState<LayoutModel>(initialLayout);
  const [explorerWidth, setExplorerWidth] = useState(260);
  const clientRef = useRef<CoreClient>();
  const didAutoConnect = useRef(false);
  const group = layout.editorGroups[0]!;
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId);
  const hasDirtyTabs = group.tabs.some((tab) => tab.dirty);

  useEffect(() => { window.desktop?.setDirtyState(hasDirtyTabs); }, [hasDirtyTabs]);
  useEffect(() => () => clientRef.current?.disconnect(), []);

  const updateGroup = useCallback((update: (tabs: EditorTab[], active?: string) => { tabs: EditorTab[]; activeTabId?: string }) => {
    setLayout((current) => ({ ...current, editorGroups: current.editorGroups.map((item, index) => index === 0 ? { ...item, ...update(item.tabs, item.activeTabId) } : item) }));
  }, []);

  const connect = async () => {
    setStatus("connecting"); setStatusMessage("Connecting...");
    const client = new CoreClient();
    client.onDisconnected = (message) => { setStatus("disconnected"); setStatusMessage(message); };
    try {
      await client.connect(host.trim(), Number(port));
      try {
        const result = await client.request("workspace.open", {});
        clientRef.current = client;
        setTree(result.tree); setStatus("connected"); setStatusMessage("");
        localStorage.setItem("connection", JSON.stringify({ host, port }));
      } catch (error) {
        client.disconnect(); setStatus("workspace-error"); setStatusMessage(error instanceof Error ? error.message : "Workspace could not be opened");
      }
    } catch (error) {
      setStatus("failed"); setStatusMessage(error instanceof Error ? error.message : "Connection failed");
    }
  };

  useEffect(() => {
    if (didAutoConnect.current || !launchConfig.host || !launchConfig.port) return;
    didAutoConnect.current = true;
    void connect();
  }, [launchConfig.host, launchConfig.port]);

  const disconnect = () => {
    if (hasDirtyTabs && !window.confirm("Disconnect and discard unsaved changes?")) return;
    clientRef.current?.disconnect(); clientRef.current = undefined;
    setLayout(initialLayout); setTree([]); setStatus("idle"); setStatusMessage("");
  };

  const openFile = async (node: FileTreeNode) => {
    const existing = group.tabs.find((tab) => tab.path === node.path);
    if (existing) { updateGroup((tabs) => ({ tabs, activeTabId: existing.id })); return; }
    const tab: EditorTab = { id: crypto.randomUUID(), type: "file", title: node.name, path: node.path, dirty: false, content: "", savedContent: "", loading: true };
    updateGroup((tabs) => ({ tabs: [...tabs, tab], activeTabId: tab.id }));
    try {
      const result = await clientRef.current!.request("filesystem.readFile", { path: node.path });
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, content: result.content, savedContent: result.content, loading: false } : item), activeTabId: active }));
    } catch (error) {
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, loading: false, error: error instanceof Error ? error.message : "Read failed" } : item), activeTabId: active }));
    }
  };

  const closeTab = (tab: EditorTab) => {
    if (tab.dirty && !window.confirm(`Discard unsaved changes in ${tab.title}?`)) return;
    updateGroup((tabs, active) => {
      const index = tabs.findIndex((item) => item.id === tab.id);
      const next = tabs.filter((item) => item.id !== tab.id);
      const activeTabId = active === tab.id ? next[Math.min(index, next.length - 1)]?.id : active;
      return { tabs: next, activeTabId };
    });
  };

  const saveActive = useCallback(async () => {
    const current = layout.editorGroups[0]?.tabs.find((tab) => tab.id === layout.editorGroups[0]?.activeTabId);
    if (!current || current.loading || current.error || !current.dirty) return;
    try {
      await clientRef.current!.request("filesystem.writeFile", { path: current.path, content: current.content });
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === current.id ? { ...tab, dirty: false, savedContent: tab.content, error: undefined } : tab), activeTabId: active }));
    } catch (error) {
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === current.id ? { ...tab, error: error instanceof Error ? error.message : "Save failed" } : tab), activeTabId: active }));
    }
  }, [layout, updateGroup]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveActive(); } };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [saveActive]);

  const refreshTree = async () => {
    try { setTree((await clientRef.current!.request("filesystem.listTree", {})).tree); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Refresh failed"); }
  };

  const beginResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setExplorerWidth(Math.max(180, Math.min(500, moveEvent.clientX)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  if (status !== "connected") return <ConnectionScreen {...{ host, port, status, statusMessage, setHost, setPort, connect }} />;

  return <div className="ide-shell">
    <aside className="explorer" style={{ width: explorerWidth }}>
      <header className="panel-header"><span>EXPLORER</span><button title="Refresh tree" onClick={() => void refreshTree()}><RefreshCw size={15} /></button></header>
      <div className="workspace-name">REMOTE WORKSPACE</div>
      <div className="tree"><Tree nodes={tree} activePath={activeTab?.path} onOpen={openFile} /></div>
    </aside>
    <div className="resize-handle" onPointerDown={beginResize} />
    <main className="workbench">
      <div className="titlebar-actions"><span className="connection-dot" />{host}:{port}<button title="Disconnect" onClick={disconnect}><LogOut size={15} /></button></div>
      <div className="tabs" role="tablist">
        {group.tabs.map((tab) => <button className={`tab ${tab.id === group.activeTabId ? "active" : ""}`} key={tab.id} onClick={() => updateGroup((tabs) => ({ tabs, activeTabId: tab.id }))}>
          <File size={14} /><span>{tab.title}</span>{tab.dirty && <span className="dirty" title="Unsaved changes" />}<span className="close" title={`Close ${tab.title}`} onClick={(event) => { event.stopPropagation(); closeTab(tab); }}><X size={13} /></span>
        </button>)}
        <div className="tab-spacer" /><button className="save-button" title="Save active file" disabled={!activeTab?.dirty} onClick={() => void saveActive()}><Save size={15} /></button>
      </div>
      <div className="editor-area">
        {!activeTab ? <div className="empty-editor">Open a file from Explorer</div> : activeTab.loading ? <div className="empty-editor">Loading {activeTab.title}...</div> : activeTab.error && !activeTab.content ? <div className="editor-error">{activeTab.error}</div> : <>
          {activeTab.error && <div className="inline-error">{activeTab.error}</div>}
          <Editor path={activeTab.path} language={languageByExtension[activeTab.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} value={activeTab.content} theme="vs-dark" options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, padding: { top: 10 } }} onChange={(value) => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, content: value ?? "", dirty: (value ?? "") !== tab.savedContent, error: undefined } : tab), activeTabId: active }))} />
        </>}
      </div>
    </main>
  </div>;
}

function ConnectionScreen(props: { host: string; port: string; status: ConnectionStatus; statusMessage: string; setHost(value: string): void; setPort(value: string): void; connect(): Promise<void> }) {
  const connecting = props.status === "connecting";
  return <main className="connection-screen"><form className="connection-form" onSubmit={(event) => { event.preventDefault(); void props.connect(); }}>
    <h1>Remote IDE</h1><p>Connect to a core backend</p>
    <label>Host<input autoFocus value={props.host} onChange={(event) => props.setHost(event.target.value)} placeholder="192.168.1.50" required /></label>
    <label>Port<input value={props.port} onChange={(event) => props.setPort(event.target.value)} type="number" min="1" max="65535" required /></label>
    {props.statusMessage && <div className={`connection-message ${props.status}`}>{props.statusMessage}</div>}
    <button className="primary" disabled={connecting}>{connecting ? "Connecting..." : "Connect"}</button>
  </form></main>;
}

function Tree({ nodes, activePath, onOpen }: { nodes: FileTreeNode[]; activePath?: string; onOpen(node: FileTreeNode): void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return <>{nodes.map((node) => node.type === "directory" ? <div key={node.path}>
    <button className="tree-row" onClick={() => setExpanded((current) => { const next = new Set(current); next.has(node.path) ? next.delete(node.path) : next.add(node.path); return next; })}>
      {expanded.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{expanded.has(node.path) ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{node.name}</span>
    </button>{expanded.has(node.path) && <div className="tree-children"><Tree nodes={node.children ?? []} activePath={activePath} onOpen={onOpen} /></div>}
  </div> : <button key={node.path} className={`tree-row file-row ${activePath === node.path ? "selected" : ""}`} onClick={() => void onOpen(node)}><span className="tree-indent" /><File size={14} /><span>{node.name}</span></button>)}</>;
}
