import Editor from "@monaco-editor/react";
import { Braces, ChevronDown, ChevronRight, Coffee, File, FileCode2, FileJson, FileText, Folder, FolderOpen, GitBranch, Hash, LogOut, RefreshCw, Save, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileTreeNode, GitStatusEntry } from "@remote-ide/protocol";
import { CoreClient } from "./client";
import { initialLayout, type EditorTab, type LayoutModel } from "./model";
import { TerminalPanel } from "./TerminalPanel";

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
  const [terminalHeight, setTerminalHeight] = useState(240);
  const [sideView, setSideView] = useState<"project" | "git">("project");
  const [gitBranch, setGitBranch] = useState("HEAD");
  const [gitEntries, setGitEntries] = useState<GitStatusEntry[]>([]);
  const [gitError, setGitError] = useState("");
  const clientRef = useRef<CoreClient>();
  const didAutoConnect = useRef(false);
  const layoutRef = useRef(layout);
  const treeRefreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const gitRefreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const selfWriteUntil = useRef(new Map<string, number>());
  const terminalWriters = useRef(new Map<string, (data: string) => void>());
  const terminalBuffers = useRef(new Map<string, string>());
  const group = layout.editorGroups[0]!;
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId);
  const hasDirtyTabs = group.tabs.some((tab) => tab.dirty);

  useEffect(() => { window.desktop?.setDirtyState(hasDirtyTabs); }, [hasDirtyTabs]);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => () => {
    clientRef.current?.disconnect();
    if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current);
    if (gitRefreshTimer.current) clearTimeout(gitRefreshTimer.current);
  }, []);

  const updateGroup = useCallback((update: (tabs: EditorTab[], active?: string) => { tabs: EditorTab[]; activeTabId?: string }) => {
    setLayout((current) => ({ ...current, editorGroups: current.editorGroups.map((item, index) => index === 0 ? { ...item, ...update(item.tabs, item.activeTabId) } : item) }));
  }, []);

  const updateTerminalGroup = useCallback((update: (group: LayoutModel["terminalGroup"]) => LayoutModel["terminalGroup"]) => {
    setLayout((current) => ({ ...current, terminalGroup: update(current.terminalGroup) }));
  }, []);

  const registerTerminalWriter = useCallback((terminalId: string, writer?: (data: string) => void) => {
    if (!writer) { terminalWriters.current.delete(terminalId); return; }
    terminalWriters.current.set(terminalId, writer);
    const buffered = terminalBuffers.current.get(terminalId);
    if (buffered) { writer(buffered); terminalBuffers.current.delete(terminalId); }
  }, []);

  const refreshGit = useCallback(async (client = clientRef.current) => {
    if (!client) return;
    try {
      const result = await client.request("git.status", {});
      setGitBranch(result.branch); setGitEntries(result.entries); setGitError("");
    } catch (error) {
      setGitEntries([]); setGitError(error instanceof Error ? error.message : "Could not read Git status");
    }
  }, []);

  const connect = async () => {
    setStatus("connecting"); setStatusMessage("Connecting...");
    const client = new CoreClient();
    client.onDisconnected = (message) => { setStatus("disconnected"); setStatusMessage(message); };
    client.onServerEvent = (event) => {
      if (event.type === "terminal.output") {
        const writer = terminalWriters.current.get(event.payload.terminalId);
        if (writer) writer(event.payload.data);
        else terminalBuffers.current.set(event.payload.terminalId, (terminalBuffers.current.get(event.payload.terminalId) ?? "") + event.payload.data);
        return;
      }
      if (event.type === "terminal.exit") {
        const writer = terminalWriters.current.get(event.payload.terminalId);
        writer?.(`\r\n[process exited with code ${event.payload.exitCode}]\r\n`);
        updateTerminalGroup((current) => ({ ...current, tabs: current.tabs.map((tab) => tab.terminalId === event.payload.terminalId ? { ...tab, exited: true } : tab) }));
        return;
      }
      if (gitRefreshTimer.current) clearTimeout(gitRefreshTimer.current);
      gitRefreshTimer.current = setTimeout(() => { void refreshGit(client); }, 200);
      if (event.type === "git.changed") return;
      if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current);
      treeRefreshTimer.current = setTimeout(() => {
        void client.request("filesystem.listTree", {})
          .then((result) => setTree(result.tree))
          .catch((error: unknown) => setStatusMessage(error instanceof Error ? error.message : "Automatic refresh failed"));
      }, 150);

      const { path, kind } = event.payload;
      const openTab = layoutRef.current.editorGroups[0]?.tabs.find((tab) => tab.path === path);
      if (!openTab) return;
      if (kind === "unlink") {
        updateGroup((tabs, active) => ({
          tabs: tabs.map((tab) => tab.path === path ? { ...tab, error: "File was deleted outside the editor" } : tab),
          activeTabId: active
        }));
        return;
      }
      if (kind !== "change" || (selfWriteUntil.current.get(path) ?? 0) > Date.now()) return;
      if (openTab.dirty) {
        updateGroup((tabs, active) => ({
          tabs: tabs.map((tab) => tab.path === path ? { ...tab, error: "File changed outside the editor; your unsaved changes were preserved" } : tab),
          activeTabId: active
        }));
        return;
      }
      void client.request("filesystem.readFile", { path }).then((result) => {
        updateGroup((tabs, active) => ({
          tabs: tabs.map((tab) => tab.path !== path || tab.dirty ? tab : { ...tab, content: result.content, savedContent: result.content, error: undefined }),
          activeTabId: active
        }));
      }).catch((error: unknown) => {
        updateGroup((tabs, active) => ({
          tabs: tabs.map((tab) => tab.path === path ? { ...tab, error: error instanceof Error ? error.message : "Automatic reload failed" } : tab),
          activeTabId: active
        }));
      });
    };
    try {
      await client.connect(host.trim(), Number(port));
      try {
        const result = await client.request("workspace.open", {});
        clientRef.current = client;
        setTree(result.tree); setStatus("connected"); setStatusMessage("");
        void refreshGit(client);
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
      selfWriteUntil.current.set(current.path, Date.now() + 1500);
      await clientRef.current!.request("filesystem.writeFile", { path: current.path, content: current.content });
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === current.id ? { ...tab, dirty: false, savedContent: tab.content, error: undefined } : tab), activeTabId: active }));
    } catch (error) {
      selfWriteUntil.current.delete(current.path);
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
    const move = (moveEvent: PointerEvent) => setExplorerWidth(Math.max(180, Math.min(500, moveEvent.clientX - 30)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const createTerminal = async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const result = await client.request("terminal.create", { cols: 80, rows: 24 });
      updateTerminalGroup((current) => {
        const id = crypto.randomUUID();
        const tab = { id, terminalId: result.terminalId, title: `Terminal ${current.tabs.length + 1}`, exited: false };
        return { ...current, tabs: [...current.tabs, tab], activeTabId: id };
      });
      setLayout((current) => current.panels.some((panel) => panel.type === "terminal") ? current : { ...current, panels: [...current.panels, { id: "terminal", type: "terminal" }] });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not create terminal");
    }
  };

  const toggleTerminalPanel = () => {
    const visible = layout.panels.some((panel) => panel.type === "terminal");
    if (visible) {
      setLayout((current) => ({ ...current, panels: current.panels.filter((panel) => panel.type !== "terminal") }));
    } else if (layout.terminalGroup.tabs.length > 0) {
      setLayout((current) => ({ ...current, panels: [...current.panels, { id: "terminal", type: "terminal" }] }));
    } else {
      void createTerminal();
    }
  };

  const closeTerminal = (tab: LayoutModel["terminalGroup"]["tabs"][number]) => {
    if (!tab.exited) void clientRef.current?.request("terminal.close", { terminalId: tab.terminalId }).catch(() => undefined);
    terminalBuffers.current.delete(tab.terminalId);
    setLayout((current) => {
      const index = current.terminalGroup.tabs.findIndex((item) => item.id === tab.id);
      const tabs = current.terminalGroup.tabs.filter((item) => item.id !== tab.id);
      const activeTabId = current.terminalGroup.activeTabId === tab.id ? tabs[Math.min(index, tabs.length - 1)]?.id : current.terminalGroup.activeTabId;
      return {
        ...current,
        panels: tabs.length ? current.panels : current.panels.filter((panel) => panel.type !== "terminal"),
        terminalGroup: { ...current.terminalGroup, tabs, activeTabId }
      };
    });
  };

  const beginTerminalResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = terminalHeight;
    const move = (moveEvent: PointerEvent) => setTerminalHeight(Math.max(130, Math.min(520, startHeight + startY - moveEvent.clientY)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  if (status !== "connected") return <ConnectionScreen {...{ host, port, status, statusMessage, setHost, setPort, connect }} />;

  return <div className="ide-shell">
    <div className="workspace-row">
      <nav className="tool-stripe" aria-label="Tool windows">
        <button className={`tool-stripe-button ${sideView === "project" ? "active" : ""}`} title="Project" onClick={() => setSideView("project")}><Folder size={15} /><span>Project</span></button>
        <button className={`tool-stripe-button ${sideView === "git" ? "active" : ""}`} title="Git changes" onClick={() => { setSideView("git"); void refreshGit(); }}><GitBranch size={15} /><span>Git</span>{gitEntries.length > 0 && <span className="tool-badge">{gitEntries.length > 99 ? "99+" : gitEntries.length}</span>}</button>
      </nav>
      <aside className="explorer" style={{ width: explorerWidth }}>
        {sideView === "project" ? <>
          <header className="panel-header"><span>Project</span><button title="Synchronize files" onClick={() => void refreshTree()}><RefreshCw size={14} /></button></header>
          <div className="workspace-name"><ChevronDown size={13} />REMOTE WORKSPACE</div>
          <div className="tree"><Tree nodes={tree} activePath={activeTab?.path} onOpen={openFile} /></div>
        </> : <>
          <header className="panel-header"><span>Git Changes</span><button title="Refresh Git status" onClick={() => void refreshGit()}><RefreshCw size={14} /></button></header>
          <div className="git-branch"><GitBranch size={13} /><span>{gitBranch}</span></div>
          <GitChangesView entries={gitEntries} error={gitError} activePath={activeTab?.path} onOpen={openFile} />
        </>}
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
          {!activeTab ? <div className="empty-editor">Open a file from Project</div> : activeTab.loading ? <div className="empty-editor">Loading {activeTab.title}...</div> : activeTab.error && !activeTab.content ? <div className="editor-error">{activeTab.error}</div> : <>
            {activeTab.error && <div className="inline-error">{activeTab.error}</div>}
            <Editor path={activeTab.path} language={languageByExtension[activeTab.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} value={activeTab.content} theme="vs-dark" options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, padding: { top: 10 } }} onChange={(value) => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, content: value ?? "", dirty: (value ?? "") !== tab.savedContent, error: undefined } : tab), activeTabId: active }))} />
          </>}
        </div>
      </main>
    </div>
    {layout.panels.some((panel) => panel.type === "terminal") && <TerminalPanel client={clientRef.current!} group={layout.terminalGroup} height={terminalHeight} onActivate={(id) => updateTerminalGroup((current) => ({ ...current, activeTabId: id }))} onCreate={() => void createTerminal()} onClose={closeTerminal} onResizeStart={beginTerminalResize} registerWriter={registerTerminalWriter} />}
    <footer className="bottom-tool-bar">
      <button className={`bottom-tool-button ${layout.panels.some((panel) => panel.type === "terminal") ? "active" : ""}`} onClick={toggleTerminalPanel}><SquareTerminal size={14} /><span>Terminal</span>{layout.terminalGroup.tabs.length > 0 && <span className="bottom-tool-count">{layout.terminalGroup.tabs.length}</span>}</button>
    </footer>
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
  </div> : <FileTreeRow key={node.path} node={node} selected={activePath === node.path} onOpen={onOpen} />)}</>;
}

function GitChangesView({ entries, error, activePath, onOpen }: { entries: GitStatusEntry[]; error: string; activePath?: string; onOpen(node: FileTreeNode): void }) {
  if (error) return <div className="git-empty error">{error}</div>;
  if (entries.length === 0) return <div className="git-empty">No local changes</div>;
  const groups = [
    { title: "Conflicts", entries: entries.filter((entry) => entry.indexStatus === "U" || entry.worktreeStatus === "U" || ["AA", "DD"].includes(entry.indexStatus + entry.worktreeStatus)) },
    { title: "Untracked", entries: entries.filter((entry) => entry.indexStatus === "?" && entry.worktreeStatus === "?") },
    { title: "Staged", entries: entries.filter((entry) => entry.indexStatus !== " " && entry.indexStatus !== "?" && entry.indexStatus !== "U" && !["AA", "DD"].includes(entry.indexStatus + entry.worktreeStatus)) },
    { title: "Changes", entries: entries.filter((entry) => entry.indexStatus === " " && entry.worktreeStatus !== " " && entry.worktreeStatus !== "?" && entry.worktreeStatus !== "U") }
  ].filter((group) => group.entries.length > 0);
  return <div className="git-changes">{groups.map((group) => <GitChangeGroup key={group.title} title={group.title} entries={group.entries} activePath={activePath} onOpen={onOpen} />)}</div>;
}

function GitChangeGroup({ title, entries, activePath, onOpen }: { title: string; entries: GitStatusEntry[]; activePath?: string; onOpen(node: FileTreeNode): void }) {
  const [expanded, setExpanded] = useState(true);
  return <section className={`git-group git-group-${title.toLowerCase()}`}>
    <button className="git-group-title" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{title}</span><span className="git-count">{entries.length}</span>
    </button>
    {expanded && <GitStatusTree entries={entries} activePath={activePath} onOpen={onOpen} />}
  </section>;
}

type GitTreeNode =
  | { type: "directory"; name: string; path: string; children: GitTreeNode[] }
  | { type: "file"; name: string; path: string; entry: GitStatusEntry };

function GitStatusTree({ entries, activePath, onOpen }: { entries: GitStatusEntry[]; activePath?: string; onOpen(node: FileTreeNode): void }) {
  const nodes = useMemo(() => buildGitTree(entries), [entries]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(collectGitDirectories(nodes)));
  useEffect(() => setExpanded((current) => new Set([...current, ...collectGitDirectories(nodes)])), [nodes]);

  const renderNodes = (items: GitTreeNode[], depth: number): ReactNode => items.map((node) => {
    if (node.type === "directory") {
      const open = expanded.has(node.path);
      return <div key={node.path}>
        <button className="git-file-row git-directory-row" style={{ paddingLeft: 9 + depth * 13 }} onClick={() => setExpanded((current) => { const next = new Set(current); open ? next.delete(node.path) : next.add(node.path); return next; })}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span className="git-file-name">{node.name}</span>
        </button>
        {open && renderNodes(node.children, depth + 1)}
      </div>;
    }
    const entry = node.entry;
    const deleted = entry.indexStatus === "D" || entry.worktreeStatus === "D";
    const status = entry.indexStatus === "?" ? "U" : `${entry.indexStatus}${entry.worktreeStatus}`.trim();
    const kind = entry.indexStatus === "U" || entry.worktreeStatus === "U" ? "conflict" : entry.indexStatus === "?" ? "untracked" : deleted ? "deleted" : entry.indexStatus === "A" ? "added" : "modified";
    return <button key={node.path} disabled={deleted} className={`git-file-row ${activePath === entry.path ? "selected" : ""}`} style={{ paddingLeft: 27 + depth * 13 }} title={entry.originalPath ? `${entry.originalPath} -> ${entry.path}` : entry.path} onClick={() => onOpen({ name: node.name, path: entry.path, type: "file" })}>
      <FileCode2 size={14} /><span className="git-file-name">{node.name}</span><span className={`git-status ${kind}`}>{status}</span>
    </button>;
  });
  return <>{renderNodes(nodes, 0)}</>;
}

function buildGitTree(entries: GitStatusEntry[]): GitTreeNode[] {
  const root: GitTreeNode[] = [];
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let children = root;
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      if (index === parts.length - 1) {
        children.push({ type: "file", name, path: currentPath, entry });
      } else {
        let directory = children.find((node): node is Extract<GitTreeNode, { type: "directory" }> => node.type === "directory" && node.name === name);
        if (!directory) {
          directory = { type: "directory", name, path: currentPath, children: [] };
          children.push(directory);
        }
        children = directory.children;
      }
    }
  }
  const sort = (nodes: GitTreeNode[]) => {
    nodes.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
    for (const node of nodes) if (node.type === "directory") sort(node.children);
  };
  sort(root);
  return root;
}

function collectGitDirectories(nodes: GitTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "directory" ? [node.path, ...collectGitDirectories(node.children)] : []);
}

function FileTreeRow({ node, selected, onOpen }: { node: FileTreeNode; selected: boolean; onOpen(node: FileTreeNode): void }) {
  const extension = node.name.split(".").pop()?.toLowerCase() ?? "";
  const appearance: Record<string, { color: string; Icon: typeof File }> = {
    ts: { color: "#5e9fd6", Icon: FileCode2 }, tsx: { color: "#5e9fd6", Icon: FileCode2 },
    js: { color: "#d9c65c", Icon: FileCode2 }, jsx: { color: "#d9c65c", Icon: FileCode2 },
    json: { color: "#c9b45d", Icon: FileJson }, html: { color: "#e8845b", Icon: FileCode2 },
    css: { color: "#8d7bd8", Icon: Hash }, md: { color: "#78a7cf", Icon: FileText },
    java: { color: "#d58b59", Icon: Coffee }, py: { color: "#63a86f", Icon: FileCode2 },
    yaml: { color: "#ca6b75", Icon: Braces }, yml: { color: "#ca6b75", Icon: Braces }
  };
  const { color, Icon } = appearance[extension] ?? { color: "#9aa0a8", Icon: File };
  return <button className={`tree-row file-row ${selected ? "selected" : ""}`} onClick={() => void onOpen(node)}>
    <span className="tree-indent" /><Icon className="file-kind-icon" color={color} size={14} /><span>{node.name}</span>
  </button>;
}
