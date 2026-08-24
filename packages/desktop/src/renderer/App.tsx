import Editor, { DiffEditor, type Monaco } from "@monaco-editor/react";
import { ArrowUpRight, Braces, Bug, CaseSensitive, ChevronDown, ChevronRight, CircleAlert, Coffee, Columns2, Eye, File, FileCode2, FileDiff, FileJson, FileText, Folder, FolderOpen, GitBranch, GitCompareArrows, Hash, ListTree, LogOut, Package, Pencil, Play, RefreshCw, Save, Search, Square, SquareTerminal, X } from "lucide-react";
import { isValidElement, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { FileTreeNode, GitStatusEntry, JavaBreakpoint, JavaDebugState, JavaDiagnostic, JavaLspLocation, JavaMainClass, JavaProjectNode, JavaProjectOptions, JavaTypeSuggestion, SearchResult, WorkspaceOptions } from "@remote-ide/protocol";
import type { editor } from "monaco-editor";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CoreClient } from "./client";
import { initialLayout, type EditorTab, type LayoutModel } from "./model";
import { TerminalPanel } from "./TerminalPanel";
import { JavaPanel } from "./JavaPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { GitLogPanel } from "./GitLogPanel";
import { GitHistoryDialog } from "./GitHistoryDialog";

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
  const [sideView, setSideView] = useState<"project" | "git" | "java">("project");
  const [gitBranch, setGitBranch] = useState("HEAD");
  const [gitEntries, setGitEntries] = useState<GitStatusEntry[]>([]);
  const [gitError, setGitError] = useState("");
  const [workspaceOptionsReady, setWorkspaceOptionsReady] = useState(false);
  const [javaOptions, setJavaOptions] = useState<JavaProjectOptions>();
  const [javaTree, setJavaTree] = useState<JavaProjectNode[]>([]);
  const [javaLog, setJavaLog] = useState("");
  const [javaRunning, setJavaRunning] = useState(false);
  const [javaDebugState, setJavaDebugState] = useState<JavaDebugState>({ status: "stopped", variables: [] });
  const [javaBreakpoints, setJavaBreakpoints] = useState<JavaBreakpoint[]>([]);
  const [javaPanelHeight, setJavaPanelHeight] = useState(240);
  const [problemsHeight, setProblemsHeight] = useState(220);
  const [gitLogHeight, setGitLogHeight] = useState(360);
  const [javaDiagnostics, setJavaDiagnostics] = useState<JavaDiagnostic[]>([]);
  const [javaChecking, setJavaChecking] = useState(false);
  const [importChoices, setImportChoices] = useState<{ suggestions: JavaTypeSuggestion[]; range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } }>();
  const [javaUsages, setJavaUsages] = useState<JavaLspLocation[]>();
  const [showRunConfigurationDialog, setShowRunConfigurationDialog] = useState(false);
  const [treeContextMenu, setTreeContextMenu] = useState<{ x: number; y: number; node: FileTreeNode }>();
  const [editorGitMenu, setEditorGitMenu] = useState<{ x: number; y: number; path: string; startLine?: number; endLine?: number }>();
  const [gitRollbackMenu, setGitRollbackMenu] = useState<{ x: number; y: number; entry: GitStatusEntry }>();
  const [gitHistory, setGitHistory] = useState<{ path: string; startLine?: number; endLine?: number }>();
  const [searchScope, setSearchScope] = useState<string>();
  const [pendingNavigation, setPendingNavigation] = useState<{ result: SearchResult; matchLength: number }>();
  const clientRef = useRef<CoreClient>();
  const didAutoConnect = useRef(false);
  const layoutRef = useRef(layout);
  const treeRefreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const gitRefreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const javaRefreshTimer = useRef<ReturnType<typeof setTimeout>>();
  const javaCheckTimer = useRef<ReturnType<typeof setTimeout>>();
  const selfWriteUntil = useRef(new Map<string, number>());
  const terminalWriters = useRef(new Map<string, (data: string) => void>());
  const terminalBuffers = useRef(new Map<string, string>());
  const markdownBlockTerminals = useRef(new Map<string, string>());
  const monacoEditorRef = useRef<editor.IStandaloneCodeEditor>();
  const monacoRef = useRef<Monaco>();
  const breakpointDecorationsRef = useRef<string[]>([]);
  const diffRollbackTimer = useRef<ReturnType<typeof setTimeout>>();
  const javaLanguageDisposables = useRef<{ dispose(): void }[]>([]);
  const javaOptionsRef = useRef<JavaProjectOptions>();
  const group = layout.editorGroups[0]!;
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId);
  const hasDirtyTabs = group.tabs.some((tab) => tab.dirty);

  useEffect(() => { window.desktop?.setDirtyState(hasDirtyTabs); }, [hasDirtyTabs]);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { javaOptionsRef.current = javaOptions; }, [javaOptions]);
  useEffect(() => {
    if (!pendingNavigation || activeTab?.path !== pendingNavigation.result.path || !monacoEditorRef.current) return;
    const { result, matchLength } = pendingNavigation;
    monacoEditorRef.current.setSelection({ startLineNumber: result.line, startColumn: result.column, endLineNumber: result.line, endColumn: result.column + matchLength });
    monacoEditorRef.current.revealLineInCenter(result.line);
    monacoEditorRef.current.focus();
    setPendingNavigation(undefined);
  }, [activeTab?.path, pendingNavigation]);
  useEffect(() => () => {
    clientRef.current?.disconnect();
    if (treeRefreshTimer.current) clearTimeout(treeRefreshTimer.current);
    if (gitRefreshTimer.current) clearTimeout(gitRefreshTimer.current);
    if (javaRefreshTimer.current) clearTimeout(javaRefreshTimer.current);
    if (javaCheckTimer.current) clearTimeout(javaCheckTimer.current);
    if (diffRollbackTimer.current) clearTimeout(diffRollbackTimer.current);
    for (const disposable of javaLanguageDisposables.current) disposable.dispose();
  }, []);

  const updateGroup = useCallback((update: (tabs: EditorTab[], active?: string) => { tabs: EditorTab[]; activeTabId?: string }) => {
    setLayout((current) => ({ ...current, editorGroups: current.editorGroups.map((item, index) => index === 0 ? { ...item, ...update(item.tabs, item.activeTabId) } : item) }));
  }, []);

  const updateTerminalGroup = useCallback((update: (group: LayoutModel["terminalGroup"]) => LayoutModel["terminalGroup"]) => {
    setLayout((current) => ({ ...current, terminalGroup: update(current.terminalGroup) }));
  }, []);

  const checkJava = useCallback(async () => {
    if (!clientRef.current || !javaOptionsRef.current) return;
    setJavaChecking(true);
    try { setJavaDiagnostics((await clientRef.current.request("java.check", {})).diagnostics); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Java checks failed"); }
    finally { setJavaChecking(false); }
  }, []);

  const scheduleJavaCheck = useCallback(() => {
    if (javaCheckTimer.current) clearTimeout(javaCheckTimer.current);
    javaCheckTimer.current = setTimeout(() => { void checkJava(); }, 700);
  }, [checkJava]);

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

  const restoreWorkspaceOptions = useCallback(async (options: WorkspaceOptions, client: CoreClient) => {
    const tabs = await Promise.all(options.openFiles.map(async (filePath): Promise<EditorTab> => {
      const title = filePath.split("/").pop() ?? filePath;
      try {
        const result = await client.request("filesystem.readFile", { path: filePath });
        return { id: crypto.randomUUID(), type: "file", title, path: filePath, dirty: false, content: result.content, savedContent: result.content, loading: false, markdownMode: /\.md$/i.test(filePath) ? "preview" : undefined };
      } catch (error) {
        return { id: crypto.randomUUID(), type: "file", title, path: filePath, dirty: false, content: "", savedContent: "", loading: false, markdownMode: /\.md$/i.test(filePath) ? "preview" : undefined, error: error instanceof Error ? error.message : "Could not restore file" };
      }
    }));
    const activeTabId = tabs.find((tab) => tab.path === options.activeFile)?.id ?? tabs[0]?.id;
    setLayout((current) => ({
      ...current,
      editorGroups: current.editorGroups.map((item, index) => index === 0 ? { ...item, tabs, activeTabId } : item)
    }));
    setWorkspaceOptionsReady(true);
  }, []);

  const connect = async () => {
    setWorkspaceOptionsReady(false);
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
      if (event.type === "java.output") {
        setJavaLog((current) => (current + event.payload.data).slice(-1_000_000));
        return;
      }
      if (event.type === "java.exit") {
        setJavaRunning(false);
        setJavaLog((current) => `${current}\nProcess exited${event.payload.exitCode === null ? "" : ` with code ${event.payload.exitCode}`}${event.payload.signal ? ` (${event.payload.signal})` : ""}.\n`);
        return;
      }
      if (event.type === "java.debug.state") {
        setJavaDebugState(event.payload);
        if (event.payload.status === "paused") setLayout((current) => ({ ...current, panels: [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), { id: "java", type: "java" }] }));
        return;
      }
      if (gitRefreshTimer.current) clearTimeout(gitRefreshTimer.current);
      gitRefreshTimer.current = setTimeout(() => { void refreshGit(client); }, 200);
      const refreshDiffs = (changedPath?: string) => {
        const diffTabs = layoutRef.current.editorGroups[0]?.tabs.filter((tab) => tab.type === "diff" && (!changedPath || tab.path === changedPath)) ?? [];
        for (const tab of diffTabs) void client.request("git.diff", { path: tab.path }).then((result) => {
          updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, originalContent: result.originalContent, content: result.modifiedContent, error: undefined } : item), activeTabId: active }));
        }).catch(() => undefined);
      };
      if (event.type === "git.changed") { refreshDiffs(); return; }
      refreshDiffs(event.payload.path);
      if (javaOptionsRef.current && (event.payload.path.endsWith(".java") || event.payload.kind === "addDir" || event.payload.kind === "unlinkDir")) {
        if (javaRefreshTimer.current) clearTimeout(javaRefreshTimer.current);
        javaRefreshTimer.current = setTimeout(() => {
          void client.request("java.getProjectTree", {}).then((result) => setJavaTree(result.tree)).catch(() => undefined);
        }, 200);
      }
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
        setJavaOptions(result.options.javaProject);
        if (result.options.javaProject) {
          try { setJavaTree((await client.request("java.getProjectTree", {})).tree); } catch { setJavaTree([]); }
        } else setJavaTree([]);
        await restoreWorkspaceOptions(result.options, client);
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
    setWorkspaceOptionsReady(false);
    setJavaOptions(undefined); setJavaTree([]); setJavaRunning(false); setJavaLog("");
    setLayout(initialLayout); setTree([]); setStatus("idle"); setStatusMessage("");
    markdownBlockTerminals.current.clear();
  };

  const persistedFileTabs = group.tabs.filter((tab) => tab.type === "file");
  const persistedActiveTab = activeTab?.type === "file" ? activeTab : undefined;
  const workspaceOptionsSignature = `${persistedFileTabs.map((tab) => tab.path).join("\0")}\n${persistedActiveTab?.path ?? ""}\n${JSON.stringify(javaOptions)}`;
  useEffect(() => {
    if (status !== "connected" || !workspaceOptionsReady || !clientRef.current) return;
    const options: WorkspaceOptions = { openFiles: persistedFileTabs.map((tab) => tab.path), ...(persistedActiveTab ? { activeFile: persistedActiveTab.path } : {}), ...(javaOptions ? { javaProject: javaOptions } : {}) };
    void clientRef.current.request("workspace.saveOptions", { options }).catch((error: unknown) => {
      setStatusMessage(error instanceof Error ? error.message : "Could not save workspace options");
    });
  }, [status, workspaceOptionsReady, workspaceOptionsSignature]);

  const openFile = async (node: FileTreeNode) => {
    const existing = group.tabs.find((tab) => tab.type === "file" && tab.path === node.path);
    if (existing) { updateGroup((tabs) => ({ tabs, activeTabId: existing.id })); return; }
    const tab: EditorTab = { id: crypto.randomUUID(), type: "file", title: node.name, path: node.path, dirty: false, content: "", savedContent: "", loading: true, markdownMode: /\.md$/i.test(node.path) ? "preview" : undefined };
    updateGroup((tabs) => ({ tabs: [...tabs, tab], activeTabId: tab.id }));
    try {
      const result = await clientRef.current!.request("filesystem.readFile", { path: node.path });
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, content: result.content, savedContent: result.content, loading: false } : item), activeTabId: active }));
    } catch (error) {
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, loading: false, error: error instanceof Error ? error.message : "Read failed" } : item), activeTabId: active }));
    }
  };

  const openDiff = async (entry: GitStatusEntry) => {
    const existing = group.tabs.find((tab) => tab.type === "diff" && tab.path === entry.path);
    if (existing) { updateGroup((tabs) => ({ tabs, activeTabId: existing.id })); return; }
    const tab: EditorTab = { id: crypto.randomUUID(), type: "diff", title: `${entry.path.split("/").pop() ?? entry.path} (Diff)`, path: entry.path, dirty: false, content: "", savedContent: "", originalContent: "", diffMode: "split", loading: true };
    updateGroup((tabs) => ({ tabs: [...tabs, tab], activeTabId: tab.id }));
    try {
      const result = await clientRef.current!.request("git.diff", { path: entry.path });
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, originalContent: result.originalContent, content: result.modifiedContent, savedContent: result.modifiedContent, loading: false } : item), activeTabId: active }));
    } catch (error) {
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, loading: false, error: error instanceof Error ? error.message : "Could not load diff" } : item), activeTabId: active }));
    }
  };

  const activateEditorTab = useCallback(async (tab: EditorTab) => {
    updateGroup((tabs) => ({ tabs, activeTabId: tab.id }));
    if (!clientRef.current || tab.loading || tab.dirty) return;
    try {
      if (tab.type === "diff") {
        const result = await clientRef.current.request("git.diff", { path: tab.path });
        updateGroup((tabs, active) => ({
          tabs: tabs.map((item) => item.id === tab.id && !item.dirty ? { ...item, originalContent: result.originalContent, content: result.modifiedContent, savedContent: result.modifiedContent, error: undefined } : item),
          activeTabId: active
        }));
        return;
      }
      const result = await clientRef.current.request("filesystem.readFile", { path: tab.path });
      updateGroup((tabs, active) => ({
        tabs: tabs.map((item) => item.id === tab.id && !item.dirty ? { ...item, content: result.content, savedContent: result.content, error: undefined } : item),
        activeTabId: active
      }));
    } catch (error) {
      updateGroup((tabs, active) => ({
        tabs: tabs.map((item) => item.id === tab.id ? { ...item, error: error instanceof Error ? error.message : "Could not refresh file" } : item),
        activeTabId: active
      }));
    }
  }, [updateGroup]);

  const rollbackFile = async (entry: GitStatusEntry) => {
    setGitRollbackMenu(undefined);
    if (!window.confirm(`Rollback all local changes in ${entry.path}? This cannot be undone.`)) return;
    try {
      await clientRef.current!.request("git.rollback", { path: entry.path });
      let restoredContent: string | undefined;
      try { restoredContent = (await clientRef.current!.request("filesystem.readFile", { path: entry.path })).content; }
      catch { /* Untracked rollback removes the file. */ }
      updateGroup((tabs, active) => {
        const next = tabs
          .filter((tab) => tab.path !== entry.path || (tab.type === "file" && restoredContent !== undefined))
          .map((tab) => tab.path === entry.path && tab.type === "file" ? { ...tab, content: restoredContent!, savedContent: restoredContent!, dirty: false, error: undefined } : tab);
        return { tabs: next, activeTabId: next.some((tab) => tab.id === active) ? active : next.at(-1)?.id };
      });
      await Promise.all([refreshGit(), refreshTree()]);
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not rollback file"); }
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

  const saveFileTab = useCallback(async (current: EditorTab) => {
    if (current.type !== "file" || current.loading || current.error || !current.dirty || !clientRef.current) return;
    const content = current.content;
    try {
      selfWriteUntil.current.set(current.path, Date.now() + 1500);
      await clientRef.current.request("filesystem.writeFile", { path: current.path, content });
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === current.id ? { ...tab, dirty: tab.content !== content, savedContent: content, error: undefined } : tab), activeTabId: active }));
      if (/\.java$/i.test(current.path)) scheduleJavaCheck();
    } catch (error) {
      selfWriteUntil.current.delete(current.path);
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === current.id ? { ...tab, error: error instanceof Error ? error.message : "Save failed" } : tab), activeTabId: active }));
    }
  }, [scheduleJavaCheck, updateGroup]);

  const saveActive = useCallback(async () => {
    const current = layout.editorGroups[0]?.tabs.find((tab) => tab.id === layout.editorGroups[0]?.activeTabId);
    if (current) await saveFileTab(current);
  }, [layout, saveFileTab]);

  useEffect(() => {
    if (status !== "connected") return;
    const dirtyFiles = group.tabs.filter((tab) => tab.type === "file" && tab.dirty && !tab.loading && !tab.error);
    if (dirtyFiles.length === 0) return;
    const timer = setTimeout(() => { for (const tab of dirtyFiles) void saveFileTab(tab); }, 600);
    return () => clearTimeout(timer);
  }, [status, group.tabs, saveFileTab]);

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

  const createTerminal = async (command?: string): Promise<string | undefined> => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const result = await client.request("terminal.create", { cols: 80, rows: 24 });
      updateTerminalGroup((current) => {
        const id = crypto.randomUUID();
        const tab = { id, terminalId: result.terminalId, title: `Terminal ${current.tabs.length + 1}`, exited: false };
        return { ...current, tabs: [...current.tabs, tab], activeTabId: id };
      });
      setLayout((current) => ({ ...current, panels: [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), { id: "terminal", type: "terminal" }] }));
      if (command) await client.request("terminal.input", { terminalId: result.terminalId, data: `${command.replace(/\s+$/, "")}\n` });
      return result.terminalId;
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not create terminal");
      return undefined;
    }
  };

  const runMarkdownCommand = async (blockId: string, command: string) => {
    const terminalId = markdownBlockTerminals.current.get(blockId);
    const existing = terminalId ? layoutRef.current.terminalGroup.tabs.find((tab) => tab.terminalId === terminalId && !tab.exited) : undefined;
    if (existing && clientRef.current) {
      updateTerminalGroup((current) => ({ ...current, activeTabId: existing.id }));
      setLayout((current) => ({ ...current, panels: [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), { id: "terminal", type: "terminal" }] }));
      try { await clientRef.current.request("terminal.input", { terminalId: existing.terminalId, data: `${command.replace(/\s+$/, "")}\n` }); return; }
      catch { markdownBlockTerminals.current.delete(blockId); }
    }
    const created = await createTerminal(command);
    if (created) markdownBlockTerminals.current.set(blockId, created);
  };

  const renderMarkdownPre = ({ children, node }: { children?: ReactNode; node?: { position?: { start?: { line?: number } } } }) => {
    const child = Array.isArray(children) ? children[0] : children;
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre>{children}</pre>;
    const language = child.props.className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase();
    if (!language || !["sh", "shell", "bash", "zsh"].includes(language)) return <pre>{children}</pre>;
    const command = String(child.props.children ?? "").replace(/\n$/, "");
    const blockId = `${activeTab?.path ?? "markdown"}:${node?.position?.start?.line ?? command}`;
    return <div className="markdown-shell-block"><header><span>{language}</span><button title="Run in block terminal" disabled={!command.trim()} onClick={() => void runMarkdownCommand(blockId, command)}><Play size={14} /></button></header><pre>{children}</pre></div>;
  };

  const toggleTerminalPanel = () => {
    const visible = layout.panels.some((panel) => panel.type === "terminal");
    if (visible) {
      setLayout((current) => ({ ...current, panels: current.panels.filter((panel) => panel.type !== "terminal") }));
    } else if (layout.terminalGroup.tabs.length > 0) {
      setLayout((current) => ({ ...current, panels: [...current.panels.filter((panel) => !["java", "problems", "gitlog"].includes(panel.type)), { id: "terminal", type: "terminal" }] }));
    } else {
      void createTerminal();
    }
  };

  const closeTerminal = (tab: LayoutModel["terminalGroup"]["tabs"][number]) => {
    if (!tab.exited) void clientRef.current?.request("terminal.close", { terminalId: tab.terminalId }).catch(() => undefined);
    terminalBuffers.current.delete(tab.terminalId);
    for (const [blockId, terminalId] of markdownBlockTerminals.current) if (terminalId === tab.terminalId) markdownBlockTerminals.current.delete(blockId);
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

  const refreshJavaTree = async () => {
    try { setJavaTree((await clientRef.current!.request("java.getProjectTree", {})).tree); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not refresh Java project"); }
  };

  const loadMavenProject = async (pomPath: string) => {
    setTreeContextMenu(undefined);
    try {
      const result = await clientRef.current!.request("java.loadMavenProject", { pomPath });
      setJavaOptions(result.options); javaOptionsRef.current = result.options; setJavaTree(result.tree); setSideView("java");
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not load Maven project"); }
  };

  const addJavaSourceRoot = async (sourcePath: string) => {
    setTreeContextMenu(undefined);
    try {
      const result = await clientRef.current!.request("java.addSourceRoot", { path: sourcePath });
      setJavaOptions(result.options); javaOptionsRef.current = result.options; setJavaTree(result.tree); setSideView("java");
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not add source root"); }
  };

  const toggleJavaPanel = () => {
    const visible = layout.panels.some((panel) => panel.type === "java");
    setLayout((current) => ({
      ...current,
      panels: visible ? current.panels.filter((panel) => panel.type !== "java") : [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), { id: "java", type: "java" }]
    }));
  };

  const toggleProblemsPanel = () => {
    const visible = layout.panels.some((panel) => panel.type === "problems");
    setLayout((current) => ({ ...current, panels: visible ? current.panels.filter((panel) => panel.type !== "problems") : [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), { id: "problems", type: "problems" }] }));
    if (!visible) void checkJava();
  };

  const toggleGitLogPanel = () => {
    const visible = layout.panels.some((panel) => panel.type === "gitlog");
    setLayout((current) => ({ ...current, panels: visible ? current.panels.filter((panel) => panel.type !== "gitlog") : [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), { id: "gitlog", type: "gitlog" }] }));
  };

  const runJavaAction = async (action: "java.build" | "java.run") => {
    setLayout((current) => ({ ...current, panels: [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), { id: "java", type: "java" }] }));
    setJavaRunning(true);
    try { await clientRef.current!.request(action, {}); }
    catch (error) { setJavaRunning(false); setJavaLog((current) => `${current}${error instanceof Error ? error.message : "Java process failed"}\n`); }
  };

  const stopJava = async () => {
    try { await clientRef.current!.request("java.stop", {}); } catch { /* Process may have already exited. */ }
  };

  const debugJava = async () => {
    setLayout((current) => ({ ...current, panels: [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), { id: "java", type: "java" }] }));
    setJavaRunning(true);
    try { await clientRef.current!.request("java.debug.start", { breakpoints: javaBreakpoints }); }
    catch (error) { setJavaRunning(false); setJavaDebugState({ status: "stopped", variables: [] }); setJavaLog((current) => `${current}${error instanceof Error ? error.message : "Debugger failed"}\n`); }
  };

  const toggleBreakpoint = (filePath: string, content: string, line: number) => {
    const packageName = content.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1];
    const simpleName = filePath.split("/").pop()?.replace(/\.java$/i, "") ?? "";
    const className = packageName ? `${packageName}.${simpleName}` : simpleName;
    setJavaBreakpoints((current) => current.some((item) => item.path === filePath && item.line === line)
      ? current.filter((item) => item.path !== filePath || item.line !== line)
      : [...current, { path: filePath, line, className }]);
  };

  useEffect(() => {
    const instance = monacoEditorRef.current;
    if (!instance || activeTab?.type !== "file" || !/\.java$/i.test(activeTab.path)) return;
    breakpointDecorationsRef.current = instance.deltaDecorations(breakpointDecorationsRef.current, javaBreakpoints.filter((item) => item.path === activeTab.path).map((item) => ({ range: { startLineNumber: item.line, startColumn: 1, endLineNumber: item.line, endColumn: 1 }, options: { isWholeLine: false, glyphMarginClassName: "java-breakpoint", glyphMarginHoverMessage: { value: `Breakpoint at line ${item.line}` } } })));
  }, [activeTab?.path, javaBreakpoints]);

  useEffect(() => {
    const instance = monacoEditorRef.current;
    const api = monacoRef.current;
    const model = instance?.getModel();
    if (!api || !model || activeTab?.type !== "file") return;
    const diagnostics = javaDiagnostics.filter((item) => item.path === activeTab.path);
    api.editor.setModelMarkers(model, "java", diagnostics.map((item) => {
      const line = Math.max(1, Math.min(item.line, model.getLineCount()));
      const column = Math.max(1, Math.min(item.column, model.getLineMaxColumn(line)));
      return {
      startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: Math.max(column + 1, model.getLineMaxColumn(line)),
      severity: item.severity === "error" ? api.MarkerSeverity.Error : api.MarkerSeverity.Warning,
      message: item.message, source: "Maven"
    }; }));
  }, [activeTab?.path, javaDiagnostics]);

  const selectRunConfiguration = async (id: string) => {
    try {
      const result = await clientRef.current!.request("java.selectRunConfiguration", { id });
      setJavaOptions(result.options); javaOptionsRef.current = result.options;
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not select run configuration"); }
  };

  const beginJavaResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = javaPanelHeight;
    const move = (moveEvent: PointerEvent) => setJavaPanelHeight(Math.max(140, Math.min(520, startHeight + startY - moveEvent.clientY)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const beginProblemsResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = problemsHeight;
    const move = (moveEvent: PointerEvent) => setProblemsHeight(Math.max(120, Math.min(520, startHeight + startY - moveEvent.clientY)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const beginGitLogResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY; const startHeight = gitLogHeight;
    const move = (moveEvent: PointerEvent) => setGitLogHeight(Math.max(180, Math.min(650, startHeight + startY - moveEvent.clientY)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const openDiagnostic = async (diagnostic: JavaDiagnostic) => {
    await openFile({ name: diagnostic.path.split("/").pop() ?? diagnostic.path, path: diagnostic.path, type: "file" });
    setPendingNavigation({ result: { path: diagnostic.path, line: diagnostic.line, column: diagnostic.column, preview: diagnostic.message }, matchLength: 1 });
  };

  const openJavaLocation = async (location: JavaLspLocation) => {
    await openFile({ name: location.path.split("/").pop() ?? location.path, path: location.path, type: "file" });
    setPendingNavigation({ result: { path: location.path, line: location.startLine, column: location.startColumn, preview: "Java symbol" }, matchLength: Math.max(1, location.endColumn - location.startColumn) });
    setJavaUsages(undefined);
  };

  const applyJavaImport = (suggestion: JavaTypeSuggestion, range = importChoices?.range) => {
    const instance = monacoEditorRef.current;
    const model = instance?.getModel();
    if (!instance || !model || !range) return;
    const content = model.getValue();
    const packageName = content.match(/^\s*package\s+([\w$.]+)\s*;/m)?.[1];
    const needsImport = suggestion.qualifiedName.includes(".") && !suggestion.qualifiedName.startsWith("java.lang.") && !suggestion.qualifiedName.startsWith(`${packageName}.`) && !new RegExp(`^\\s*import\\s+${suggestion.qualifiedName.replaceAll(".", "\\.")}\\s*;`, "m").test(content);
    const edits: editor.IIdentifiedSingleEditOperation[] = [{ range, text: suggestion.simpleName, forceMoveMarkers: true }];
    if (needsImport) {
      const imports = [...content.matchAll(/^\s*import\s+[^;]+;\s*$/gm)];
      const packageMatch = content.match(/^\s*package\s+[\w$.]+\s*;\s*$/m);
      const offset = imports.at(-1)?.index !== undefined ? imports.at(-1)!.index! + imports.at(-1)![0].length : packageMatch?.index !== undefined ? packageMatch.index + packageMatch[0].length : 0;
      const position = model.getPositionAt(offset);
      edits.push({ range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }, text: `${offset === 0 ? "" : "\n"}import ${suggestion.qualifiedName};\n`, forceMoveMarkers: true });
    }
    instance.executeEdits("java-auto-import", edits);
    instance.focus();
    setImportChoices(undefined);
  };

  const mountEditor = (instance: editor.IStandaloneCodeEditor, api: Monaco) => {
    monacoEditorRef.current = instance;
    monacoRef.current = api;
    for (const disposable of javaLanguageDisposables.current) disposable.dispose();
    javaLanguageDisposables.current = [];
    if (activeTab?.type !== "file") return;
    const filePath = activeTab.path;
    javaLanguageDisposables.current.push(instance.onContextMenu((event) => {
      event.event.preventDefault();
      const selection = instance.getSelection();
      const hasSelection = Boolean(selection && !selection.isEmpty());
      setEditorGitMenu({ x: Math.min(event.event.posx, window.innerWidth - 245), y: Math.min(event.event.posy, window.innerHeight - 85), path: filePath, ...(hasSelection ? { startLine: selection!.startLineNumber, endLine: selection!.endLineNumber } : {}) });
    }));
    if (!/\.java$/i.test(filePath)) return;
    javaLanguageDisposables.current.push(api.languages.registerCompletionItemProvider("java", {
      triggerCharacters: ["."],
      provideCompletionItems: async (model, position) => {
        if (!clientRef.current || model !== instance.getModel()) return { suggestions: [] };
        const result = await clientRef.current.request("java.completion", { path: filePath, content: model.getValue(), line: position.lineNumber, column: position.column });
        const word = model.getWordUntilPosition(position);
        return { suggestions: result.items.map((item) => ({
          label: item.label, detail: item.detail, kind: api.languages.CompletionItemKind.Text, insertText: item.insertText,
          range: item.range ? { startLineNumber: item.range.startLine, startColumn: item.range.startColumn, endLineNumber: item.range.endLine, endColumn: item.range.endColumn } : { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn },
          additionalTextEdits: item.additionalTextEdits.map((edit) => ({ range: { startLineNumber: edit.range.startLine, startColumn: edit.range.startColumn, endLineNumber: edit.range.endLine, endColumn: edit.range.endColumn }, text: edit.text }))
        })) };
      }
    }));
    javaLanguageDisposables.current.push(instance.addAction({ id: "java.semantic-completion", label: "Java completion", keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.Enter, api.KeyMod.WinCtrl | api.KeyCode.Enter], run: () => instance.trigger("java", "editor.action.triggerSuggest", {}) }));
    javaLanguageDisposables.current.push(instance.onMouseDown((event) => {
      const line = event.target.position?.lineNumber ?? event.target.range?.startLineNumber;
      if ((event.target.type === 2 || event.target.type === 3) && line) { toggleBreakpoint(filePath, instance.getValue(), line); return; }
      const position = event.target.position;
      if (!position || (!event.event.ctrlKey && !event.event.metaKey) || !clientRef.current) return;
      event.event.preventDefault();
      const content = instance.getValue();
      void clientRef.current.request("java.definition", { path: filePath, content, line: position.lineNumber, column: position.column }).then(async ({ locations }) => {
        const declaration = locations.find((location) => location.path === filePath && position.lineNumber >= location.startLine && position.lineNumber <= location.endLine && position.column >= location.startColumn && position.column <= location.endColumn);
        if (declaration) {
          const references = await clientRef.current!.request("java.references", { path: filePath, content, line: position.lineNumber, column: position.column });
          setJavaUsages(references.locations);
        } else if (locations[0]) void openJavaLocation(locations[0]);
      }).catch((error: unknown) => setStatusMessage(error instanceof Error ? error.message : "Java navigation failed"));
    }));
  };

  const mountWorkingDiff = (instance: editor.IStandaloneDiffEditor) => {
    instance.getModifiedEditor().onDidChangeModelContent(() => {
      if (diffRollbackTimer.current) clearTimeout(diffRollbackTimer.current);
      diffRollbackTimer.current = setTimeout(async () => {
        const current = layoutRef.current.editorGroups[0];
        const tab = current?.tabs.find((item) => item.id === current.activeTabId);
        if (!tab || tab.type !== "diff" || !clientRef.current) return;
        const content = instance.getModifiedEditor().getValue();
        const untracked = gitEntries.some((entry) => entry.path === tab.path && entry.indexStatus === "?" && entry.worktreeStatus === "?");
        try {
          if (untracked && !content) await clientRef.current.request("git.rollback", { path: tab.path });
          else {
            selfWriteUntil.current.set(tab.path, Date.now() + 1500);
            await clientRef.current.request("filesystem.writeFile", { path: tab.path, content });
          }
          updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, content, savedContent: content, dirty: false } : item), activeTabId: active }));
          await Promise.all([refreshGit(), refreshTree()]);
        } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not rollback change block"); }
      }, 200);
    });
  };

  const openSearchForNode = (node: FileTreeNode) => {
    const scope = node.type === "directory" ? node.path : node.path.split("/").slice(0, -1).join("/");
    setTreeContextMenu(undefined);
    setSearchScope(scope);
  };

  const navigateToSearchResult = async (result: SearchResult, matchLength: number) => {
    await openFile({ name: result.path.split("/").pop() ?? result.path, path: result.path, type: "file" });
    setPendingNavigation({ result, matchLength });
    setSearchScope(undefined);
  };

  if (status !== "connected") return <ConnectionScreen {...{ host, port, status, statusMessage, setHost, setPort, connect }} />;

  return <div className="ide-shell">
    <div className="workspace-row">
      <nav className="tool-stripe" aria-label="Tool windows">
        <button className={`tool-stripe-button ${sideView === "project" ? "active" : ""}`} title="Project" onClick={() => setSideView("project")}><Folder size={15} /><span>Project</span></button>
        <button className={`tool-stripe-button ${sideView === "git" ? "active" : ""}`} title="Git changes" onClick={() => { setSideView("git"); void refreshGit(); }}><GitBranch size={15} /><span>Git</span>{gitEntries.length > 0 && <span className="tool-badge">{gitEntries.length > 99 ? "99+" : gitEntries.length}</span>}</button>
        {javaOptions && <button className={`tool-stripe-button ${sideView === "java" ? "active" : ""}`} title="Java project" onClick={() => { setSideView("java"); void refreshJavaTree(); }}><Coffee size={15} /><span>Java</span></button>}
      </nav>
      <aside className="explorer" style={{ width: explorerWidth }}>
        {sideView === "project" ? <>
          <header className="panel-header"><span>Project</span><button title="Synchronize files" onClick={() => void refreshTree()}><RefreshCw size={14} /></button></header>
          <div className="workspace-name" onContextMenu={(event) => { event.preventDefault(); setTreeContextMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 110), node: { name: "REMOTE WORKSPACE", path: "", type: "directory" } }); }}><ChevronDown size={13} />REMOTE WORKSPACE</div>
          <div className="tree"><Tree nodes={tree} activePath={activeTab?.path} onOpen={openFile} onContextMenu={(event, node) => { event.preventDefault(); setTreeContextMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 110), node }); }} /></div>
        </> : sideView === "git" ? <>
          <header className="panel-header"><span>Git Changes</span><button title="Refresh Git status" onClick={() => void refreshGit()}><RefreshCw size={14} /></button></header>
          <div className="git-branch"><GitBranch size={13} /><span>{gitBranch}</span></div>
          <GitChangesView entries={gitEntries} error={gitError} activePath={activeTab?.type === "diff" ? activeTab.path : undefined} onOpenDiff={openDiff} onContextMenu={(event, entry) => { event.preventDefault(); setGitRollbackMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 50), entry }); }} />
        </> : <>
          <header className="panel-header"><span>Java Project</span><button title="Refresh Java project" onClick={() => void refreshJavaTree()}><RefreshCw size={14} /></button></header>
          <div className="java-project-meta"><Coffee size={13} /><span>{javaOptions?.pomPath}</span></div>
          <div className="tree java-tree"><JavaProjectTree nodes={javaTree} activePath={activeTab?.path} onOpen={openFile} /></div>
        </>}
      </aside>
      <div className="resize-handle" onPointerDown={beginResize} />
      <main className="workbench">
        <div className="titlebar-actions">
          {javaOptions && <div className="top-java-run">
            <button title="Run selected Java configuration" disabled={javaRunning || !javaOptions.selectedRunConfigurationId} onClick={() => void runJavaAction("java.run")}><Play size={14} /></button>
            <button title="Debug selected Java configuration" disabled={javaRunning || !javaOptions.selectedRunConfigurationId} onClick={() => void debugJava()}><Bug size={14} /></button>
            <button title="Stop Java process" disabled={!javaRunning} onClick={() => void stopJava()}><Square size={13} /></button>
            <select aria-label="Java run configuration" value={javaOptions.selectedRunConfigurationId ?? ""} onChange={(event) => event.target.value === "__create__" ? setShowRunConfigurationDialog(true) : void selectRunConfiguration(event.target.value)}><option value="" disabled>Select run configuration</option>{javaOptions.runConfigurations.map((configuration) => <option key={configuration.id} value={configuration.id}>{configuration.name}</option>)}<option value="__create__">Create new...</option></select>
          </div>}
          <span className="connection-dot" />{host}:{port}<button title="Disconnect" onClick={disconnect}><LogOut size={15} /></button>
        </div>
        <div className="tabs" role="tablist">
          {group.tabs.map((tab) => <button className={`tab ${tab.id === group.activeTabId ? "active" : ""}`} key={tab.id} onClick={() => void activateEditorTab(tab)}>
            {tab.type === "diff" ? <GitCompareArrows size={14} /> : <File size={14} />}<span>{tab.title}</span>{tab.dirty && <span className="dirty" title="Unsaved changes" />}<span className="close" title={`Close ${tab.title}`} onClick={(event) => { event.stopPropagation(); closeTab(tab); }}><X size={13} /></span>
          </button>)}
          <div className="tab-spacer" />
          {activeTab?.type === "diff" && <div className="editor-mode-switch" aria-label="Diff layout">
            <button className={activeTab.diffMode !== "unified" ? "active" : ""} title="Side-by-side diff" onClick={() => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, diffMode: "split" } : tab), activeTabId: active }))}><Columns2 size={14} /></button>
            <button className={activeTab.diffMode === "unified" ? "active" : ""} title="Unified diff" onClick={() => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, diffMode: "unified" } : tab), activeTabId: active }))}><ListTree size={14} /></button>
          </div>}
          {activeTab?.type === "file" && /\.md$/i.test(activeTab.path) && <div className="editor-mode-switch" aria-label="Markdown mode">
            <button className={activeTab.markdownMode !== "preview" ? "active" : ""} title="Edit Markdown" onClick={() => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, markdownMode: "edit" } : tab), activeTabId: active }))}><Pencil size={14} /></button>
            <button className={activeTab.markdownMode === "preview" ? "active" : ""} title="Preview Markdown" onClick={() => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, markdownMode: "preview" } : tab), activeTabId: active }))}><Eye size={14} /></button>
          </div>}
          <button className="save-button" title="Save active file" disabled={activeTab?.type !== "file" || !activeTab.dirty} onClick={() => void saveActive()}><Save size={15} /></button>
        </div>
        <div className="editor-area" onContextMenu={(event) => {
          if (activeTab?.type !== "file" || activeTab.markdownMode === "preview") return;
          event.preventDefault();
          const selection = monacoEditorRef.current?.getSelection();
          const hasSelection = Boolean(selection && !selection.isEmpty());
          setEditorGitMenu({ x: Math.min(event.clientX, window.innerWidth - 245), y: Math.min(event.clientY, window.innerHeight - 85), path: activeTab.path, ...(hasSelection ? { startLine: selection!.startLineNumber, endLine: selection!.endLineNumber } : {}) });
        }}>
          {!activeTab ? <div className="empty-editor">Open a file from Project</div> : activeTab.loading ? <div className="empty-editor">Loading {activeTab.title}...</div> : activeTab.error && !activeTab.content ? <div className="editor-error">{activeTab.error}</div> : <>
            {activeTab.error && <div className="inline-error">{activeTab.error}</div>}
            {activeTab.type === "diff" ? <DiffEditor key={activeTab.path} original={activeTab.originalContent ?? ""} modified={activeTab.content} language={languageByExtension[activeTab.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} theme="vs-dark" onMount={mountWorkingDiff} options={{ automaticLayout: true, readOnly: false, originalEditable: false, renderMarginRevertIcon: true, renderSideBySide: activeTab.diffMode !== "unified", minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }} /> : activeTab.markdownMode === "preview" ? <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: renderMarkdownPre }}>{activeTab.content}</ReactMarkdown></div> : <Editor key={activeTab.path} path={activeTab.path} language={languageByExtension[activeTab.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} value={activeTab.content} theme="vs-dark" onMount={mountEditor} options={{ automaticLayout: true, contextmenu: false, minimap: { enabled: false }, glyphMargin: /\.java$/i.test(activeTab.path), fontSize: 13, scrollBeyondLastLine: false, padding: { top: 10 } }} onChange={(value) => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, content: value ?? "", dirty: (value ?? "") !== tab.savedContent, error: undefined } : tab), activeTabId: active }))} />}
          </>}
        </div>
      </main>
    </div>
    {layout.panels.some((panel) => panel.type === "terminal") && <TerminalPanel client={clientRef.current!} group={layout.terminalGroup} height={terminalHeight} onActivate={(id) => updateTerminalGroup((current) => ({ ...current, activeTabId: id }))} onCreate={() => void createTerminal()} onClose={closeTerminal} onResizeStart={beginTerminalResize} registerWriter={registerTerminalWriter} />}
    {layout.panels.some((panel) => panel.type === "java") && javaOptions && <JavaPanel height={javaPanelHeight} log={javaLog} running={javaRunning} options={javaOptions} debugState={javaDebugState} onBuild={() => void runJavaAction("java.build")} onRun={() => void runJavaAction("java.run")} onDebug={() => void debugJava()} onStop={() => void stopJava()} onDebugCommand={(command) => void clientRef.current!.request("java.debug.command", { command })} onClear={() => setJavaLog("")} onResizeStart={beginJavaResize} />}
    {layout.panels.some((panel) => panel.type === "problems") && javaOptions && <ProblemsPanel height={problemsHeight} diagnostics={javaDiagnostics} checking={javaChecking} onRefresh={() => void checkJava()} onOpen={(diagnostic) => void openDiagnostic(diagnostic)} onResizeStart={beginProblemsResize} />}
    {layout.panels.some((panel) => panel.type === "gitlog") && <GitLogPanel client={clientRef.current!} height={gitLogHeight} onResizeStart={beginGitLogResize} />}
    <footer className="bottom-tool-bar">
      <button className={`bottom-tool-button ${layout.panels.some((panel) => panel.type === "terminal") ? "active" : ""}`} onClick={toggleTerminalPanel}><SquareTerminal size={14} /><span>Terminal</span>{layout.terminalGroup.tabs.length > 0 && <span className="bottom-tool-count">{layout.terminalGroup.tabs.length}</span>}</button>
      {javaOptions && <button className={`bottom-tool-button ${layout.panels.some((panel) => panel.type === "java") ? "active" : ""}`} onClick={toggleJavaPanel}><Coffee size={14} /><span>Java</span>{javaRunning && <span className="running-indicator" />}</button>}
      {javaOptions && <button className={`bottom-tool-button ${layout.panels.some((panel) => panel.type === "problems") ? "active" : ""}`} onClick={toggleProblemsPanel}><CircleAlert size={14} /><span>Problems</span>{javaDiagnostics.length > 0 && <span className="bottom-tool-count">{javaDiagnostics.length}</span>}</button>}
      <button className={`bottom-tool-button ${layout.panels.some((panel) => panel.type === "gitlog") ? "active" : ""}`} onClick={toggleGitLogPanel}><GitBranch size={14} /><span>Git</span></button>
    </footer>
    {treeContextMenu && <div className="context-menu-layer" onMouseDown={() => setTreeContextMenu(undefined)}>
      <div className="context-menu" style={{ left: treeContextMenu.x, top: treeContextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
        <button onClick={() => openSearchForNode(treeContextMenu.node)}><Search size={14} /><span>Find in Files</span></button>
        {treeContextMenu.node.type === "file" && treeContextMenu.node.name === "pom.xml" && <button onClick={() => void loadMavenProject(treeContextMenu.node.path)}><Package size={14} /><span>Load as Maven Project</span></button>}
        {javaOptions && treeContextMenu.node.type === "directory" && treeContextMenu.node.path && <button onClick={() => void addJavaSourceRoot(treeContextMenu.node.path)}><Coffee size={14} /><span>Mark as Sources Root</span></button>}
      </div>
    </div>}
    {editorGitMenu && <div className="context-menu-layer" onMouseDown={() => setEditorGitMenu(undefined)}><div className="context-menu editor-git-menu" style={{ left: editorGitMenu.x, top: editorGitMenu.y }} onMouseDown={(event) => event.stopPropagation()}><div className="context-submenu-trigger"><button><GitBranch size={14} /><span>Git</span><ChevronRight size={13} /></button><div className="context-menu context-submenu"><button onClick={() => { setGitHistory({ path: editorGitMenu.path }); setEditorGitMenu(undefined); }}><FileDiff size={14} /><span>Show file changes</span></button><button disabled={editorGitMenu.startLine === undefined} onClick={() => { setGitHistory({ path: editorGitMenu.path, startLine: editorGitMenu.startLine, endLine: editorGitMenu.endLine }); setEditorGitMenu(undefined); }}><ListTree size={14} /><span>Show selection changes</span></button></div></div></div></div>}
    {gitRollbackMenu && <div className="context-menu-layer" onMouseDown={() => setGitRollbackMenu(undefined)}><div className="context-menu" style={{ left: gitRollbackMenu.x, top: gitRollbackMenu.y }} onMouseDown={(event) => event.stopPropagation()}><button className="danger" onClick={() => void rollbackFile(gitRollbackMenu.entry)}><RefreshCw size={14} /><span>Rollback</span></button></div></div>}
    {searchScope !== undefined && <FindInFilesDialog client={clientRef.current!} scope={searchScope} onClose={() => setSearchScope(undefined)} onNavigate={(result, matchLength) => void navigateToSearchResult(result, matchLength)} />}
    {importChoices && <div className="dialog-overlay" onMouseDown={() => setImportChoices(undefined)}><section className="import-chooser" role="dialog" aria-modal="true" aria-label="Choose Java import" onMouseDown={(event) => event.stopPropagation()}><header><span>Import class</span><button title="Close" onClick={() => setImportChoices(undefined)}><X size={15} /></button></header><div>{importChoices.suggestions.map((suggestion) => <button key={suggestion.qualifiedName} onClick={() => applyJavaImport(suggestion)}><span>{suggestion.simpleName}</span><code>{suggestion.qualifiedName}</code><small>{suggestion.source}</small></button>)}</div></section></div>}
    {javaUsages && <div className="dialog-overlay" onMouseDown={() => setJavaUsages(undefined)}><section className="import-chooser usage-chooser" role="dialog" aria-modal="true" aria-label="Java usages" onMouseDown={(event) => event.stopPropagation()}><header><span>Usages ({javaUsages.length})</span><button title="Close" onClick={() => setJavaUsages(undefined)}><X size={15} /></button></header><div>{javaUsages.length === 0 ? <div className="problems-empty">No project usages found</div> : javaUsages.map((location, index) => <button key={`${location.path}:${location.startLine}:${location.startColumn}:${index}`} onClick={() => void openJavaLocation(location)}><span>{location.path.split("/").pop()}</span><code>{location.path}</code><small>{location.startLine}:{location.startColumn}</small></button>)}</div></section></div>}
    {gitHistory && <GitHistoryDialog client={clientRef.current!} path={gitHistory.path} startLine={gitHistory.startLine} endLine={gitHistory.endLine} onClose={() => setGitHistory(undefined)} />}
    {showRunConfigurationDialog && <RunConfigurationDialog client={clientRef.current!} onClose={() => setShowRunConfigurationDialog(false)} onSaved={(options) => { setJavaOptions(options); javaOptionsRef.current = options; setShowRunConfigurationDialog(false); }} />}
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

function Tree({ nodes, activePath, onOpen, onContextMenu }: { nodes: FileTreeNode[]; activePath?: string; onOpen(node: FileTreeNode): void; onContextMenu(event: ReactMouseEvent, node: FileTreeNode): void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return <>{nodes.map((node) => node.type === "directory" ? <div key={node.path}>
    <button className="tree-row" onContextMenu={(event) => onContextMenu(event, node)} onClick={() => setExpanded((current) => { const next = new Set(current); next.has(node.path) ? next.delete(node.path) : next.add(node.path); return next; })}>
      {expanded.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{expanded.has(node.path) ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{node.name}</span>
    </button>{expanded.has(node.path) && <div className="tree-children"><Tree nodes={node.children ?? []} activePath={activePath} onOpen={onOpen} onContextMenu={onContextMenu} /></div>}
  </div> : <FileTreeRow key={node.path} node={node} selected={activePath === node.path} onOpen={onOpen} onContextMenu={onContextMenu} />)}</>;
}

function JavaProjectTree({ nodes, activePath, onOpen }: { nodes: JavaProjectNode[]; activePath?: string; onOpen(node: FileTreeNode): void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(nodes.filter((node) => node.type === "sourceRoot").map((node) => node.path)));
  useEffect(() => setExpanded((current) => new Set([...current, ...nodes.filter((node) => node.type === "sourceRoot").map((node) => node.path)])), [nodes]);
  const render = (items: JavaProjectNode[], depth: number): ReactNode => items.map((node) => {
    if (node.type === "file") return <button key={node.path} className={`tree-row java-file-row ${activePath === node.path ? "selected" : ""}`} style={{ paddingLeft: 11 + depth * 13 }} onClick={() => onOpen({ name: node.name, path: node.path, type: "file" })}>
      <Coffee size={14} color="#d58b59" /><span>{node.name}</span>
    </button>;
    const open = expanded.has(node.path);
    return <div key={node.path}>
      <button className={`tree-row ${node.type === "sourceRoot" ? "java-source-root" : ""}`} style={{ paddingLeft: 7 + depth * 13 }} onClick={() => setExpanded((current) => { const next = new Set(current); open ? next.delete(node.path) : next.add(node.path); return next; })}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{node.type === "sourceRoot" ? <FolderOpen size={14} color="#6ea8fe" /> : <Package size={14} color="#b5a36a" />}<span>{node.name}</span>
      </button>
      {open && render(node.children ?? [], depth + 1)}
    </div>;
  });
  return <>{render(nodes, 0)}</>;
}

function GitChangesView({ entries, error, activePath, onOpenDiff, onContextMenu }: { entries: GitStatusEntry[]; error: string; activePath?: string; onOpenDiff(entry: GitStatusEntry): void; onContextMenu(event: ReactMouseEvent, entry: GitStatusEntry): void }) {
  if (error) return <div className="git-empty error">{error}</div>;
  if (entries.length === 0) return <div className="git-empty">No local changes</div>;
  const groups = [
    { title: "Conflicts", entries: entries.filter((entry) => entry.indexStatus === "U" || entry.worktreeStatus === "U" || ["AA", "DD"].includes(entry.indexStatus + entry.worktreeStatus)) },
    { title: "Untracked", entries: entries.filter((entry) => entry.indexStatus === "?" && entry.worktreeStatus === "?") },
    { title: "Staged", entries: entries.filter((entry) => entry.indexStatus !== " " && entry.indexStatus !== "?" && entry.indexStatus !== "U" && !["AA", "DD"].includes(entry.indexStatus + entry.worktreeStatus)) },
    { title: "Changes", entries: entries.filter((entry) => entry.indexStatus === " " && entry.worktreeStatus !== " " && entry.worktreeStatus !== "?" && entry.worktreeStatus !== "U") }
  ].filter((group) => group.entries.length > 0);
  return <div className="git-changes">{groups.map((group) => <GitChangeGroup key={group.title} title={group.title} entries={group.entries} activePath={activePath} onOpenDiff={onOpenDiff} onContextMenu={onContextMenu} />)}</div>;
}

function GitChangeGroup({ title, entries, activePath, onOpenDiff, onContextMenu }: { title: string; entries: GitStatusEntry[]; activePath?: string; onOpenDiff(entry: GitStatusEntry): void; onContextMenu(event: ReactMouseEvent, entry: GitStatusEntry): void }) {
  const [expanded, setExpanded] = useState(true);
  return <section className={`git-group git-group-${title.toLowerCase()}`}>
    <button className="git-group-title" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{title}</span><span className="git-count">{entries.length}</span>
    </button>
    {expanded && <GitStatusTree entries={entries} activePath={activePath} onOpenDiff={onOpenDiff} onContextMenu={onContextMenu} />}
  </section>;
}

type GitTreeNode =
  | { type: "directory"; name: string; path: string; children: GitTreeNode[] }
  | { type: "file"; name: string; path: string; entry: GitStatusEntry };

function GitStatusTree({ entries, activePath, onOpenDiff, onContextMenu }: { entries: GitStatusEntry[]; activePath?: string; onOpenDiff(entry: GitStatusEntry): void; onContextMenu(event: ReactMouseEvent, entry: GitStatusEntry): void }) {
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
    return <button key={node.path} className={`git-file-row ${activePath === entry.path ? "selected" : ""}`} style={{ paddingLeft: 27 + depth * 13 }} title={entry.originalPath ? `${entry.originalPath} -> ${entry.path}` : entry.path} onClick={() => onOpenDiff(entry)} onContextMenu={(event) => onContextMenu(event, entry)}>
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

function FileTreeRow({ node, selected, onOpen, onContextMenu }: { node: FileTreeNode; selected: boolean; onOpen(node: FileTreeNode): void; onContextMenu(event: ReactMouseEvent, node: FileTreeNode): void }) {
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
  return <button className={`tree-row file-row ${selected ? "selected" : ""}`} onContextMenu={(event) => onContextMenu(event, node)} onClick={() => void onOpen(node)}>
    <span className="tree-indent" /><Icon className="file-kind-icon" color={color} size={14} /><span>{node.name}</span>
  </button>;
}

function RunConfigurationDialog({ client, onClose, onSaved }: { client: CoreClient; onClose(): void; onSaved(options: JavaProjectOptions): void }) {
  const [classes, setClasses] = useState<JavaMainClass[]>([]);
  const [mainClass, setMainClass] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void client.request("java.listMainClasses", {}).then((result) => {
      if (!current) return;
      setClasses(result.classes);
      const first = result.classes[0]?.className ?? "";
      setMainClass(first); setName(first.split(".").pop() ?? first);
    }).catch((loadError: unknown) => { if (current) setError(loadError instanceof Error ? loadError.message : "Could not discover main classes"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [onClose]);

  const save = async () => {
    if (!name.trim() || !mainClass) return;
    setSaving(true); setError("");
    try { onSaved((await client.request("java.addRunConfiguration", { name: name.trim(), mainClass })).options); }
    catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Could not save run configuration"); setSaving(false); }
  };

  return <div className="dialog-overlay" onMouseDown={onClose}>
    <section className="run-config-dialog" role="dialog" aria-modal="true" aria-label="Add Java run configuration" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2>Add Run Configuration</h2><span>Java Application</span></div><button title="Close" onClick={onClose}><X size={15} /></button></header>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>Profile name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Application" /></label>
        <label>Main class<select value={mainClass} disabled={loading || classes.length === 0} onChange={(event) => { setMainClass(event.target.value); if (!name.trim()) setName(event.target.value.split(".").pop() ?? event.target.value); }}><option value="" disabled>{loading ? "Discovering classes..." : "Select main class"}</option>{classes.map((item) => <option key={item.className} value={item.className}>{item.className}</option>)}</select></label>
        {classes.length === 0 && !loading && !error && <div className="run-config-empty">No classes with a public static void main method were found in configured source roots.</div>}
        {error && <div className="find-error">{error}</div>}
        <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={saving || !name.trim() || !mainClass}>{saving ? "Saving..." : "Add"}</button></footer>
      </form>
    </section>
  </div>;
}

function FindInFilesDialog({ client, scope, onClose, onNavigate }: { client: CoreClient; scope: string; onClose(): void; onNavigate(result: SearchResult, matchLength: number): void }) {
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
    if (!query.trim()) { setMatches([]); setSelected(undefined); setLoading(false); setError(""); return; }
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void client.request("filesystem.search", { query, path: scope, matchCase }).then((result) => {
        if (version !== searchVersion.current) return;
        setMatches(result.matches); setSelected(result.matches[0]); setTruncated(result.truncated);
      }).catch((searchError: unknown) => {
        if (version !== searchVersion.current) return;
        setMatches([]); setSelected(undefined); setError(searchError instanceof Error ? searchError.message : "Search failed");
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

  return <div className="dialog-overlay" onMouseDown={onClose}>
    <section className="find-dialog" role="dialog" aria-modal="true" aria-label="Find in Files" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2>Find in Files</h2><span>{scope || "Remote workspace"}</span></div><button title="Close" onClick={onClose}><X size={15} /></button></header>
      <div className="find-controls">
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Text to find" maxLength={200} />
        <label className="match-case" title="Match case"><input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} /><CaseSensitive size={17} /></label>
        <span className="find-progress">{loading ? "Searching..." : query ? `${matches.length} matches` : ""}</span>
      </div>
      {error && <div className="find-error">{error}</div>}
      <div className="find-split">
        <section className="find-results-pane">
          <div className="find-pane-header"><Search size={13} /><span>Occurrences</span>{truncated && <span>First 500</span>}</div>
          <div className="find-results">
            {!loading && !error && matches.length === 0 && query && <div className="find-empty">No matches</div>}
            {matches.map((match, index) => <button className={selected === match ? "selected" : ""} key={`${match.path}:${match.line}:${index}`} title={match.path} onClick={() => setSelected(match)} onDoubleClick={() => onNavigate(match, query.length)}>
              <code>{match.preview || " "}</code>
              <span className="find-result-file">{match.path.split("/").pop()}</span>
              <span className="find-location">{match.line}:{match.column}</span>
            </button>)}
          </div>
        </section>
        <section className="find-preview-pane">
          <div className="find-pane-header"><FileCode2 size={13} /><span>Preview</span>{selected && <span className="find-preview-file">{selected.path.split("/").pop()}</span>}{selected && <button title="Open in editor" onClick={() => onNavigate(selected, query.length)}><ArrowUpRight size={14} /></button>}</div>
          <div className="find-preview-editor">
            {previewError ? <div className="find-empty">{previewError}</div> : selected ? <Editor value={previewContent} language={languageByExtension[selected.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} theme="vs-dark" onMount={(instance) => { previewEditorRef.current = instance; }} options={{ readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3, scrollBeyondLastLine: false, padding: { top: 6 }, renderLineHighlight: "all" }} /> : <div className="find-empty">Select a result</div>}
          </div>
        </section>
      </div>
    </section>
  </div>;
}
