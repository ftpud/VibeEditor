import Editor, { DiffEditor, type Monaco } from "@monaco-editor/react";
import { ArrowUp, ArrowUpRight, Bot, Braces, Bug, CaseSensitive, Check, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Coffee, Columns2, Eye, EyeOff, File, FileCode2, FileDiff, FileJson, FileText, Folder, FolderOpen, GitBranch, GitCompareArrows, GitMerge, Hash, Library, ListTodo, ListTree, LoaderCircle, LogOut, MoreVertical, Package, Palette, Pencil, Play, Plus, RefreshCw, Save, Search, Settings, ShieldAlert, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { AgentFile, AgentFileScope, AiConfiguration, AiModel, AiProvider, AiProviderDescriptor, AiSession, AiStatus, AiTaskSummary, AiUsage, FileColor, FileTreeNode, GitBranch as GitBranchInfo, GitDiffHunk, GitStatusEntry, HttpResponse, JavaBreakpoint, JavaDebugState, JavaDiagnostic, JavaLspLocation, JavaMainClass, JavaProjectNode, JavaProjectOptions, JavaTypeSuggestion, SearchResult, UsefulFile, UsefulFileScope, WorkspaceOptions, WorkspaceTask } from "@remote-ide/protocol";
import type { editor } from "monaco-editor";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CoreClient } from "./client";
import { readSetting, readSettingNumber, readWorkspaceSetting, workspaceSettingKey, writeSetting, writeWorkspaceSetting } from "./settings";
import { initialLayout, type EditorTab, type LayoutModel, type Panel } from "./model";
import { TerminalPanel } from "./TerminalPanel";
import { JavaPanel } from "./JavaPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { GitLogPanel } from "./GitLogPanel";
import { GitHistoryDialog } from "./GitHistoryDialog";
import { GitToolbarActions, RollbackSelectedDialog, executeRollbackSelection, isUntrackedGitEntry, selectedGitEntries } from "./GitRollbackControls";
import { AiPanel, type AiAttachment } from "./AiPanel";
import { configureMonacoThemes, monacoTheme, type HighlightTheme } from "./theme";

type ConnectionStatus = "idle" | "connecting" | "connected" | "failed" | "disconnected" | "workspace-error";
type StatusKind = "progress" | "success" | "error";
type BottomPanelType = Extract<Panel["type"], "terminal" | "java" | "problems" | "gitlog">;
const languageByExtension: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", html: "html",
  css: "css", md: "markdown", java: "java", py: "python", yaml: "yaml", yml: "yaml", mta: "yaml", mtaext: "yaml",
  xml: "xml", cds: "sap-cds", http: "http", txt: "plaintext"
};
const formatAiStatus = (status: AiStatus) => ({ idle: "", in_progress: "In progress", user_prompt: "User prompt", done: "Done", error: "Error" })[status];
const fileColorChoices: { id: FileColor; label: string }[] = [{ id: "red", label: "Red" }, { id: "orange", label: "Orange" }, { id: "yellow", label: "Yellow" }, { id: "green", label: "Green" }, { id: "blue", label: "Blue" }, { id: "purple", label: "Purple" }, { id: "gray", label: "Gray" }];
const gitHunkDecorations = (hunks: GitDiffHunk[]): editor.IModelDeltaDecoration[] => hunks.map((hunk) => {
  const start = Math.max(1, hunk.modifiedStart);
  const end = Math.max(start, start + Math.max(1, hunk.modifiedLines) - 1);
  const kind = hunk.originalLines === 0 ? "added" : hunk.modifiedLines === 0 ? "deleted" : "modified";
  return { range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 }, options: { isWholeLine: true, linesDecorationsClassName: `git-change-marker ${kind}`, hoverMessage: { value: "Click the gutter marker to inspect this change" } } };
});
type ParsedHttpRequest = { line: number; method: string; url: string; headers: Record<string, string>; body?: string };
/** Identifies which workspace, provider and request order an AI session snapshot was fetched for. */
type AiSnapshotToken = { sequence: number; workspace: string; provider: AiProvider };
function parseHttpRequests(content: string): ParsedHttpRequest[] {
  const lines = content.split("\n"); const requests: ParsedHttpRequest[] = [];
  let blockStart = 0;
  for (let end = 0; end <= lines.length; end += 1) {
    if (end < lines.length && !/^\s*###(?:\s.*)?$/.test(lines[end]!)) continue;
    const block = lines.slice(blockStart, end); let index = 0;
    while (index < block.length && (!block[index]!.trim() || /^\s*(#(?!##)|\/\/)/.test(block[index]!))) index += 1;
    const match = block[index]?.match(/^\s*([A-Za-z]+)\s+(\S+)\s*(?:HTTP\/\d(?:\.\d)?)?\s*$/);
    if (match) {
      const line = blockStart + index + 1; const headers: Record<string, string> = {}; index += 1;
      while (index < block.length && block[index]!.trim()) { const header = block[index]!.match(/^\s*([^:#][^:]*):\s*(.*)$/); if (header) headers[header[1]!.trim()] = header[2]!.trim(); index += 1; }
      while (index < block.length && !block[index]!.trim()) index += 1;
      const body = block.slice(index).join("\n").trimEnd(); requests.push({ line, method: match[1]!.toUpperCase(), url: match[2]!, headers, ...(body ? { body } : {}) });
    }
    blockStart = end + 1;
  }
  return requests;
}

/** Setting name under which the AI provider last used for a task (or the root workspace) is stored. */
function aiProviderTaskKey(taskId?: string): string { return `ai.provider.task.${taskId ?? "root"}`; }
function aiAgentTaskKey(taskId?: string): string { return `ai.agent.task.${taskId ?? "root"}`; }
function agentKey(agent: Pick<AgentFile, "scope" | "name">): string { return `${agent.scope}:${agent.name}`; }

export function App() {
  const workspaceKeyRef = useRef("");
  const wsSave = (key: string, value: string) => writeWorkspaceSetting(workspaceKeyRef.current, key, value);
  const [theme, setTheme] = useState<"dark" | "light">(() => readSetting("theme") === "light" ? "light" : "dark");
  const [highlightTheme, setHighlightTheme] = useState<HighlightTheme>(() => readSetting("highlightTheme") === "ftpud" ? "ftpud" : "default");
  const [uiFontFamily, setUiFontFamily] = useState<"jetbrains" | "inter">(() => readSetting("uiFontFamily") === "inter" ? "inter" : "jetbrains");
  const [uiFontSize, setUiFontSize] = useState(() => readSettingNumber("uiFontSize", 13, 10, 20));
  const [uiLineHeight, setUiLineHeight] = useState(() => readSettingNumber("uiLineHeight", 1.2, 1, 2));
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; wsSave("theme", theme); }, [theme]);
  useEffect(() => { wsSave("highlightTheme", highlightTheme); }, [highlightTheme]);
  useEffect(() => { const value = uiFontFamily === "jetbrains" ? '"JetBrains Mono Variable"' : '"Inter Variable"'; document.documentElement.style.setProperty("--ui-font-family", value); wsSave("uiFontFamily", uiFontFamily); }, [uiFontFamily]);
  useEffect(() => { document.documentElement.style.setProperty("--ui-font-size", `${uiFontSize}px`); wsSave("uiFontSize", String(uiFontSize)); }, [uiFontSize]);
  useEffect(() => { document.documentElement.style.setProperty("--ui-line-height", String(uiLineHeight)); wsSave("uiLineHeight", String(uiLineHeight)); }, [uiLineHeight]);
  const saved = useMemo(() => {
    try { return JSON.parse(readSetting("connection") ?? "{}") as Partial<{ host: string; port: string }>; } catch { return {}; }
  }, []);
  const launchConfig = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return { host: params.get("host") ?? undefined, port: params.get("port") ?? undefined };
  }, []);
  const [host, setHost] = useState(launchConfig.host ?? saved.host ?? "127.0.0.1");
  const [port, setPort] = useState(launchConfig.port ?? saved.port ?? "7331");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [statusMessage, setStatusMessageState] = useState("");
  const [statusKind, setStatusKind] = useState<StatusKind>("error");
  const setStatusMessage = useCallback((message: string) => { setStatusKind("error"); setStatusMessageState(message); }, []);
  const showStatus = useCallback((message: string, kind: StatusKind) => { setStatusKind(kind); setStatusMessageState(message); }, []);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [showIgnored, setShowIgnored] = useState(() => readSetting("showIgnoredFiles") === "true");
  const showIgnoredRef = useRef(showIgnored);
  const [layout, setLayout] = useState<LayoutModel>(initialLayout);
  const [sideLayout, setSideLayout] = useState<"classic" | "ai-focused">(() => readSetting("sideLayout") === "classic" ? "classic" : "ai-focused");
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(520);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(360);
  const [leftPanels, setLeftPanels] = useState({ tasks: true, ai: true });
  const [rightPanels, setRightPanels] = useState({ project: true, git: true, taskGit: false, java: false, useful: false, agents: false });
  const [classicSideView, setClassicSideView] = useState<"project" | "git" | "taskGit" | "java" | "useful" | "agents">("project");
  const [classicLeftWidth, setClassicLeftWidth] = useState(260);
  const [classicRightWidth, setClassicRightWidth] = useState(300);
  const [classicTasksOpen, setClassicTasksOpen] = useState(true);
  const [classicAiOpen, setClassicAiOpen] = useState(false);
  const [classicSplit, setClassicSplit] = useState(50);

  // Persist panel layout per workspace, keeping the value as the global default for new workspaces.
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "ai-focused") { writeWorkspaceSetting(workspaceKeyRef.current, "focused.leftPanels", JSON.stringify(leftPanels)); } }, [leftPanels]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "ai-focused") { writeWorkspaceSetting(workspaceKeyRef.current, "focused.rightPanels", JSON.stringify(rightPanels)); } }, [rightPanels]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "ai-focused") { writeWorkspaceSetting(workspaceKeyRef.current, "focused.leftWidth", String(leftSidebarWidth)); } }, [leftSidebarWidth]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "ai-focused") { writeWorkspaceSetting(workspaceKeyRef.current, "focused.rightWidth", String(rightSidebarWidth)); } }, [rightSidebarWidth]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "classic") { writeWorkspaceSetting(workspaceKeyRef.current, "classic.leftWidth", String(classicLeftWidth)); } }, [classicLeftWidth]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "classic") { writeWorkspaceSetting(workspaceKeyRef.current, "classic.rightWidth", String(classicRightWidth)); } }, [classicRightWidth]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "classic") { writeWorkspaceSetting(workspaceKeyRef.current, "classic.tasksOpen", String(classicTasksOpen)); } }, [classicTasksOpen]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "classic") { writeWorkspaceSetting(workspaceKeyRef.current, "classic.aiOpen", String(classicAiOpen)); } }, [classicAiOpen]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "classic") { writeWorkspaceSetting(workspaceKeyRef.current, "classic.split", String(classicSplit)); } }, [classicSplit]);
  useEffect(() => { if (workspaceKeyRef.current && sideLayout === "classic") { writeWorkspaceSetting(workspaceKeyRef.current, "classic.sideView", classicSideView); } }, [classicSideView]);
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [mergeDialog, setMergeDialog] = useState<WorkspaceTask>();
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [taskFilter, setTaskFilter] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const activeTaskRef = useRef<WorkspaceTask>();
  const selectedTaskIdRef = useRef<string>();
  const [taskSwitching, setTaskSwitching] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(240);
  const [usefulFiles, setUsefulFiles] = useState<UsefulFile[]>([]);
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [selectedAgentKey, setSelectedAgentKey] = useState("");
  const [fileColors, setFileColors] = useState<Record<string, FileColor>>({});
  const [usefulDialog, setUsefulDialog] = useState<{ mode: "create" | "rename"; scope: UsefulFileScope; file?: UsefulFile }>();
  const [agentDialog, setAgentDialog] = useState<{ mode: "create" | "rename"; scope: Exclude<AgentFileScope, "workspace">; file?: AgentFile }>();
  const [activeWorkspace, setActiveWorkspace] = useState("");
  const [projectName, setProjectName] = useState("");
  const [aiSession, setAiSession] = useState<AiSession>({ model: "gpt-5.6-sol", reasoning: "low", status: "idle", messages: [] });
  const [aiSessions, setAiSessions] = useState<AiSession[]>([]);
  const [aiProvider, setAiProvider] = useState<AiProvider>(() => readSetting("aiProvider") === "copilot" ? "copilot" : "codex");
  const [aiModels, setAiModels] = useState<AiModel[]>([]);
  const [aiProviders, setAiProviders] = useState<AiProviderDescriptor[]>([]);
  const [aiUsage, setAiUsage] = useState<AiUsage>();
  const [aiAttachments, setAiAttachments] = useState<Record<string, AiAttachment[]>>({});
  const emptyAiSummary: AiTaskSummary = { status: "idle", preview: "", additions: 0, deletions: 0, pendingPermission: false };
  const [aiStatuses, setAiStatuses] = useState<{ root: AiTaskSummary; tasks: Record<string, AiTaskSummary> }>({ root: emptyAiSummary, tasks: {} });
  const aiStatusesRequested = useRef(0);
  const aiStatusesApplied = useRef(0);
  const aiSessionRequested = useRef(0);
  const aiSessionApplied = useRef(0);
  const [activeGitHunks, setActiveGitHunks] = useState<GitDiffHunk[]>([]);
  const [gitHunkDialog, setGitHunkDialog] = useState<{ x: number; y: number; path: string; hunk: GitDiffHunk; originalContent: string; modifiedContent: string; error?: string }>();
  const [httpResult, setHttpResult] = useState<{ request: ParsedHttpRequest; response?: HttpResponse; error?: string; loading: boolean }>();
  const [gitBranch, setGitBranch] = useState("HEAD");
  const [branchMenu, setBranchMenu] = useState<{ branches: GitBranchInfo[]; selected?: string; loading: boolean }>();
  const [gitEntries, setGitEntries] = useState<GitStatusEntry[]>([]);
  const [selectedGitPaths, setSelectedGitPaths] = useState<Set<string>>(new Set());
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [gitCommitting, setGitCommitting] = useState(false);
  const [gitPushing, setGitPushing] = useState(false);
  const [gitRollingBack, setGitRollingBack] = useState(false);
  const [gitRollbackDialog, setGitRollbackDialog] = useState<GitStatusEntry[]>();
  const [taskGitEntries, setTaskGitEntries] = useState<GitStatusEntry[]>([]);
  const [taskGitError, setTaskGitError] = useState("");
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
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tab: EditorTab }>();
  const [draggedTabId, setDraggedTabId] = useState<string>();
  const [gitHistory, setGitHistory] = useState<{ path: string; startLine?: number; endLine?: number }>();
  const [searchScope, setSearchScope] = useState<string>();
  const [pendingNavigation, setPendingNavigation] = useState<{ result: SearchResult; matchLength: number }>();
  const clientRef = useRef<CoreClient>();
  const gitRollbackRunningRef = useRef(false);
  const aiProviderRef = useRef<AiProvider>(readSetting("aiProvider") === "copilot" ? "copilot" : "codex");
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
  const monacoDiffEditorRef = useRef<editor.IStandaloneDiffEditor>();
  const monacoRef = useRef<Monaco>();
  const breakpointDecorationsRef = useRef<string[]>([]);
  const gitDecorationsRef = useRef<string[]>([]);
  const activeGitHunksRef = useRef<GitDiffHunk[]>([]);
  const diffRollbackTimer = useRef<ReturnType<typeof setTimeout>>();
  const javaLanguageDisposables = useRef<{ dispose(): void }[]>([]);

  useEffect(() => {
    if (status !== "connected" || !workspaceOptionsReady || !workspaceKeyRef.current) return;
    const activePanel = layout.panels.find((panel): panel is Panel & { type: BottomPanelType } => ["terminal", "java", "problems", "gitlog"].includes(panel.type));
    writeWorkspaceSetting(workspaceKeyRef.current, "bottom.activePanel", activePanel?.type ?? "");
  }, [layout.panels, status, workspaceOptionsReady]);
  useEffect(() => { if (workspaceOptionsReady && workspaceKeyRef.current) writeWorkspaceSetting(workspaceKeyRef.current, "bottom.terminalHeight", String(terminalHeight)); }, [terminalHeight, workspaceOptionsReady]);
  useEffect(() => { if (workspaceOptionsReady && workspaceKeyRef.current) writeWorkspaceSetting(workspaceKeyRef.current, "bottom.javaHeight", String(javaPanelHeight)); }, [javaPanelHeight, workspaceOptionsReady]);
  useEffect(() => { if (workspaceOptionsReady && workspaceKeyRef.current) writeWorkspaceSetting(workspaceKeyRef.current, "bottom.problemsHeight", String(problemsHeight)); }, [problemsHeight, workspaceOptionsReady]);
  useEffect(() => { if (workspaceOptionsReady && workspaceKeyRef.current) writeWorkspaceSetting(workspaceKeyRef.current, "bottom.gitLogHeight", String(gitLogHeight)); }, [gitLogHeight, workspaceOptionsReady]);
  useEffect(() => {
    if (status !== "connected" || !statusMessage || statusKind === "error" || statusKind === "progress") return;
    const timer = window.setTimeout(() => setStatusMessageState(""), 4500);
    return () => window.clearTimeout(timer);
  }, [status, statusKind, statusMessage]);
  const javaOptionsRef = useRef<JavaProjectOptions>();
  const activeWorkspaceRef = useRef("");
  const group = layout.editorGroups[0]!;
  const activeTab = group.tabs.find((tab) => tab.id === group.activeTabId);
  const hasDirtyTabs = group.tabs.some((tab) => tab.dirty);
  const projectGitStatuses = useMemo(() => Object.fromEntries(gitEntries.map((entry) => [entry.path, entry.indexStatus === "?" || entry.indexStatus === "A" ? "C" : "M"] as const)), [gitEntries]);

  useEffect(() => {
    document.title = status === "connected" && projectName ? `${projectName} — Vibe Editor` : "Vibe Editor";
  }, [projectName, status]);
  useEffect(() => { window.desktop?.setDirtyState(hasDirtyTabs); }, [hasDirtyTabs]);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { javaOptionsRef.current = javaOptions; }, [javaOptions]);
  useEffect(() => { activeWorkspaceRef.current = activeWorkspace; }, [activeWorkspace]);
  useEffect(() => { selectedTaskIdRef.current = selectedTaskId; }, [selectedTaskId]);
  useEffect(() => { activeGitHunksRef.current = activeGitHunks; }, [activeGitHunks]);
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

  const refreshTaskGit = useCallback(async (task = activeTaskRef.current, client = clientRef.current) => {
    if (!client || !task) { setTaskGitEntries([]); setTaskGitError(""); return; }
    try {
      const result = await client.request("git.compareFiles", { ref: task.baseBranch });
      setTaskGitEntries(result.files.map((file) => ({ path: file.path, ...(file.originalPath ? { originalPath: file.originalPath } : {}), indexStatus: file.status === "?" ? "?" : file.status[0] ?? "M", worktreeStatus: file.status === "?" ? "?" : " " })));
      setTaskGitError("");
    } catch (error) { setTaskGitEntries([]); setTaskGitError(error instanceof Error ? error.message : "Could not compare task with its base branch"); }
  }, []);

  // Several ai.statuses requests can be in flight at once (AI activity emits a burst of ai.changed
  // events) and the backend answers them concurrently, so responses can arrive out of order. Without
  // this guard an older snapshot overwrites a newer one and the task rows keep showing stale progress.
  const refreshAiStatuses = useCallback(async (client = clientRef.current) => {
    if (!client) return;
    const sequence = ++aiStatusesRequested.current;
    const statuses = await client.request("ai.statuses", {});
    if (sequence <= aiStatusesApplied.current) return;
    aiStatusesApplied.current = sequence;
    setAiStatuses(statuses);
  }, []);
  const refreshTasks = useCallback(async (client = clientRef.current) => {
    if (!client) return;
    const result = await client.request("tasks.list", {});
    setTasks(result.tasks);
    setSelectedTaskId(result.selectedTaskId);
    selectedTaskIdRef.current = result.selectedTaskId;
    activeTaskRef.current = result.tasks.find((task) => task.id === result.selectedTaskId);
  }, []);
  // The transcript has the same problem, and it is worse there: a reply that was requested for the
  // previous task or provider would drop that conversation into the panel, so the next prompt looks
  // like it was prepended to a transcript it does not belong to. Every session snapshot therefore
  // carries the workspace, provider and request order it was asked for, and stale ones are dropped.
  const aiToken = useCallback((): AiSnapshotToken => ({ sequence: ++aiSessionRequested.current, workspace: activeWorkspaceRef.current, provider: aiProviderRef.current }), []);
  const applyAiSession = useCallback((session: AiSession, token: AiSnapshotToken): boolean => {
    if (token.workspace !== activeWorkspaceRef.current || token.provider !== aiProviderRef.current) return false;
    if (token.sequence <= aiSessionApplied.current) return false;
    aiSessionApplied.current = token.sequence;
    setAiSession(session);
    return true;
  }, []);
  const refreshAi = useCallback(async (client = clientRef.current) => {
    if (!client) return;
    const token = aiToken();
    const [session] = await Promise.all([client.request("ai.get", { provider: aiProviderRef.current }), refreshAiStatuses(client)]);
    applyAiSession(session.session, token);
  }, [aiToken, applyAiSession, refreshAiStatuses]);
  // The listing only changes when a conversation starts, is switched or is removed, so it is kept
  // out of `refreshAi`, which also runs for every chunk the agent streams.
  const refreshAiSessions = useCallback(async (client = clientRef.current) => {
    if (!client) return;
    const provider = aiProviderRef.current;
    const workspace = activeWorkspaceRef.current;
    const sessions = (await client.request("ai.sessions", { provider })).sessions;
    if (provider === aiProviderRef.current && workspace === activeWorkspaceRef.current) setAiSessions(sessions);
  }, []);
  const refreshUsefulFiles = useCallback(async (client = clientRef.current) => { if (client) setUsefulFiles((await client.request("useful.list", {})).files); }, []);
  const refreshAgents = useCallback(async (client = clientRef.current, taskId = selectedTaskIdRef.current) => {
    if (!client) return;
    const next = (await client.request("agents.list", {})).agents;
    setAgents(next);
    const saved = workspaceKeyRef.current ? readSetting(workspaceSettingKey(workspaceKeyRef.current, aiAgentTaskKey(taskId))) ?? "" : "";
    setSelectedAgentKey(next.some((agent) => agentKey(agent) === saved) ? saved : "");
  }, []);

  const restoreWorkspaceOptions = useCallback(async (options: WorkspaceOptions, client: CoreClient) => {
    setFileColors(options.fileColors ?? {});
    setGitCommitMessage(options.gitCommitMessage ?? "");
    setSelectedGitPaths(new Set());
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
    const restoredTerminals = (await Promise.all((options.terminal?.tabs ?? []).map(async (saved, index) => {
      try {
        const result = await client.request("terminal.create", { cols: 80, rows: 24 });
        return { index, tab: { id: crypto.randomUUID(), terminalId: result.terminalId, title: saved.title, exited: false } };
      } catch { return undefined; }
    }))).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const activeTerminal = restoredTerminals.find((item) => item.index === options.terminal?.activeTabIndex)?.tab ?? restoredTerminals[0]?.tab;
    const savedBottomPanel = workspaceKeyRef.current ? readWorkspaceSetting(workspaceKeyRef.current, "bottom.activePanel") : null;
    const validBottomPanel = savedBottomPanel === "gitlog"
      || (savedBottomPanel === "terminal" && restoredTerminals.length > 0)
      || ((savedBottomPanel === "java" || savedBottomPanel === "problems") && Boolean(options.javaProject));
    const bottomPanel: BottomPanelType | undefined = validBottomPanel
      ? savedBottomPanel as BottomPanelType
      : savedBottomPanel === null && options.terminal?.panelOpen && restoredTerminals.length > 0 ? "terminal" : undefined;
    setLayout((current) => ({
      ...current,
      panels: [...current.panels.filter((panel) => !["terminal", "java", "problems", "gitlog"].includes(panel.type)), ...(bottomPanel ? [{ id: bottomPanel, type: bottomPanel }] : [])],
      editorGroups: current.editorGroups.map((item, index) => index === 0 ? { ...item, tabs, activeTabId } : item),
      terminalGroup: { ...current.terminalGroup, tabs: restoredTerminals.map((item) => item.tab), activeTabId: activeTerminal?.id }
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
      if (event.type === "ai.changed") {
        if (event.payload.workspace === activeWorkspaceRef.current) void refreshAi(client).catch(() => undefined);
        else void refreshAiStatuses(client).catch(() => undefined);
        return;
      }
      if (event.type === "tasks.changed") {
        void Promise.all([refreshTasks(client), refreshAiStatuses(client)]).catch(() => undefined);
        return;
      }
      if (gitRefreshTimer.current) clearTimeout(gitRefreshTimer.current);
      gitRefreshTimer.current = setTimeout(() => { void refreshGit(client); void refreshTaskGit(activeTaskRef.current, client); void refreshAiStatuses(client).catch(() => undefined); }, 200);
      const refreshDiffs = (changedPath?: string) => {
        const diffTabs = layoutRef.current.editorGroups[0]?.tabs.filter((tab) => tab.type === "diff" && (!changedPath || (tab.diffPath ?? tab.path) === changedPath)) ?? [];
        for (const tab of diffTabs) void (tab.diffRef ? client.request("git.compareDiff", { ref: tab.diffRef, path: tab.diffPath ?? tab.path, ...(tab.diffOriginalPath ? { originalPath: tab.diffOriginalPath } : {}) }) : client.request("git.diff", { path: tab.path })).then((result) => {
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
        void client.request("filesystem.listTree", { includeIgnored: showIgnoredRef.current })
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
        const result = await client.request("workspace.open", { includeIgnored: showIgnoredRef.current });
        clientRef.current = client;
        setActiveWorkspace(result.workspace); activeWorkspaceRef.current = result.workspace;
        setProjectName(result.projectName);
        // Load workspace-specific settings
        const key = result.workspace;
        workspaceKeyRef.current = key;
        const setting = (name: string) => readWorkspaceSetting(key, name);
        const wsTheme = setting("theme");
        if (wsTheme === "light" || wsTheme === "dark") setTheme(wsTheme);
        const wsHighlight = setting("highlightTheme");
        if (wsHighlight === "ftpud" || wsHighlight === "default") setHighlightTheme(wsHighlight);
        const wsFontFamily = setting("uiFontFamily");
        if (wsFontFamily === "inter" || wsFontFamily === "jetbrains") setUiFontFamily(wsFontFamily);
        const wsFontSize = Number(setting("uiFontSize"));
        if (wsFontSize >= 10 && wsFontSize <= 20) setUiFontSize(wsFontSize);
        const wsLineHeight = Number(setting("uiLineHeight"));
        if (wsLineHeight >= 1 && wsLineHeight <= 2) setUiLineHeight(wsLineHeight);
        // Restore both modes so switching layouts does not replace saved geometry with defaults.
        try { const saved = JSON.parse(setting("focused.leftPanels") ?? "{}"); if (typeof saved === "object" && saved !== null) setLeftPanels((current) => ({ ...current, ...saved })); } catch {}
        try { const saved = JSON.parse(setting("focused.rightPanels") ?? "{}"); if (typeof saved === "object" && saved !== null) setRightPanels((current) => ({ ...current, ...saved })); } catch {}
        const savedFocusedLeftWidth = Number(setting("focused.leftWidth")); if (savedFocusedLeftWidth >= 280 && savedFocusedLeftWidth <= 900) setLeftSidebarWidth(savedFocusedLeftWidth);
        const savedFocusedRightWidth = Number(setting("focused.rightWidth")); if (savedFocusedRightWidth >= 180 && savedFocusedRightWidth <= 700) setRightSidebarWidth(savedFocusedRightWidth);
        const savedClassicLeftWidth = Number(setting("classic.leftWidth")); if (savedClassicLeftWidth >= 180 && savedClassicLeftWidth <= 500) setClassicLeftWidth(savedClassicLeftWidth);
        const savedClassicRightWidth = Number(setting("classic.rightWidth")); if (savedClassicRightWidth >= 240 && savedClassicRightWidth <= 960) setClassicRightWidth(savedClassicRightWidth);
        const savedTasksOpen = setting("classic.tasksOpen"); if (savedTasksOpen === "true" || savedTasksOpen === "false") setClassicTasksOpen(savedTasksOpen === "true");
        const savedAiOpen = setting("classic.aiOpen"); if (savedAiOpen === "true" || savedAiOpen === "false") setClassicAiOpen(savedAiOpen === "true");
        const savedSplit = Number(setting("classic.split")); if (savedSplit >= 10 && savedSplit <= 90) setClassicSplit(savedSplit);
        const savedSideView = setting("classic.sideView"); if (["project", "git", "taskGit", "java", "useful", "agents"].includes(savedSideView ?? "")) setClassicSideView(savedSideView as typeof classicSideView);
        const savedTerminalHeight = Number(setting("bottom.terminalHeight")); if (savedTerminalHeight >= 130 && savedTerminalHeight <= 520) setTerminalHeight(savedTerminalHeight);
        const savedJavaHeight = Number(setting("bottom.javaHeight")); if (savedJavaHeight >= 140 && savedJavaHeight <= 520) setJavaPanelHeight(savedJavaHeight);
        const savedProblemsHeight = Number(setting("bottom.problemsHeight")); if (savedProblemsHeight >= 120 && savedProblemsHeight <= 520) setProblemsHeight(savedProblemsHeight);
        const savedGitLogHeight = Number(setting("bottom.gitLogHeight")); if (savedGitLogHeight >= 180 && savedGitLogHeight <= 650) setGitLogHeight(savedGitLogHeight);
        const providerResult = await client.request("ai.providers", {});
        setAiProviders(providerResult.providers);
        setJavaOptions(result.options.javaProject);
        if (result.options.javaProject) {
          try { setJavaTree((await client.request("java.getProjectTree", {})).tree); } catch { setJavaTree([]); }
        } else setJavaTree([]);
        await restoreWorkspaceOptions(result.options, client);
        const taskResult = await client.request("tasks.list", {});
        setTasks(taskResult.tasks); setSelectedTaskId(taskResult.selectedTaskId); selectedTaskIdRef.current = taskResult.selectedTaskId; activeTaskRef.current = taskResult.tasks.find((task) => task.id === taskResult.selectedTaskId);
        // The provider is remembered per task, so it can only be resolved once the selected task is known.
        const taskProvider = setting(aiProviderTaskKey(taskResult.selectedTaskId)) as AiProvider | null;
        const wsProvider = setting("aiProvider") as AiProvider | null;
        const known = (candidate: AiProvider | null) => Boolean(candidate) && providerResult.providers.some((item) => item.id === candidate);
        const provider = known(taskProvider) ? taskProvider! : known(wsProvider) ? wsProvider! : (providerResult.providers[0]?.id ?? "codex");
        aiProviderRef.current = provider; setAiProvider(provider);
        wsSave(aiProviderTaskKey(taskResult.selectedTaskId), provider);
        const modelResult = await client.request("ai.models", { provider });
        let session = (await client.request("ai.get", { provider })).session;
        const savedModel = setting(`ai.${provider}.model`);
        const savedReasoning = setting(`ai.${provider}.reasoning`);
        if (savedModel && modelResult.models.some((model) => model.id === savedModel)) {
          const model = modelResult.models.find((item) => item.id === savedModel)!;
          const reasoning = savedReasoning && model.reasoningLevels.includes(savedReasoning) ? savedReasoning : model.defaultReasoning;
          if (session.model !== savedModel || session.reasoning !== reasoning) session = (await client.request("ai.configure", { provider, model: savedModel, reasoning })).session;
        }
        setAiModels(modelResult.models); setAiSession(session); setAiUsage((await client.request("ai.usage", { provider })).usage);
        setAiSessions((await client.request("ai.sessions", { provider })).sessions);
        await refreshAiStatuses(client);
        await Promise.all([refreshUsefulFiles(client), refreshAgents(client, taskResult.selectedTaskId)]);
        setTree(result.tree); setStatus("connected"); setStatusMessage("");
        void refreshGit(client); void refreshTaskGit(activeTaskRef.current, client);
        writeSetting("connection", JSON.stringify({ host, port }));
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
    workspaceKeyRef.current = "";
    setWorkspaceOptionsReady(false);
    setTasks([]); setSelectedTaskId(undefined);
    setJavaOptions(undefined); setJavaTree([]); setJavaRunning(false); setJavaLog("");
    setLayout(initialLayout); setTree([]); setStatus("idle"); setStatusMessage("");
    markdownBlockTerminals.current.clear();
  };

  const persistedFileTabs = group.tabs.filter((tab) => tab.type === "file");
  const persistedActiveTab = activeTab?.type === "file" ? activeTab : undefined;
  const terminalPanelOpen = layout.panels.some((panel) => panel.type === "terminal");
  const activeTerminalIndex = layout.terminalGroup.tabs.findIndex((tab) => tab.id === layout.terminalGroup.activeTabId);
  const terminalOptions: NonNullable<WorkspaceOptions["terminal"]> = { tabs: layout.terminalGroup.tabs.map((tab) => ({ title: tab.title })), ...(activeTerminalIndex >= 0 ? { activeTabIndex: activeTerminalIndex } : {}), panelOpen: terminalPanelOpen };
  const workspaceOptionsSignature = `${persistedFileTabs.map((tab) => tab.path).join("\0")}\n${persistedActiveTab?.path ?? ""}\n${JSON.stringify(javaOptions)}\n${JSON.stringify(terminalOptions)}\n${JSON.stringify(fileColors)}\n${gitCommitMessage}`;
  useEffect(() => {
    if (status !== "connected" || !workspaceOptionsReady || !clientRef.current) return;
    const options: WorkspaceOptions = { openFiles: persistedFileTabs.map((tab) => tab.path), ...(persistedActiveTab ? { activeFile: persistedActiveTab.path } : {}), ...(javaOptions ? { javaProject: javaOptions } : {}), terminal: terminalOptions, ...(Object.keys(fileColors).length ? { fileColors } : {}), ...(gitCommitMessage ? { gitCommitMessage } : {}) };
    void clientRef.current.request("workspace.saveOptions", { options }).catch((error: unknown) => {
      setStatusMessage(error instanceof Error ? error.message : "Could not save workspace options");
    });
  }, [status, workspaceOptionsReady, workspaceOptionsSignature]);

  useEffect(() => setSelectedGitPaths((current) => new Set([...current].filter((path) => gitEntries.some((entry) => entry.path === path)))), [gitEntries]);

  const selectedRollbackEntries = useMemo(() => selectedGitEntries(gitEntries, selectedGitPaths), [gitEntries, selectedGitPaths]);
  const gitOperationRunning = gitCommitting || gitPushing || gitRollingBack;

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
    const tab: EditorTab = { id: crypto.randomUUID(), type: "diff", title: `${entry.path.split("/").pop() ?? entry.path} (Diff)`, path: entry.path, dirty: false, content: "", savedContent: "", originalContent: "", diffMode: "unified", loading: true };
    updateGroup((tabs) => ({ tabs: [...tabs, tab], activeTabId: tab.id }));
    try {
      const result = await clientRef.current!.request("git.diff", { path: entry.path });
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, originalContent: result.originalContent, content: result.modifiedContent, savedContent: result.modifiedContent, loading: false } : item), activeTabId: active }));
    } catch (error) {
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, loading: false, error: error instanceof Error ? error.message : "Could not load diff" } : item), activeTabId: active }));
    }
  };

  const openTaskDiff = async (entry: GitStatusEntry) => {
    const task = tasks.find((item) => item.id === selectedTaskId);
    if (!task) return;
    const tabPath = `task-git:${task.id}:${entry.path}`;
    const existing = group.tabs.find((tab) => tab.type === "diff" && tab.path === tabPath);
    if (existing) { updateGroup((tabs) => ({ tabs, activeTabId: existing.id })); return; }
    const tab: EditorTab = { id: crypto.randomUUID(), type: "diff", title: `${entry.path.split("/").pop() ?? entry.path} (Task Diff)`, path: tabPath, diffRef: task.baseBranch, diffPath: entry.path, ...(entry.originalPath ? { diffOriginalPath: entry.originalPath } : {}), dirty: false, content: "", savedContent: "", originalContent: "", diffMode: "unified", loading: true };
    updateGroup((tabs) => ({ tabs: [...tabs, tab], activeTabId: tab.id }));
    try {
      const result = await clientRef.current!.request("git.compareDiff", { ref: task.baseBranch, path: entry.path, ...(entry.originalPath ? { originalPath: entry.originalPath } : {}) });
      updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, originalContent: result.originalContent, content: result.modifiedContent, savedContent: result.modifiedContent, loading: false } : item), activeTabId: active }));
    } catch (error) { updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, loading: false, error: error instanceof Error ? error.message : "Could not load task diff" } : item), activeTabId: active })); }
  };

  const activateEditorTab = useCallback(async (tab: EditorTab) => {
    updateGroup((tabs) => ({ tabs, activeTabId: tab.id }));
    if (!clientRef.current || tab.loading || tab.dirty) return;
    try {
      if (tab.type === "diff") {
        const result = tab.diffRef
          ? await clientRef.current.request("git.compareDiff", { ref: tab.diffRef, path: tab.diffPath ?? tab.path, ...(tab.diffOriginalPath ? { originalPath: tab.diffOriginalPath } : {}) })
          : await clientRef.current.request("git.diff", { path: tab.path });
        updateGroup((tabs, active) => ({
          tabs: tabs.map((item) => item.id === tab.id && !item.dirty ? { ...item, originalContent: result.originalContent, content: result.modifiedContent, savedContent: result.modifiedContent, error: undefined } : item),
          activeTabId: active
        }));
        return;
      }
      const result = tab.type === "useful" ? await clientRef.current.request("useful.read", { scope: tab.usefulScope!, name: tab.path }) : tab.type === "agent" ? await clientRef.current.request("agents.read", { scope: tab.agentScope!, name: tab.path }) : await clientRef.current.request("filesystem.readFile", { path: tab.path });
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

  const openUsefulFile = async (file: UsefulFile) => {
    const existing = group.tabs.find((tab) => tab.type === "useful" && tab.usefulScope === file.scope && tab.path === file.name);
    if (existing) { await activateEditorTab(existing); return; }
    const tab: EditorTab = { id: crypto.randomUUID(), type: "useful", title: file.name, path: file.name, usefulScope: file.scope, dirty: false, content: "", savedContent: "", loading: true, markdownMode: /\.md$/i.test(file.name) ? "preview" : undefined };
    updateGroup((tabs) => ({ tabs: [...tabs, tab], activeTabId: tab.id }));
    try { const result = await clientRef.current!.request("useful.read", { scope: file.scope, name: file.name }); updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, content: result.content, savedContent: result.content, loading: false } : item), activeTabId: active })); }
    catch (error) { updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, loading: false, error: error instanceof Error ? error.message : "Could not read useful file" } : item), activeTabId: active })); }
  };

  const openAgentFile = async (file: AgentFile) => {
    if (file.scope === "workspace") { await openFile({ name: file.name, path: `.agents/${file.name}`, type: "file" }); return; }
    const existing = group.tabs.find((tab) => tab.type === "agent" && tab.agentScope === file.scope && tab.path === file.name);
    if (existing) { await activateEditorTab(existing); return; }
    const tab: EditorTab = { id: crypto.randomUUID(), type: "agent", title: file.name, path: file.name, agentScope: file.scope, dirty: false, content: "", savedContent: "", loading: true };
    updateGroup((tabs) => ({ tabs: [...tabs, tab], activeTabId: tab.id }));
    try { const result = await clientRef.current!.request("agents.read", { scope: file.scope, name: file.name }); updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, content: result.content, savedContent: result.content, loading: false } : item), activeTabId: active })); }
    catch (error) { updateGroup((tabs, active) => ({ tabs: tabs.map((item) => item.id === tab.id ? { ...item, loading: false, error: error instanceof Error ? error.message : "Could not read agent" } : item), activeTabId: active })); }
  };

  const rollbackFile = async (entry: GitStatusEntry) => {
    setGitRollbackMenu(undefined);
    if (gitOperationRunning || gitRollbackRunningRef.current || !window.confirm(isUntrackedGitEntry(entry) ? `Permanently delete untracked file ${entry.path}? This cannot be undone.` : `Rollback all staged and unstaged changes in ${entry.path} to HEAD? This cannot be undone.`)) return;
    gitRollbackRunningRef.current = true; setGitRollingBack(true);
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
      showStatus(`Rolled back ${entry.path}`, "success");
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not rollback file"); }
    finally { gitRollbackRunningRef.current = false; setGitRollingBack(false); }
  };

  const openRollbackSelected = () => {
    if (gitOperationRunning || selectedRollbackEntries.length === 0) return;
    setGitRollbackDialog(selectedRollbackEntries);
  };

  const rollbackSelected = async (deleteUntracked: boolean) => {
    if (!clientRef.current || !gitRollbackDialog?.length || gitRollbackRunningRef.current || gitCommitting || gitPushing) return;
    gitRollbackRunningRef.current = true;
    setGitRollingBack(true); showStatus(`Rolling back ${gitRollbackDialog.length} selected change${gitRollbackDialog.length === 1 ? "" : "s"}...`, "progress");
    const requestedEntries = gitRollbackDialog;
    try {
      const result = await executeRollbackSelection(requestedEntries, deleteUntracked, (paths, confirmed) => clientRef.current!.request("git.rollbackSelected", { paths, deleteUntracked: confirmed }), async (rollbackResult) => {
        const rolledBack = new Set(rollbackResult.rolledBack);
        const affectedPaths = new Set(requestedEntries.filter((entry) => rolledBack.has(entry.path)).flatMap((entry) => entry.originalPath && (entry.indexStatus === "R" || entry.worktreeStatus === "R") ? [entry.path, entry.originalPath] : [entry.path]));
        const contents = new Map<string, string>();
        await Promise.all([...affectedPaths].map(async (path) => { try { contents.set(path, (await clientRef.current!.request("filesystem.readFile", { path })).content); } catch { /* Deleted and renamed-away paths have no content to refresh. */ } }));
        updateGroup((tabs, active) => {
          const next = tabs.filter((tab) => !affectedPaths.has(tab.path) || (tab.type === "file" && contents.has(tab.path))).map((tab) => affectedPaths.has(tab.path) && tab.type === "file" ? { ...tab, content: contents.get(tab.path)!, savedContent: contents.get(tab.path)!, dirty: false, error: undefined } : tab);
          return { tabs: next, activeTabId: next.some((tab) => tab.id === active) ? active : next.at(-1)?.id };
        });
        await Promise.all([refreshGit(), refreshTaskGit(), refreshTree()]);
      });
      const rolledBack = new Set(result.rolledBack);
      setSelectedGitPaths((current) => new Set([...current].filter((path) => !rolledBack.has(path))));
      setGitRollbackDialog(undefined);
      if (result.failures.length > 0) {
        const detail = result.failures.slice(0, 3).map((failure) => `${failure.path}: ${failure.message}`).join("; ");
        showStatus(`${result.rolledBack.length} rolled back; ${result.failures.length} failed. ${detail}${result.failures.length > 3 ? `; and ${result.failures.length - 3} more` : ""}`, "error");
      } else showStatus(`Rolled back ${result.rolledBack.length} selected change${result.rolledBack.length === 1 ? "" : "s"}`, "success");
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not rollback selected changes"); }
    finally { gitRollbackRunningRef.current = false; setGitRollingBack(false); }
  };

  const commitSelectedFiles = async () => {
    if (!clientRef.current || gitOperationRunning || selectedGitPaths.size === 0 || !gitCommitMessage.trim()) return;
    setGitCommitting(true); showStatus("Committing selected changes...", "progress");
    try {
      await clientRef.current.request("git.commit", { paths: [...selectedGitPaths], message: gitCommitMessage });
      setSelectedGitPaths(new Set());
      await Promise.all([refreshGit(), refreshTaskGit()]);
      showStatus("Changes committed successfully", "success");
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not commit selected files"); }
    finally { setGitCommitting(false); }
  };

  const pushGit = async () => {
    if (!clientRef.current || gitOperationRunning) return;
    setGitPushing(true); showStatus("Pushing changes...", "progress");
    try {
      await clientRef.current.request("git.push", {});
      showStatus("Changes pushed successfully", "success");
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not push"); }
    finally { setGitPushing(false); }
  };

  const openGitHunkDialog = async (path: string, hunk: GitDiffHunk, x: number, y: number) => {
    if (!clientRef.current) return;
    try {
      const result = await clientRef.current.request("git.diff", { path });
      const current = result.hunks.find((item) => item.originalStart === hunk.originalStart && item.modifiedStart === hunk.modifiedStart) ?? hunk;
      setGitHunkDialog({ x: Math.min(x + 8, window.innerWidth - 430), y: Math.min(y, window.innerHeight - 300), path, hunk: current, originalContent: result.originalContent, modifiedContent: result.modifiedContent });
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not load change block"); }
  };

  const rollbackGitHunk = async () => {
    if (!clientRef.current || !gitHunkDialog || !window.confirm(`Rollback this change block in ${gitHunkDialog.path}?`)) return;
    const { path, hunk, originalContent, modifiedContent } = gitHunkDialog;
    const originalLines = originalContent.split("\n").slice(Math.max(0, hunk.originalStart - 1), Math.max(0, hunk.originalStart - 1) + hunk.originalLines);
    const nextLines = modifiedContent.split("\n");
    nextLines.splice(Math.max(0, hunk.modifiedStart - 1), hunk.modifiedLines, ...originalLines);
    const content = nextLines.join("\n");
    try {
      selfWriteUntil.current.set(path, Date.now() + 1500);
      await clientRef.current.request("filesystem.writeFile", { path, content });
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.type === "file" && tab.path === path ? { ...tab, content, savedContent: content, dirty: false, error: undefined } : tab), activeTabId: active }));
      setGitHunkDialog(undefined);
      await Promise.all([refreshGit(), refreshTree()]);
    } catch (error) { setGitHunkDialog((current) => current ? { ...current, error: error instanceof Error ? error.message : "Could not rollback change block" } : current); }
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

  const closeTabs = (tab: EditorTab, mode: "all" | "right") => {
    const tabs = layoutRef.current.editorGroups[0]?.tabs ?? [];
    const index = tabs.findIndex((item) => item.id === tab.id);
    const closing = mode === "all" ? tabs : tabs.slice(index + 1);
    if (closing.some((item) => item.dirty) && !window.confirm(`Close ${closing.length} tab${closing.length === 1 ? "" : "s"} and discard unsaved changes?`)) return;
    const closingIds = new Set(closing.map((item) => item.id));
    updateGroup((current, active) => { const next = current.filter((item) => !closingIds.has(item.id)); return { tabs: next, activeTabId: active && !closingIds.has(active) ? active : next[Math.min(index, next.length - 1)]?.id ?? next.at(-1)?.id }; });
    setTabContextMenu(undefined);
  };

  const openTabInWindow = async (tab: EditorTab) => {
    setTabContextMenu(undefined);
    if (tab.type === "diff" || tab.type === "agent") return;
    if (tab.dirty) await saveFileTab(tab);
    const options = { host, port, type: tab.type, path: tab.path, ...(tab.type === "useful" ? { scope: tab.usefulScope } : {}) } as const;
    if (window.desktop?.openEditorWindow) window.desktop.openEditorWindow(options);
    else {
      const url = new URL(window.location.href); url.search = "";
      url.searchParams.set("detached", "1"); url.searchParams.set("host", host); url.searchParams.set("port", port); url.searchParams.set("type", tab.type); url.searchParams.set("path", tab.path);
      if (tab.type === "useful" && tab.usefulScope) url.searchParams.set("scope", tab.usefulScope);
      window.open(url.toString(), "_blank", "popup,width=1000,height=720");
    }
  };

  const moveTab = (targetId: string) => {
    if (!draggedTabId || draggedTabId === targetId) return;
    updateGroup((tabs, active) => { const source = tabs.findIndex((tab) => tab.id === draggedTabId); const target = tabs.findIndex((tab) => tab.id === targetId); if (source < 0 || target < 0) return { tabs, activeTabId: active }; const next = [...tabs]; const [moved] = next.splice(source, 1); next.splice(target, 0, moved!); return { tabs: next, activeTabId: active }; });
    setDraggedTabId(undefined);
  };

  const saveFileTab = useCallback(async (current: EditorTab) => {
    if ((current.type !== "file" && current.type !== "useful" && current.type !== "agent") || current.loading || current.error || !current.dirty || !clientRef.current) return;
    const content = current.content;
    try {
      selfWriteUntil.current.set(current.path, Date.now() + 1500);
      if (current.type === "useful") await clientRef.current.request("useful.write", { scope: current.usefulScope!, name: current.path, content });
      else if (current.type === "agent") await clientRef.current.request("agents.write", { scope: current.agentScope!, name: current.path, content });
      else await clientRef.current.request("filesystem.writeFile", { path: current.path, content });
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === current.id ? { ...tab, dirty: tab.content !== content, savedContent: content, error: undefined } : tab), activeTabId: active }));
      if (current.type === "agent" || (current.type === "file" && /^\.agents\/[^/]+\.md$/i.test(current.path))) await refreshAgents();
      if (current.type === "file" && /\.java$/i.test(current.path)) scheduleJavaCheck();
    } catch (error) {
      selfWriteUntil.current.delete(current.path);
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === current.id ? { ...tab, error: error instanceof Error ? error.message : "Save failed" } : tab), activeTabId: active }));
    }
  }, [refreshAgents, scheduleJavaCheck, updateGroup]);

  const saveActive = useCallback(async () => {
    const current = layout.editorGroups[0]?.tabs.find((tab) => tab.id === layout.editorGroups[0]?.activeTabId);
    if (current) await saveFileTab(current);
  }, [layout, saveFileTab]);

  // `taskId` is passed explicitly because task switching changes the selected task and the provider
  // in the same pass: reading it from state here would remember the provider under the previous task.
  const switchAiProvider = useCallback(async (provider: AiProvider, taskId = selectedTaskIdRef.current) => {
    if (!clientRef.current) return;
    wsSave("aiProvider", provider);
    wsSave(aiProviderTaskKey(taskId), provider);
    if (provider === aiProviderRef.current) return;
    aiProviderRef.current = provider; setAiProvider(provider);
    const token = aiToken();
    try {
      const [sessionResult, models] = await Promise.all([clientRef.current.request("ai.get", { provider }), clientRef.current.request("ai.models", { provider })]);
      let session = sessionResult.session;
      const workspace = workspaceKeyRef.current;
      const savedModel = workspace ? readSetting(workspaceSettingKey(workspace, `ai.${provider}.model`)) : null;
      const savedReasoning = workspace ? readSetting(workspaceSettingKey(workspace, `ai.${provider}.reasoning`)) : null;
      if (savedModel && models.models.some((model) => model.id === savedModel)) {
        const model = models.models.find((item) => item.id === savedModel)!;
        const reasoning = savedReasoning && model.reasoningLevels.includes(savedReasoning) ? savedReasoning : model.defaultReasoning;
        if (session.model !== savedModel || session.reasoning !== reasoning) session = (await clientRef.current.request("ai.configure", { provider, model: savedModel, reasoning })).session;
      }
      if (!applyAiSession(session, { ...token, provider })) return;
      setAiModels(models.models);
      const usage = (await clientRef.current.request("ai.usage", { provider })).usage;
      if (provider !== aiProviderRef.current) return;
      setAiUsage(usage);
      await refreshAiSessions();
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not switch AI provider"); }
  }, [aiToken, applyAiSession, refreshAiSessions]);

  const switchTask = useCallback(async (taskId?: string) => {
    if (!clientRef.current || taskId === selectedTaskId) return;
    setTaskSwitching(true); setWorkspaceOptionsReady(false); setStatusMessage("");
    try {
      const currentGroup = layoutRef.current.editorGroups[0]!;
      for (const tab of currentGroup.tabs) if (tab.type === "file" && tab.dirty) await saveFileTab(tab);
      const currentFiles = currentGroup.tabs.filter((tab) => tab.type === "file");
      const currentTerminal = layoutRef.current.terminalGroup;
      const currentActiveTerminalIndex = currentTerminal.tabs.findIndex((tab) => tab.id === currentTerminal.activeTabId);
      await clientRef.current.request("workspace.saveOptions", { options: { openFiles: currentFiles.map((tab) => tab.path), ...(currentFiles.find((tab) => tab.id === currentGroup.activeTabId) ? { activeFile: currentFiles.find((tab) => tab.id === currentGroup.activeTabId)!.path } : {}), ...(javaOptionsRef.current ? { javaProject: javaOptionsRef.current } : {}), terminal: { tabs: currentTerminal.tabs.map((tab) => ({ title: tab.title })), ...(currentActiveTerminalIndex >= 0 ? { activeTabIndex: currentActiveTerminalIndex } : {}), panelOpen: layoutRef.current.panels.some((panel) => panel.type === "terminal") }, ...(Object.keys(fileColors).length ? { fileColors } : {}), ...(gitCommitMessage ? { gitCommitMessage } : {}) } });
      const result = await clientRef.current.request("tasks.switch", { ...(taskId ? { taskId } : {}), includeIgnored: showIgnoredRef.current });
      terminalWriters.current.clear(); terminalBuffers.current.clear(); markdownBlockTerminals.current.clear();
      setLayout((current) => ({ ...current, panels: current.panels.filter((panel) => !["terminal", "java", "problems"].includes(panel.type)), terminalGroup: { ...current.terminalGroup, tabs: [], activeTabId: undefined } }));
      setTasks(result.tasks); setSelectedTaskId(result.selectedTaskId); selectedTaskIdRef.current = result.selectedTaskId; activeTaskRef.current = result.tasks.find((task) => task.id === result.selectedTaskId); setTree(result.tree);
      if (!result.selectedTaskId) {
        setRightPanels((current) => ({ ...current, taskGit: false }));
        setClassicSideView((current) => current === "taskGit" ? "project" : current);
      }
      setActiveWorkspace(result.workspace); activeWorkspaceRef.current = result.workspace;
      setProjectName(result.projectName);
      setJavaOptions(result.options.javaProject); setJavaTree([]); setJavaRunning(false); setJavaLog(""); setJavaDiagnostics([]);
      if (result.options.javaProject) setJavaTree((await clientRef.current.request("java.getProjectTree", {})).tree);
      await restoreWorkspaceOptions(result.options, clientRef.current);
      const nextTask = result.tasks.find((task) => task.id === result.selectedTaskId);
      const savedProvider = workspaceKeyRef.current ? (readSetting(workspaceSettingKey(workspaceKeyRef.current, aiProviderTaskKey(result.selectedTaskId))) as AiProvider | null) : null;
      const nextProvider = savedProvider && aiProviders.some((item) => item.id === savedProvider) ? savedProvider : aiProviderRef.current;
      await switchAiProvider(nextProvider, result.selectedTaskId);
      await Promise.all([refreshGit(), refreshAi(), refreshAiSessions(), refreshTaskGit(nextTask), refreshAgents(clientRef.current, result.selectedTaskId)]);
    } catch (error) {
      setWorkspaceOptionsReady(true);
      setStatusMessage(error instanceof Error ? error.message : "Could not switch task");
    } finally { setTaskSwitching(false); }
  }, [aiProviders, fileColors, gitCommitMessage, refreshAgents, refreshAi, refreshAiSessions, refreshGit, refreshTaskGit, restoreWorkspaceOptions, saveFileTab, selectedTaskId, switchAiProvider]);

  const currentAiAttachmentKey = selectedTaskId ?? "root";
  const currentAiAttachments = aiAttachments[currentAiAttachmentKey] ?? [];
  const selectedAgent = useMemo(() => agents.find((agent) => agentKey(agent) === selectedAgentKey), [agents, selectedAgentKey]);
  const selectAgent = useCallback((key: string) => {
    setSelectedAgentKey(key);
    if (workspaceKeyRef.current) writeWorkspaceSetting(workspaceKeyRef.current, aiAgentTaskKey(selectedTaskIdRef.current), key);
  }, []);
  const updateAiAttachments = useCallback((attachments: AiAttachment[]) => setAiAttachments((current) => ({ ...current, [selectedTaskId ?? "root"]: attachments })), [selectedTaskId]);
  const attachWorkspaceFile = useCallback((path: string) => {
    const key = selectedTaskId ?? "root";
    setAiAttachments((current) => {
      const attachments = current[key] ?? [];
      if (attachments.some((item) => item.path === path)) return current;
      return { ...current, [key]: [...attachments, { id: `workspace:${path}`, name: path.split("/").pop() ?? path, path }] };
    });
    if (sideLayout === "classic") setClassicAiOpen(true);
    else setLeftPanels((current) => ({ ...current, ai: true }));
    void refreshAi(); setEditorGitMenu(undefined);
  }, [refreshAi, selectedTaskId, sideLayout]);
  const sendAiPrompt = useCallback(async (prompt: string, configuration: AiConfiguration, attachments: AiAttachment[]) => {
    if (!clientRef.current) return;
    const content = attachments.map((attachment) => attachment.path
      ? { type: "resource_link" as const, uri: `workspace:${attachment.path}`, name: attachment.name }
      : attachment.data && attachment.mimeType
        ? { type: "image" as const, data: attachment.data, mimeType: attachment.mimeType, name: attachment.name }
        : { type: "resource" as const, uri: `attachment:${encodeURIComponent(attachment.name)}`, mimeType: attachment.mimeType, text: attachment.content ?? "", name: attachment.name });
    const token = aiToken();
    try { applyAiSession((await clientRef.current.request("ai.send", { provider: aiProviderRef.current, prompt, content, configuration, ...(selectedAgent ? { agent: selectedAgent.agent } : {}) })).session, token); await Promise.all([refreshAi(), refreshAiSessions()]); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : `Could not start ${aiProviderRef.current}`); throw error; }
  }, [aiToken, applyAiSession, refreshAi, refreshAiSessions, selectedAgent]);
  const sendAiPromptAsTask = useCallback(async (prompt: string, configuration: AiConfiguration, attachments: AiAttachment[]) => {
    if (!clientRef.current || selectedTaskIdRef.current) return;
    const content = attachments.map((attachment) => attachment.path
      ? { type: "resource_link" as const, uri: `workspace:${attachment.path}`, name: attachment.name }
      : attachment.data && attachment.mimeType
        ? { type: "image" as const, data: attachment.data, mimeType: attachment.mimeType, name: attachment.name }
        : { type: "resource" as const, uri: `attachment:${encodeURIComponent(attachment.name)}`, mimeType: attachment.mimeType, text: attachment.content ?? "", name: attachment.name });
    try {
      const { task } = await clientRef.current.request("tasks.createFromPrompt", { provider: aiProviderRef.current, prompt, content, configuration, ...(selectedAgent ? { agent: selectedAgent.agent } : {}) });
      setTasks((current) => [...current, task]);
      await refreshAiStatuses();
      showStatus(`Started ${task.branch}`, "success");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not start a new task");
      throw error;
    }
  }, [refreshAiStatuses, selectedAgent, showStatus]);
  const resolveAiPermission = useCallback(async (requestId: string, optionId?: string) => {
    if (!clientRef.current) return;
    const token = aiToken();
    try { applyAiSession((await clientRef.current.request("ai.permission.resolve", { provider: aiProviderRef.current, requestId, optionId })).session, token); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not resolve permission request"); }
  }, [aiToken, applyAiSession]);
  const steerAiPrompt = useCallback(async (prompt: string) => {
    if (!clientRef.current) return;
    const token = aiToken();
    try { applyAiSession((await clientRef.current.request("ai.steer", { provider: aiProviderRef.current, prompt })).session, token); await refreshAi(); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not add input to the running turn"); throw error; }
  }, [aiToken, applyAiSession, refreshAi]);
  const configureAi = useCallback(async (configuration: AiConfiguration) => {
    if (!clientRef.current) return;
    const token = aiToken();
    try {
      applyAiSession((await clientRef.current.request("ai.configure", { provider: aiProviderRef.current, configuration })).session, token);
      if (typeof configuration.model === "string") wsSave(`ai.${aiProviderRef.current}.model`, configuration.model);
      if (typeof configuration.reasoning === "string") wsSave(`ai.${aiProviderRef.current}.reasoning`, configuration.reasoning);
    }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not save AI settings"); }
  }, [aiToken, applyAiSession]);

  const newAiSession = useCallback(async () => {
    if (!clientRef.current) return;
    const token = aiToken();
    try { applyAiSession((await clientRef.current.request("ai.clear", { provider: aiProviderRef.current })).session, token); await Promise.all([refreshAi(), refreshAiSessions()]); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not start a new AI session"); }
  }, [aiToken, applyAiSession, refreshAi, refreshAiSessions]);

  const switchAiSession = useCallback(async (session: AiSession) => {
    if (!clientRef.current || !session.id) return;
    const token = aiToken();
    try { applyAiSession((await clientRef.current.request("ai.restore", { provider: aiProviderRef.current, sessionId: session.id })).session, token); await Promise.all([refreshAi(), refreshAiSessions()]); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not switch AI session"); }
  }, [aiToken, applyAiSession, refreshAi, refreshAiSessions]);

  const removeAiSession = useCallback(async (session: AiSession) => {
    if (!clientRef.current || !session.id) return;
    const token = aiToken();
    try { applyAiSession((await clientRef.current.request("ai.remove", { provider: aiProviderRef.current, sessionId: session.id })).session, token); await Promise.all([refreshAi(), refreshAiSessions()]); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not remove AI session"); }
  }, [aiToken, applyAiSession, refreshAi, refreshAiSessions]);

  const interruptAi = useCallback(async () => {
    if (!clientRef.current) return;
    const token = aiToken();
    try { applyAiSession((await clientRef.current.request("ai.interrupt", { provider: aiProviderRef.current })).session, token); await refreshAi(); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not stop AI task"); }
  }, [aiToken, applyAiSession, refreshAi]);

  const createTask = useCallback(async (branch: string, existing?: { remote: boolean }) => {
    if (!clientRef.current || taskSwitching) return;
    try {
      setTaskSwitching(true);
      const result = await clientRef.current.request("tasks.create", { branch, existing: Boolean(existing), remote: existing?.remote });
      setTasks((current) => [...current, result.task]);
      setTaskSwitching(false);
      await switchTask(result.task.id);
    } catch (error) {
      setTaskSwitching(false);
      setStatusMessage(error instanceof Error ? error.message : "Could not create task");
      throw error;
    }
  }, [switchTask, taskSwitching]);

  const deleteTask = useCallback(async (task: WorkspaceTask) => {
    if (!clientRef.current || taskSwitching || !window.confirm(`Delete task "${task.name}"?\n\nIts copied workspace and any uncommitted files inside it will be permanently removed.`)) return;
    try {
      if (selectedTaskId === task.id) await switchTask();
      setTaskSwitching(true);
      const result = await clientRef.current.request("tasks.delete", { taskId: task.id });
      setTasks(result.tasks); setSelectedTaskId(result.selectedTaskId);
      setAiAttachments((current) => { const next = { ...current }; delete next[task.id]; return next; });
      setAiStatuses((current) => { aiStatusesApplied.current = aiStatusesRequested.current; const nextTasks = { ...current.tasks }; delete nextTasks[task.id]; return { ...current, tasks: nextTasks }; });
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not delete task"); }
    finally { setTaskSwitching(false); }
  }, [selectedTaskId, switchTask, taskSwitching]);

  const mergeTask = useCallback(async (task: WorkspaceTask, strategy: "merge" | "smart") => {
    if (!clientRef.current || taskSwitching) return;
    setMergeDialog(undefined);
    try {
      setTaskSwitching(true);
      const result = await clientRef.current.request("tasks.merge", { taskId: task.id, strategy });
      setTaskSwitching(false);
      await switchTask();
      showStatus(`Merged ${task.name} into ${result.targetBranch}`, "success");
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not merge task"); }
    finally { setTaskSwitching(false); }
  }, [switchTask, taskSwitching]);

  const saveUsefulFileDialog = async (name: string) => {
    if (!clientRef.current || !usefulDialog) return;
    if (usefulDialog.mode === "create") await clientRef.current.request("useful.create", { scope: usefulDialog.scope, name });
    else {
      const oldName = usefulDialog.file!.name;
      await clientRef.current.request("useful.rename", { scope: usefulDialog.scope, name: oldName, newName: name });
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.type === "useful" && tab.usefulScope === usefulDialog.scope && tab.path === oldName ? { ...tab, path: name, title: name, markdownMode: /\.md$/i.test(name) ? (tab.markdownMode ?? "preview") : undefined } : tab), activeTabId: active }));
    }
    setUsefulDialog(undefined); await refreshUsefulFiles();
  };

  const deleteUsefulFile = async (file: UsefulFile) => {
    if (!clientRef.current || !window.confirm(`Delete ${file.name}? This cannot be undone.`)) return;
    try {
      await clientRef.current.request("useful.delete", file);
      updateGroup((tabs, active) => { const next = tabs.filter((tab) => tab.type !== "useful" || tab.usefulScope !== file.scope || tab.path !== file.name); return { tabs: next, activeTabId: next.some((tab) => tab.id === active) ? active : next.at(-1)?.id }; });
      await refreshUsefulFiles();
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not delete useful file"); }
  };

  const saveAgentDialog = async (name: string) => {
    if (!clientRef.current || !agentDialog) return;
    if (agentDialog.mode === "create") await clientRef.current.request("agents.create", { scope: agentDialog.scope, name });
    else {
      const oldName = agentDialog.file!.name;
      const result = await clientRef.current.request("agents.rename", { scope: agentDialog.scope, name: oldName, newName: name });
      const oldKey = agentKey({ scope: agentDialog.scope, name: oldName });
      const nextKey = agentKey({ scope: agentDialog.scope, name: result.name });
      updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.type === "agent" && tab.agentScope === agentDialog.scope && tab.path === oldName ? { ...tab, path: result.name, title: result.name } : tab), activeTabId: active }));
      if (selectedAgentKey === oldKey) selectAgent(nextKey);
    }
    setAgentDialog(undefined);
    await refreshAgents();
  };

  const deleteAgent = async (file: AgentFile) => {
    if (!clientRef.current || file.scope === "workspace" || !window.confirm(`Delete agent ${file.name}? This cannot be undone.`)) return;
    try {
      await clientRef.current.request("agents.delete", { scope: file.scope, name: file.name });
      updateGroup((tabs, active) => { const next = tabs.filter((tab) => tab.type !== "agent" || tab.agentScope !== file.scope || tab.path !== file.name); return { tabs: next, activeTabId: next.some((tab) => tab.id === active) ? active : next.at(-1)?.id }; });
      if (selectedAgentKey === agentKey(file)) selectAgent("");
      await refreshAgents();
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not delete agent"); }
  };

  useEffect(() => {
    if (status !== "connected") return;
    const dirtyFiles = group.tabs.filter((tab) => (tab.type === "file" || tab.type === "useful" || tab.type === "agent") && tab.dirty && !tab.loading && !tab.error);
    if (dirtyFiles.length === 0) return;
    const timer = setTimeout(() => { for (const tab of dirtyFiles) void saveFileTab(tab); }, 600);
    return () => clearTimeout(timer);
  }, [status, group.tabs, saveFileTab]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveActive(); } };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [saveActive]);

  const refreshTree = async (includeIgnored = showIgnoredRef.current) => {
    try { setTree((await clientRef.current!.request("filesystem.listTree", { includeIgnored })).tree); }
    catch (error) { setStatusMessage(error instanceof Error ? error.message : "Refresh failed"); }
  };

  const toggleShowIgnored = () => {
    const next = !showIgnoredRef.current;
    showIgnoredRef.current = next; setShowIgnored(next);
    writeSetting("showIgnoredFiles", String(next));
    if (clientRef.current) void refreshTree(next);
  };

  const beginLeftSidebarResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setLeftSidebarWidth(Math.max(280, Math.min(Math.min(900, window.innerWidth * 0.65), moveEvent.clientX - 30)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const beginRightSidebarResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setRightSidebarWidth(Math.max(180, Math.min(Math.min(700, window.innerWidth * 0.55), window.innerWidth - moveEvent.clientX - 30)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const beginClassicLeftResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setClassicLeftWidth(Math.max(180, Math.min(500, moveEvent.clientX - 30)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const beginClassicRightResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setClassicRightWidth(Math.max(240, Math.min(Math.min(960, window.innerWidth * 0.72), window.innerWidth - moveEvent.clientX - 30)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const beginClassicSplitResize = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const bounds = panel.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => setClassicSplit(Math.max(20, Math.min(80, ((moveEvent.clientY - bounds.top) / bounds.height) * 100)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };

  const changeSideLayout = (value: "classic" | "ai-focused") => {
    setSideLayout(value);
    writeSetting("sideLayout", value);
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
    const blockId = `${activeTab?.type ?? "markdown"}:${activeTab?.usefulScope ?? "workspace"}:${activeTab?.path ?? "markdown"}:${node?.position?.start?.line ?? command}`;
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
      setJavaOptions(result.options); javaOptionsRef.current = result.options; setJavaTree(result.tree);
      if (sideLayout === "classic") setClassicSideView("java"); else setRightPanels((current) => ({ ...current, java: true }));
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not load Maven project"); }
  };

  const addJavaSourceRoot = async (sourcePath: string) => {
    setTreeContextMenu(undefined);
    try {
      const result = await clientRef.current!.request("java.addSourceRoot", { path: sourcePath });
      setJavaOptions(result.options); javaOptionsRef.current = result.options; setJavaTree(result.tree);
      if (sideLayout === "classic") setClassicSideView("java"); else setRightPanels((current) => ({ ...current, java: true }));
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
    if (activeTab?.type !== "file" || !clientRef.current || !gitEntries.some((entry) => entry.path === activeTab.path)) { setActiveGitHunks([]); return; }
    let current = true;
    void clientRef.current.request("git.diff", { path: activeTab.path }).then((result) => { if (current) setActiveGitHunks(result.hunks); }).catch(() => { if (current) setActiveGitHunks([]); });
    return () => { current = false; };
  }, [activeTab?.path, activeTab?.type, gitEntries]);

  useEffect(() => {
    const instance = monacoEditorRef.current;
    if (!instance || activeTab?.type !== "file") return;
    gitDecorationsRef.current = instance.deltaDecorations(gitDecorationsRef.current, gitHunkDecorations(activeGitHunks));
  }, [activeGitHunks, activeTab?.path, activeTab?.type]);

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

  const runHttpRequest = async (request: ParsedHttpRequest) => {
    if (!clientRef.current) return;
    setHttpResult({ request, loading: true });
    try { setHttpResult({ request, response: await clientRef.current.request("http.execute", request), loading: false }); }
    catch (error) { setHttpResult({ request, error: error instanceof Error ? error.message : "HTTP request failed", loading: false }); }
  };

  const mountEditor = (instance: editor.IStandaloneCodeEditor, api: Monaco) => {
    monacoEditorRef.current = instance;
    monacoRef.current = api;
    gitDecorationsRef.current = instance.deltaDecorations([], gitHunkDecorations(activeTab?.type === "file" ? activeGitHunksRef.current : []));
    for (const disposable of javaLanguageDisposables.current) disposable.dispose();
    javaLanguageDisposables.current = [];
    if (activeTab?.type !== "file" && activeTab?.type !== "useful" && activeTab?.type !== "agent") return;
    const filePath = activeTab.path;
    if (activeTab.type === "file") javaLanguageDisposables.current.push(instance.onContextMenu((event) => {
      event.event.preventDefault();
      const selection = instance.getSelection();
      const hasSelection = Boolean(selection && !selection.isEmpty());
      setEditorGitMenu({ x: Math.min(event.event.posx, window.innerWidth - 245), y: Math.min(event.event.posy, window.innerHeight - 85), path: filePath, ...(hasSelection ? { startLine: selection!.startLineNumber, endLine: selection!.endLineNumber } : {}) });
    }));
    if (activeTab.type === "file") javaLanguageDisposables.current.push(instance.onMouseDown((event) => {
      const element = event.target.element as HTMLElement | null;
      if (!element?.closest(".git-change-marker")) return;
      const line = event.target.position?.lineNumber ?? event.target.range?.startLineNumber;
      const hunk = line ? activeGitHunksRef.current.find((item) => line >= Math.max(1, item.modifiedStart) && line <= Math.max(1, item.modifiedStart) + Math.max(1, item.modifiedLines) - 1) : undefined;
      const entry = gitEntries.find((item) => item.path === filePath);
      if (!hunk || !entry) return;
      void openGitHunkDialog(filePath, hunk, event.event.posx, event.event.posy);
    }));
    if (/\.http$/i.test(filePath)) {
      let decorations: string[] = [];
      const decorate = () => { decorations = instance.deltaDecorations(decorations, parseHttpRequests(instance.getValue()).map((request) => ({ range: { startLineNumber: request.line, startColumn: 1, endLineNumber: request.line, endColumn: 1 }, options: { glyphMarginClassName: "http-run-marker", glyphMarginHoverMessage: { value: `Run ${request.method} ${request.url}` } } }))); };
      decorate(); javaLanguageDisposables.current.push(instance.onDidChangeModelContent(decorate));
      javaLanguageDisposables.current.push(instance.onMouseDown((event) => { if (!(event.target.element as HTMLElement | null)?.closest(".http-run-marker")) return; const line = event.target.position?.lineNumber ?? event.target.range?.startLineNumber; const request = parseHttpRequests(instance.getValue()).find((item) => item.line === line); if (request) void runHttpRequest(request); }));
      return;
    }
    if (activeTab.type !== "file") return;
    if (!/\.java$/i.test(filePath)) return;
    let semanticDecorations: string[] = []; let semanticTimer: ReturnType<typeof setTimeout> | undefined;
    const decorateJavaTypes = async () => {
      if (!clientRef.current || highlightTheme !== "ftpud") { semanticDecorations = instance.deltaDecorations(semanticDecorations, []); return; }
      try {
        const result = await clientRef.current.request("java.semanticTokens", { path: filePath, content: instance.getValue() });
        semanticDecorations = instance.deltaDecorations(semanticDecorations, result.tokens.flatMap((token) => {
          const constant = (token.modifiers.includes("readonly") || token.type === "enumMember") && (token.modifiers.includes("static") || token.type === "enumMember");
          const kind = constant ? "constant" : token.type === "interface" ? "interface" : ["class", "type", "enum", "struct"].includes(token.type) ? "class" : token.type === "decorator" ? "annotation" : undefined;
          return kind ? [{ range: { startLineNumber: token.startLine, startColumn: token.startColumn, endLineNumber: token.endLine, endColumn: token.endColumn }, options: { inlineClassName: `ftpud-java-${kind}`, inlineClassNameAffectsLetterSpacing: false } }] : [];
        }));
      } catch { semanticDecorations = instance.deltaDecorations(semanticDecorations, []); }
    };
    void decorateJavaTypes();
    javaLanguageDisposables.current.push(instance.onDidChangeModelContent(() => { if (semanticTimer) clearTimeout(semanticTimer); semanticTimer = setTimeout(() => void decorateJavaTypes(), 500); }));
    javaLanguageDisposables.current.push({ dispose: () => { if (semanticTimer) clearTimeout(semanticTimer); } });
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
      if ((event.target.element as HTMLElement | null)?.closest(".git-change-marker")) return;
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
    monacoDiffEditorRef.current = instance;
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

  const loadBranchMenu = async () => {
    setBranchMenu({ branches: [], loading: true });
    try { setBranchMenu({ branches: (await clientRef.current!.request("git.branches", {})).branches, loading: false }); }
    catch (error) { setBranchMenu(undefined); setStatusMessage(error instanceof Error ? error.message : "Could not load branches"); }
  };

  const toggleBranchMenu = async () => {
    if (branchMenu) { setBranchMenu(undefined); return; }
    await loadBranchMenu();
  };

  const checkoutBranch = async (branch: GitBranchInfo) => {
    if (!clientRef.current || branch.current) return;
    try {
      const result = await clientRef.current.request("git.checkoutBranch", { branch: branch.name, ...(branch.remote ? { remote: true } : {}) });
      setGitBranch(result.branch); setBranchMenu(undefined);
      await Promise.all([refreshGit(), refreshTree()]);
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not checkout branch"); }
  };

  const renameBranch = async (branch: GitBranchInfo) => {
    const newName = window.prompt(`Rename branch ${branch.name} to:`, branch.name);
    if (!clientRef.current || !newName?.trim() || newName.trim() === branch.name) return;
    try {
      const result = await clientRef.current.request("git.renameBranch", { branch: branch.name, newName: newName.trim() });
      setGitBranch(result.branch); setBranchMenu(undefined); await refreshGit();
    } catch (error) { setStatusMessage(error instanceof Error ? error.message : "Could not rename branch"); }
  };

  const editorFontFamily = uiFontFamily === "jetbrains" ? "JetBrains Mono Variable" : "Inter Variable";
  const editorLineHeight = Math.round(uiFontSize * uiLineHeight);
  const filteredTree = useMemo(() => filterFileTree(tree, projectFilter), [projectFilter, tree]);
  const normalizedTaskFilter = taskFilter.trim().toLowerCase();
  const filteredTasks = useMemo(() => normalizedTaskFilter ? tasks.filter((task) => {
    const summary = aiStatuses.tasks[task.id] ?? emptyAiSummary;
    return `${task.name} ${summary.status} ${summary.preview}`.toLowerCase().includes(normalizedTaskFilter);
  }) : tasks, [aiStatuses.tasks, normalizedTaskFilter, tasks]);
  const showRootTask = !normalizedTaskFilter || `root workspace ${aiStatuses.root.status} ${aiStatuses.root.preview}`.toLowerCase().includes(normalizedTaskFilter);
  const rightSidebarOpen = rightPanels.project || rightPanels.git || rightPanels.useful || rightPanels.agents || (rightPanels.taskGit && Boolean(selectedTaskId)) || (rightPanels.java && Boolean(javaOptions));

  if (status !== "connected") return <ConnectionScreen {...{ host, port, status, statusMessage, setHost, setPort, connect }} />;

  return <div className="ide-shell">
    {statusMessage && <div className={`status-toast ${statusKind}`} role={statusKind === "error" ? "alert" : "status"} aria-live={statusKind === "error" ? "assertive" : "polite"}>
      {statusKind === "progress" ? <LoaderCircle className="status-toast-spinner" size={16} /> : statusKind === "success" ? <Check size={16} /> : <CircleAlert size={16} />}
      <span>{statusMessage}</span>
      {statusKind !== "progress" && <button title="Dismiss" aria-label="Dismiss status message" onClick={() => setStatusMessageState("")}><X size={14} /></button>}
    </div>}
    <div className="workspace-row">
      {sideLayout === "ai-focused" ? <>
      <nav className="tool-stripe" aria-label="Left tool windows">
        <button className={`tool-stripe-button ${leftPanels.tasks ? "active" : ""}`} title={leftPanels.tasks ? "Hide Tasks" : "Show Tasks"} onClick={() => setLeftPanels((current) => ({ ...current, tasks: !current.tasks }))}><ListTodo size={15} /><span>Tasks</span>{tasks.length > 0 && <span className="tool-badge">{tasks.length > 99 ? "99+" : tasks.length}</span>}</button>
        <button className={`tool-stripe-button ${leftPanels.ai ? "active" : ""}`} title={leftPanels.ai ? "Hide AI" : "Show AI"} onClick={() => setLeftPanels((current) => { if (!current.ai) void refreshAi(); return { ...current, ai: !current.ai }; })}><Bot size={15} /><span>AI</span>{aiSession.status === "in_progress" && <span className="tool-badge">...</span>}</button>
      </nav>
      {(leftPanels.tasks || leftPanels.ai) && <><aside className="side-panel side-panel-left" style={{ width: leftSidebarWidth }}><ResizablePanelStack workspace={activeWorkspace} setting="focused.leftSizes" ids={[...(leftPanels.tasks ? ["tasks"] : []), ...(leftPanels.ai ? ["ai"] : [])]}>
        {leftPanels.tasks && <section key="tasks" className="stacked-panel"><header className="panel-header"><span>Tasks</span><button title="Create task" disabled={taskSwitching} onClick={() => setShowCreateTaskDialog(true)}><Plus size={15} /></button></header><QuickFilter value={taskFilter} placeholder="Filter tasks" label="Filter tasks" onChange={setTaskFilter} /><div className="tasks-list">
          {showRootTask && <TaskRow icon={<Folder size={15} />} name="Root workspace" summary={aiStatuses.root} selected={selectedTaskId === undefined} disabled={taskSwitching} onClick={() => void switchTask()} />}
          {filteredTasks.map((task) => <TaskRow key={task.id} icon={<ListTodo size={15} />} name={task.name} summary={aiStatuses.tasks[task.id] ?? emptyAiSummary} selected={selectedTaskId === task.id} disabled={taskSwitching} onClick={() => void switchTask(task.id)} onMerge={() => setMergeDialog(task)} onDelete={() => void deleteTask(task)} />)}
          {!showRootTask && filteredTasks.length === 0 && <div className="filter-empty">No matching tasks</div>}
        </div></section>}
        {leftPanels.ai && <section key="ai" className="stacked-panel"><header className="panel-header"><span>AI</span><AgentPicker agents={agents} value={selectedAgentKey} disabled={aiSession.status === "in_progress"} onChange={selectAgent} /><span className={`ai-status ${aiSession.status}`}>{formatAiStatus(aiSession.status)}</span></header><AiPanel key={`${activeWorkspace}:${aiProvider}:${aiSession.id ?? "legacy"}`} provider={aiProvider} providers={aiProviders} session={aiSession} sessions={aiSessions} models={aiModels} usage={aiUsage} attachments={currentAiAttachments} onProviderChange={(provider) => void switchAiProvider(provider)} onConfigurationChange={configureAi} onAttachmentsChange={updateAiAttachments} onSend={sendAiPrompt} onSendAsTask={selectedTaskId ? undefined : sendAiPromptAsTask} onSteer={steerAiPrompt} onInterrupt={() => void interruptAi()} onNewSession={() => void newAiSession()} onSwitchSession={(session) => void switchAiSession(session)} onRemoveSession={(session) => void removeAiSession(session)} onResolvePermission={(requestId, optionId) => void resolveAiPermission(requestId, optionId)} /></section>}
      </ResizablePanelStack></aside><div className="resize-handle" onPointerDown={beginLeftSidebarResize} /></>}
      </> : <>
      <nav className="tool-stripe" aria-label="Left tool windows">
        <button className={`tool-stripe-button ${classicSideView === "project" ? "active" : ""}`} title="Project" onClick={() => setClassicSideView("project")}><Folder size={15} /><span>Project</span></button>
        <button className={`tool-stripe-button ${classicSideView === "git" ? "active" : ""}`} title="Git changes" onClick={() => { setClassicSideView("git"); void refreshGit(); }}><GitBranch size={15} /><span>Git</span>{gitEntries.length > 0 && <span className="tool-badge">{gitEntries.length > 99 ? "99+" : gitEntries.length}</span>}</button>
        {selectedTaskId && <button className={`tool-stripe-button ${classicSideView === "taskGit" ? "active" : ""}`} title="Changes from task base branch" onClick={() => { setClassicSideView("taskGit"); void refreshTaskGit(); }}><GitCompareArrows size={15} /><span>Task Git</span>{taskGitEntries.length > 0 && <span className="tool-badge">{taskGitEntries.length > 99 ? "99+" : taskGitEntries.length}</span>}</button>}
        <button className={`tool-stripe-button ${classicSideView === "useful" ? "active" : ""}`} title="Useful Files" onClick={() => { setClassicSideView("useful"); void refreshUsefulFiles(); }}><Library size={15} /><span>Useful</span></button>
        <button className={`tool-stripe-button ${classicSideView === "agents" ? "active" : ""}`} title="Agents" onClick={() => { setClassicSideView("agents"); void refreshAgents(); }}><Bot size={15} /><span>Agents</span></button>
        {javaOptions && <button className={`tool-stripe-button ${classicSideView === "java" ? "active" : ""}`} title="Java project" onClick={() => { setClassicSideView("java"); void refreshJavaTree(); }}><Coffee size={15} /><span>Java</span></button>}
      </nav>
      <aside className="side-panel classic-left-panel" style={{ width: classicLeftWidth }}>
        {classicSideView === "project" ? <>
          <header className="panel-header"><span>Project</span><div className="panel-header-actions"><button title={showIgnored ? "Hide ignored files" : "Show all files (including Git-ignored)"} className={showIgnored ? "active" : ""} onClick={toggleShowIgnored}>{showIgnored ? <Eye size={14} /> : <EyeOff size={14} />}</button><button title="Synchronize files" onClick={() => void refreshTree()}><RefreshCw size={14} /></button></div></header>
          <QuickFilter value={projectFilter} placeholder="Filter files" label="Filter project files" onChange={setProjectFilter} />
          <div className="workspace-name" onContextMenu={(event) => { event.preventDefault(); setTreeContextMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 110), node: { name: "REMOTE WORKSPACE", path: "", type: "directory" } }); }}><ChevronDown size={13} />REMOTE WORKSPACE</div>
          <div className="tree">{filteredTree.length > 0 ? <Tree nodes={filteredTree} activePath={activeTab?.path} fileColors={fileColors} gitStatuses={projectGitStatuses} expandAll={Boolean(projectFilter.trim())} onOpen={openFile} onContextMenu={(event, node) => { event.preventDefault(); setTreeContextMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 110), node }); }} /> : <div className="filter-empty">No matching files</div>}</div>
        </> : classicSideView === "git" ? <>
          <header className="panel-header"><span>Git Changes</span><GitToolbarActions selectedCount={selectedRollbackEntries.length} operationRunning={gitOperationRunning} pushing={gitPushing} rollingBack={gitRollingBack} onRollbackSelected={openRollbackSelected} onPush={() => void pushGit()} onRefresh={() => void refreshGit()} /></header><div className="git-branch"><GitBranch size={13} /><span>{gitBranch}</span></div>
          <GitChangesView entries={gitEntries} error={gitError} selectedPaths={selectedGitPaths} onTogglePath={(path) => setSelectedGitPaths((current) => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; })} activePath={activeTab?.path} onOpenDiff={openDiff} onOpenFile={(entry) => void openFile({ name: entry.path.split("/").pop() ?? entry.path, path: entry.path, type: "file" })} onContextMenu={(event, entry) => { event.preventDefault(); setGitRollbackMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 50), entry }); }} />
          <form className="git-commit-panel" onSubmit={(event) => { event.preventDefault(); void commitSelectedFiles(); }}><textarea aria-label="Commit message" placeholder="Commit message" value={gitCommitMessage} disabled={gitOperationRunning} onChange={(event) => setGitCommitMessage(event.target.value)} /><footer><span>{selectedGitPaths.size} selected</span><button disabled={gitOperationRunning || selectedGitPaths.size === 0 || !gitCommitMessage.trim()}>{gitCommitting ? "Committing..." : "Commit"}</button></footer></form>
        </> : classicSideView === "taskGit" && selectedTaskId ? <><header className="panel-header"><span>Task Git</span><button title="Refresh task comparison" onClick={() => void refreshTaskGit()}><RefreshCw size={14} /></button></header><div className="git-branch"><GitCompareArrows size={13} /><span>{tasks.find((task) => task.id === selectedTaskId)?.baseBranch ?? "Base branch"}</span></div><GitChangesView entries={taskGitEntries} error={taskGitError} emptyMessage="No changes from base branch" groupTitle="Changes from Base" activePath={activeTab?.path} onOpenDiff={openTaskDiff} onOpenFile={(entry) => void openFile({ name: entry.path.split("/").pop() ?? entry.path, path: entry.path, type: "file" })} /></> : classicSideView === "useful" ? <><header className="panel-header"><span>Useful Files</span><button title="Refresh useful files" onClick={() => void refreshUsefulFiles()}><RefreshCw size={14} /></button></header><div className="useful-files-list"><UsefulFileSection title="Global" scope="global" files={usefulFiles} activeTab={activeTab} onOpen={openUsefulFile} onCreate={(scope) => setUsefulDialog({ mode: "create", scope })} onRename={(file) => setUsefulDialog({ mode: "rename", scope: file.scope, file })} onDelete={(file) => void deleteUsefulFile(file)} /><UsefulFileSection title="Local" scope="local" files={usefulFiles} activeTab={activeTab} onOpen={openUsefulFile} onCreate={(scope) => setUsefulDialog({ mode: "create", scope })} onRename={(file) => setUsefulDialog({ mode: "rename", scope: file.scope, file })} onDelete={(file) => void deleteUsefulFile(file)} /></div></> : classicSideView === "agents" ? <AgentsPanel agents={agents} activeTab={activeTab} onRefresh={() => void refreshAgents()} onOpen={(file) => void openAgentFile(file)} onCreate={(scope) => setAgentDialog({ mode: "create", scope })} onRename={(file) => { if (file.scope !== "workspace") setAgentDialog({ mode: "rename", scope: file.scope, file }); }} onDelete={(file) => void deleteAgent(file)} /> : <><header className="panel-header"><span>Java Project</span><button title="Refresh Java project" onClick={() => void refreshJavaTree()}><RefreshCw size={14} /></button></header><div className="java-project-meta"><Coffee size={13} /><span>{javaOptions?.pomPath}</span></div><div className="tree java-tree">{javaOptions && <JavaProjectTree nodes={javaTree} activePath={activeTab?.path} onOpen={openFile} />}</div></>}
      </aside><div className="resize-handle" onPointerDown={beginClassicLeftResize} />
      </>}
      <main className="workbench">
        <div className="titlebar-actions">
          <div className="branch-selector"><button className="branch-selector-button" title="Git branches" onClick={() => void toggleBranchMenu()}><GitBranch size={14} /><span>{gitBranch}</span><ChevronDown size={12} /></button>{branchMenu && <div className="branch-menu"><header><span>Git Branches</span><button title="Refresh branches" onClick={() => void loadBranchMenu()}><RefreshCw size={13} /></button></header>{branchMenu.loading ? <div className="branch-menu-empty">Loading branches...</div> : <div className="branch-groups"><BranchSelectorGroup title="Local" branches={branchMenu.branches.filter((branch) => !branch.remote)} selected={branchMenu.selected} onSelect={(name) => setBranchMenu((current) => current ? { ...current, selected: current.selected === name ? undefined : name } : current)} onCheckout={checkoutBranch} onRename={renameBranch} /><BranchSelectorGroup title="Remote" branches={branchMenu.branches.filter((branch) => branch.remote)} selected={branchMenu.selected} onSelect={(name) => setBranchMenu((current) => current ? { ...current, selected: current.selected === name ? undefined : name } : current)} onCheckout={checkoutBranch} onRename={renameBranch} /></div>}</div>}</div>
          {javaOptions && <div className="top-java-run">
            <button title="Run selected Java configuration" disabled={javaRunning || !javaOptions.selectedRunConfigurationId} onClick={() => void runJavaAction("java.run")}><Play size={14} /></button>
            <button title="Debug selected Java configuration" disabled={javaRunning || !javaOptions.selectedRunConfigurationId} onClick={() => void debugJava()}><Bug size={14} /></button>
            <button title="Stop Java process" disabled={!javaRunning} onClick={() => void stopJava()}><Square size={13} /></button>
            <select aria-label="Java run configuration" value={javaOptions.selectedRunConfigurationId ?? ""} onChange={(event) => event.target.value === "__create__" ? setShowRunConfigurationDialog(true) : void selectRunConfiguration(event.target.value)}><option value="" disabled>Select run configuration</option>{javaOptions.runConfigurations.map((configuration) => <option key={configuration.id} value={configuration.id}>{configuration.name}</option>)}<option value="__create__">Create new...</option></select>
          </div>}
          <span className="connection-dot" />{host}:{port}<div className="settings-anchor"><button title="Settings" onClick={() => setSettingsOpen((open) => !open)}><Settings size={15} /></button>{settingsOpen && <div className="settings-menu"><header>Settings</header><div className="settings-row"><span>Layout</span><div className="theme-switch"><button className={sideLayout === "classic" ? "active" : ""} onClick={() => changeSideLayout("classic")}>Classic</button><button className={sideLayout === "ai-focused" ? "active" : ""} onClick={() => changeSideLayout("ai-focused")}>AI focused</button></div></div><div className="settings-row"><span>Theme</span><div className="theme-switch"><button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>Dark</button><button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>Light</button></div></div><div className="settings-row"><span>Highlighting</span><div className="theme-switch"><button className={highlightTheme === "default" ? "active" : ""} onClick={() => setHighlightTheme("default")}>Default</button><button className={highlightTheme === "ftpud" ? "active" : ""} onClick={() => setHighlightTheme("ftpud")}>Ftpud</button></div></div><div className="settings-row font-setting"><label htmlFor="ui-font-family">Font</label><select id="ui-font-family" value={uiFontFamily} onChange={(event) => setUiFontFamily(event.target.value as "jetbrains" | "inter")}><option value="jetbrains">JetBrains Mono</option><option value="inter">Inter</option></select></div><div className="settings-row font-setting"><label htmlFor="ui-font-size">Size</label><input id="ui-font-size" type="number" min="10" max="20" step="1" value={uiFontSize} onChange={(event) => setUiFontSize(Math.min(20, Math.max(10, Number(event.target.value) || 13)))} /></div><div className="settings-row font-setting"><label htmlFor="ui-line-height">Line height</label><input id="ui-line-height" type="number" min="1" max="2" step="0.05" value={uiLineHeight} onChange={(event) => setUiLineHeight(Math.min(2, Math.max(1, Number(event.target.value) || 1.2)))} /></div></div>}</div><button title="Disconnect" onClick={disconnect}><LogOut size={15} /></button>
        </div>
        <div className="tabs" role="tablist">
          {group.tabs.map((tab) => <button className={`tab ${tab.id === group.activeTabId ? "active" : ""} ${tab.id === draggedTabId ? "dragging" : ""}`} key={tab.id} draggable onDragStart={(event) => { setDraggedTabId(tab.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.id); }} onDragEnd={() => setDraggedTabId(undefined)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); moveTab(tab.id); }} onContextMenu={(event) => { event.preventDefault(); setTabContextMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 125), tab }); }} onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab); } }} onClick={() => void activateEditorTab(tab)}>
            {tab.type === "diff" ? <GitCompareArrows size={14} /> : <File size={14} />}<span className={tab.type === "file" && projectGitStatuses[tab.path] ? `tab-file-name git-${projectGitStatuses[tab.path] === "C" ? "created" : "modified"}` : "tab-file-name"}>{tab.title}</span>{tab.dirty && <span className="dirty" title="Unsaved changes" />}<span className="close" title={`Close ${tab.title}`} onClick={(event) => { event.stopPropagation(); closeTab(tab); }}><X size={13} /></span>
          </button>)}
          <div className="tab-spacer" />
          {activeTab?.type === "diff" && <div className="editor-mode-switch" aria-label="Diff layout">
            <button className={activeTab.diffMode === "split" ? "active" : ""} title="Side-by-side diff" onClick={() => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, diffMode: "split" } : tab), activeTabId: active }))}><Columns2 size={14} /></button>
            <button className={activeTab.diffMode !== "split" ? "active" : ""} title="Unified diff" onClick={() => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, diffMode: "unified" } : tab), activeTabId: active }))}><ListTree size={14} /></button>
          </div>}
          {(activeTab?.type === "file" || activeTab?.type === "useful") && /\.md$/i.test(activeTab.path) && <div className="editor-mode-switch" aria-label="Markdown mode">
            <button className={activeTab.markdownMode !== "preview" ? "active" : ""} title="Edit Markdown" onClick={() => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, markdownMode: "edit" } : tab), activeTabId: active }))}><Pencil size={14} /></button>
            <button className={activeTab.markdownMode === "preview" ? "active" : ""} title="Preview Markdown" onClick={() => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, markdownMode: "preview" } : tab), activeTabId: active }))}><Eye size={14} /></button>
          </div>}
          <button className="save-button" title="Save active file" disabled={(activeTab?.type !== "file" && activeTab?.type !== "useful" && activeTab?.type !== "agent") || !activeTab.dirty} onClick={() => void saveActive()}><Save size={15} /></button>
        </div>
        <div className="editor-area" key={`editor-area:${highlightTheme}`} onContextMenu={(event) => {
          if (activeTab?.type !== "file" || activeTab.markdownMode === "preview") return;
          event.preventDefault();
          const selection = monacoEditorRef.current?.getSelection();
          const hasSelection = Boolean(selection && !selection.isEmpty());
          setEditorGitMenu({ x: Math.min(event.clientX, window.innerWidth - 245), y: Math.min(event.clientY, window.innerHeight - 85), path: activeTab.path, ...(hasSelection ? { startLine: selection!.startLineNumber, endLine: selection!.endLineNumber } : {}) });
        }}>
          {!activeTab ? <div className="empty-editor">Open a file from Project</div> : activeTab.loading ? <div className="empty-editor">Loading {activeTab.title}...</div> : activeTab.error && !activeTab.content ? <div className="editor-error">{activeTab.error}</div> : <>
            {activeTab.error && <div className="inline-error">{activeTab.error}</div>}
            {activeTab.type === "diff" ? <><DiffEditor key={`${activeTab.id}:${activeTab.diffMode ?? "unified"}`} original={activeTab.originalContent ?? ""} modified={activeTab.content} language={languageByExtension[activeTab.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} beforeMount={configureMonacoThemes} theme={monacoTheme(theme, highlightTheme)} onMount={mountWorkingDiff} options={{ automaticLayout: true, readOnly: false, originalEditable: false, renderMarginRevertIcon: true, renderSideBySide: activeTab.diffMode === "split", useInlineViewWhenSpaceIsLimited: false, minimap: { enabled: false }, fontFamily: editorFontFamily, fontSize: uiFontSize, lineHeight: editorLineHeight, scrollBeyondLastLine: false }} /><div className="diff-navigation" aria-label="Diff navigation"><button title="Previous change" aria-label="Previous change" onClick={() => monacoDiffEditorRef.current?.goToDiff("previous")}><ChevronUp size={16} /></button><button title="Next change" aria-label="Next change" onClick={() => monacoDiffEditorRef.current?.goToDiff("next")}><ChevronDown size={16} /></button></div></> : activeTab.markdownMode === "preview" ? <div className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: renderMarkdownPre }}>{activeTab.content}</ReactMarkdown></div> : <Editor key={`${activeTab.type}:${activeTab.usefulScope ?? activeTab.agentScope ?? "workspace"}:${activeTab.path}`} path={activeTab.type === "useful" ? `useful-${activeTab.usefulScope}/${activeTab.path}` : activeTab.type === "agent" ? `agent-${activeTab.agentScope}/${activeTab.path}` : activeTab.path} language={languageByExtension[activeTab.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} value={activeTab.content} beforeMount={configureMonacoThemes} theme={monacoTheme(theme, highlightTheme)} onMount={mountEditor} options={{ automaticLayout: true, contextmenu: false, minimap: { enabled: false }, glyphMargin: activeTab.type === "file" || /\.http$/i.test(activeTab.path), fontFamily: editorFontFamily, fontSize: uiFontSize, lineHeight: editorLineHeight, scrollBeyondLastLine: false, padding: { top: 10 } }} onChange={(value) => updateGroup((tabs, active) => ({ tabs: tabs.map((tab) => tab.id === activeTab.id ? { ...tab, content: value ?? "", dirty: (value ?? "") !== tab.savedContent, error: undefined } : tab), activeTabId: active }))} />}
          </>}
        </div>
        {httpResult && <section className="http-response-panel"><header><span>{httpResult.request.method} {httpResult.request.url}</span>{httpResult.loading ? <small>Sending...</small> : httpResult.response ? <small className={httpResult.response.status >= 400 ? "error" : "success"}>{httpResult.response.status} {httpResult.response.statusText} · {httpResult.response.durationMs} ms</small> : null}<button title="Close response" onClick={() => setHttpResult(undefined)}><X size={14} /></button></header>{httpResult.error ? <div className="http-response-error">{httpResult.error}</div> : httpResult.response ? <div className="http-response-content"><pre className="http-response-headers">{Object.entries(httpResult.response.headers).map(([name, value]) => `${name}: ${value}`).join("\n")}</pre><pre className="http-response-body">{httpResult.response.body}</pre></div> : <div className="http-response-loading">Waiting for response...</div>}</section>}
      </main>
      {sideLayout === "ai-focused" ? <>
      {rightSidebarOpen && <><div className="right-resize-handle" onPointerDown={beginRightSidebarResize} />
      <aside className="side-panel side-panel-right" style={{ width: rightSidebarWidth }}><ResizablePanelStack workspace={activeWorkspace} setting="focused.rightSizes" ids={[...(rightPanels.project ? ["project"] : []), ...(rightPanels.git ? ["git"] : []), ...(rightPanels.taskGit && selectedTaskId ? ["taskGit"] : []), ...(rightPanels.java && javaOptions ? ["java"] : []), ...(rightPanels.useful ? ["useful"] : []), ...(rightPanels.agents ? ["agents"] : [])]}>
        {rightPanels.project && <section key="project" className="stacked-panel">
          <header className="panel-header"><span>Project</span><div className="panel-header-actions"><button title={showIgnored ? "Hide ignored files" : "Show all files (including Git-ignored)"} className={showIgnored ? "active" : ""} onClick={toggleShowIgnored}>{showIgnored ? <Eye size={14} /> : <EyeOff size={14} />}</button><button title="Synchronize files" onClick={() => void refreshTree()}><RefreshCw size={14} /></button></div></header>
          <QuickFilter value={projectFilter} placeholder="Filter files" label="Filter project files" onChange={setProjectFilter} />
          <div className="workspace-name" onContextMenu={(event) => { event.preventDefault(); setTreeContextMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 110), node: { name: "REMOTE WORKSPACE", path: "", type: "directory" } }); }}><ChevronDown size={13} />REMOTE WORKSPACE</div>
          <div className="tree">{filteredTree.length > 0 ? <Tree nodes={filteredTree} activePath={activeTab?.path} fileColors={fileColors} gitStatuses={projectGitStatuses} expandAll={Boolean(projectFilter.trim())} onOpen={openFile} onContextMenu={(event, node) => { event.preventDefault(); setTreeContextMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 110), node }); }} /> : <div className="filter-empty">No matching files</div>}</div>
        </section>}
        {rightPanels.git && <section key="git" className="stacked-panel">
          <header className="panel-header"><span>Git Changes</span><GitToolbarActions selectedCount={selectedRollbackEntries.length} operationRunning={gitOperationRunning} pushing={gitPushing} rollingBack={gitRollingBack} onRollbackSelected={openRollbackSelected} onPush={() => void pushGit()} onRefresh={() => void refreshGit()} /></header>
          <div className="git-branch"><GitBranch size={13} /><span>{gitBranch}</span></div>
          <GitChangesView entries={gitEntries} error={gitError} selectedPaths={selectedGitPaths} onTogglePath={(path) => setSelectedGitPaths((current) => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; })} activePath={activeTab?.path} onOpenDiff={openDiff} onOpenFile={(entry) => void openFile({ name: entry.path.split("/").pop() ?? entry.path, path: entry.path, type: "file" })} onContextMenu={(event, entry) => { event.preventDefault(); setGitRollbackMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 50), entry }); }} />
          <form className="git-commit-panel" onSubmit={(event) => { event.preventDefault(); void commitSelectedFiles(); }}><textarea aria-label="Commit message" placeholder="Commit message" value={gitCommitMessage} disabled={gitOperationRunning} onChange={(event) => setGitCommitMessage(event.target.value)} /><footer><span>{selectedGitPaths.size} selected</span><button disabled={gitOperationRunning || selectedGitPaths.size === 0 || !gitCommitMessage.trim()}>{gitCommitting ? "Committing..." : "Commit"}</button></footer></form>
        </section>}
        {rightPanels.taskGit && selectedTaskId && <section key="taskGit" className="stacked-panel"><header className="panel-header"><span>Task Git</span><button title="Refresh task comparison" onClick={() => void refreshTaskGit()}><RefreshCw size={14} /></button></header><div className="git-branch"><GitCompareArrows size={13} /><span>{tasks.find((task) => task.id === selectedTaskId)?.baseBranch ?? "Base branch"}</span></div><GitChangesView entries={taskGitEntries} error={taskGitError} emptyMessage="No changes from base branch" groupTitle="Changes from Base" activePath={activeTab?.path} onOpenDiff={openTaskDiff} onOpenFile={(entry) => void openFile({ name: entry.path.split("/").pop() ?? entry.path, path: entry.path, type: "file" })} /></section>}
        {rightPanels.java && javaOptions && <section key="java" className="stacked-panel"><header className="panel-header"><span>Java Project</span><button title="Refresh Java project" onClick={() => void refreshJavaTree()}><RefreshCw size={14} /></button></header><div className="java-project-meta"><Coffee size={13} /><span>{javaOptions.pomPath}</span></div><div className="tree java-tree"><JavaProjectTree nodes={javaTree} activePath={activeTab?.path} onOpen={openFile} /></div></section>}
        {rightPanels.useful && <section key="useful" className="stacked-panel"><header className="panel-header"><span>Useful Files</span><button title="Refresh useful files" onClick={() => void refreshUsefulFiles()}><RefreshCw size={14} /></button></header><div className="useful-files-list"><UsefulFileSection title="Global" scope="global" files={usefulFiles} activeTab={activeTab} onOpen={openUsefulFile} onCreate={(scope) => setUsefulDialog({ mode: "create", scope })} onRename={(file) => setUsefulDialog({ mode: "rename", scope: file.scope, file })} onDelete={(file) => void deleteUsefulFile(file)} /><UsefulFileSection title="Local" scope="local" files={usefulFiles} activeTab={activeTab} onOpen={openUsefulFile} onCreate={(scope) => setUsefulDialog({ mode: "create", scope })} onRename={(file) => setUsefulDialog({ mode: "rename", scope: file.scope, file })} onDelete={(file) => void deleteUsefulFile(file)} /></div></section>}
        {rightPanels.agents && <section key="agents" className="stacked-panel"><AgentsPanel agents={agents} activeTab={activeTab} onRefresh={() => void refreshAgents()} onOpen={(file) => void openAgentFile(file)} onCreate={(scope) => setAgentDialog({ mode: "create", scope })} onRename={(file) => { if (file.scope !== "workspace") setAgentDialog({ mode: "rename", scope: file.scope, file }); }} onDelete={(file) => void deleteAgent(file)} /></section>}
      </ResizablePanelStack></aside></>}
      <nav className="right-tool-stripe" aria-label="Right tool windows">
        <button className={`tool-stripe-button right ${rightPanels.project ? "active" : ""}`} title={rightPanels.project ? "Hide Project" : "Show Project"} onClick={() => setRightPanels((current) => ({ ...current, project: !current.project }))}><Folder size={15} /><span>Project</span></button>
        <button className={`tool-stripe-button right ${rightPanels.git ? "active" : ""}`} title={rightPanels.git ? "Hide Git changes" : "Show Git changes"} onClick={() => setRightPanels((current) => { if (!current.git) void refreshGit(); return { ...current, git: !current.git }; })}><GitBranch size={15} /><span>Git</span>{gitEntries.length > 0 && <span className="tool-badge">{gitEntries.length > 99 ? "99+" : gitEntries.length}</span>}</button>
        {selectedTaskId && <button className={`tool-stripe-button right ${rightPanels.taskGit ? "active" : ""}`} title={rightPanels.taskGit ? "Hide Task Git" : "Show Task Git"} onClick={() => setRightPanels((current) => { if (!current.taskGit) void refreshTaskGit(); return { ...current, taskGit: !current.taskGit }; })}><GitCompareArrows size={15} /><span>Task Git</span>{taskGitEntries.length > 0 && <span className="tool-badge">{taskGitEntries.length > 99 ? "99+" : taskGitEntries.length}</span>}</button>}
        {javaOptions && <button className={`tool-stripe-button right ${rightPanels.java ? "active" : ""}`} title={rightPanels.java ? "Hide Java project" : "Show Java project"} onClick={() => setRightPanels((current) => { if (!current.java) void refreshJavaTree(); return { ...current, java: !current.java }; })}><Coffee size={15} /><span>Java</span></button>}
        <button className={`tool-stripe-button right ${rightPanels.useful ? "active" : ""}`} title={rightPanels.useful ? "Hide Useful Files" : "Show Useful Files"} onClick={() => setRightPanels((current) => { if (!current.useful) void refreshUsefulFiles(); return { ...current, useful: !current.useful }; })}><Library size={15} /><span>Useful</span></button>
        <button className={`tool-stripe-button right ${rightPanels.agents ? "active" : ""}`} title={rightPanels.agents ? "Hide Agents" : "Show Agents"} onClick={() => setRightPanels((current) => { if (!current.agents) void refreshAgents(); return { ...current, agents: !current.agents }; })}><Bot size={15} /><span>Agents</span></button>
      </nav>
      </> : <>
      {(classicTasksOpen || classicAiOpen) && <><div className="right-resize-handle" onPointerDown={beginClassicRightResize} /><aside className="side-panel classic-right-panel" style={{ width: classicRightWidth }}>
        {classicTasksOpen && <section className="stacked-panel" style={classicAiOpen ? { flex: `0 0 ${classicSplit}%` } : undefined}><header className="panel-header"><span>Tasks</span><button title="Create task" disabled={taskSwitching} onClick={() => setShowCreateTaskDialog(true)}><Plus size={15} /></button></header><QuickFilter value={taskFilter} placeholder="Filter tasks" label="Filter tasks" onChange={setTaskFilter} /><div className="tasks-list">
          {showRootTask && <TaskRow icon={<Folder size={15} />} name="Root workspace" summary={aiStatuses.root} selected={selectedTaskId === undefined} disabled={taskSwitching} onClick={() => void switchTask()} />}
          {filteredTasks.map((task) => <TaskRow key={task.id} icon={<ListTodo size={15} />} name={task.name} summary={aiStatuses.tasks[task.id] ?? emptyAiSummary} selected={selectedTaskId === task.id} disabled={taskSwitching} onClick={() => void switchTask(task.id)} onMerge={() => setMergeDialog(task)} onDelete={() => void deleteTask(task)} />)}
          {!showRootTask && filteredTasks.length === 0 && <div className="filter-empty">No matching tasks</div>}
        </div></section>}
        {classicTasksOpen && classicAiOpen && <div className="classic-panel-divider" onPointerDown={beginClassicSplitResize} />}
        {classicAiOpen && <section className="stacked-panel"><header className="panel-header"><span>AI</span><AgentPicker agents={agents} value={selectedAgentKey} disabled={aiSession.status === "in_progress"} onChange={selectAgent} /><span className={`ai-status ${aiSession.status}`}>{formatAiStatus(aiSession.status)}</span></header><AiPanel key={`classic:${activeWorkspace}:${aiProvider}:${aiSession.id ?? "legacy"}`} provider={aiProvider} providers={aiProviders} session={aiSession} sessions={aiSessions} models={aiModels} usage={aiUsage} attachments={currentAiAttachments} onProviderChange={(provider) => void switchAiProvider(provider)} onConfigurationChange={configureAi} onAttachmentsChange={updateAiAttachments} onSend={sendAiPrompt} onSendAsTask={selectedTaskId ? undefined : sendAiPromptAsTask} onSteer={steerAiPrompt} onInterrupt={() => void interruptAi()} onNewSession={() => void newAiSession()} onSwitchSession={(session) => void switchAiSession(session)} onRemoveSession={(session) => void removeAiSession(session)} onResolvePermission={(requestId, optionId) => void resolveAiPermission(requestId, optionId)} /></section>}
      </aside></>}
      <nav className="right-tool-stripe" aria-label="Right tool windows"><button className={`tool-stripe-button right ${classicTasksOpen ? "active" : ""}`} title={classicTasksOpen ? "Hide Tasks" : "Show Tasks"} onClick={() => setClassicTasksOpen((open) => !open)}><ListTodo size={15} /><span>Tasks</span>{tasks.length > 0 && <span className="tool-badge">{tasks.length > 99 ? "99+" : tasks.length}</span>}</button><button className={`tool-stripe-button right ${classicAiOpen ? "active" : ""}`} title={classicAiOpen ? "Hide AI" : "Show AI"} onClick={() => { setClassicAiOpen((open) => { if (!open) void refreshAi(); return !open; }); }}><Bot size={15} /><span>AI</span>{aiSession.status === "in_progress" && <span className="tool-badge">...</span>}</button></nav>
      </>}
    </div>
    {layout.panels.some((panel) => panel.type === "terminal") && <TerminalPanel theme={theme} fontFamily={editorFontFamily} fontSize={uiFontSize} lineHeight={uiLineHeight} client={clientRef.current!} group={layout.terminalGroup} height={terminalHeight} onActivate={(id) => updateTerminalGroup((current) => ({ ...current, activeTabId: id }))} onCreate={() => void createTerminal()} onClose={closeTerminal} onResizeStart={beginTerminalResize} registerWriter={registerTerminalWriter} />}
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
        {treeContextMenu.node.path && <div className="context-submenu-trigger"><button><Palette size={14} /><span>Color</span><ChevronRight size={13} /></button><div className="context-menu context-submenu color-submenu">{fileColorChoices.map((color) => <button key={color.id} onClick={() => { setFileColors((current) => ({ ...current, [treeContextMenu.node.path]: color.id })); setTreeContextMenu(undefined); }}><span className={`file-color-swatch ${color.id}`} /><span>{color.label}</span>{fileColors[treeContextMenu.node.path] === color.id && <Check size={13} />}</button>)}<button disabled={!fileColors[treeContextMenu.node.path]} onClick={() => { setFileColors((current) => { const next = { ...current }; delete next[treeContextMenu.node.path]; return next; }); setTreeContextMenu(undefined); }}><X size={14} /><span>Clear Color</span></button></div></div>}
      </div>
    </div>}
    {editorGitMenu && <div className="context-menu-layer" onMouseDown={() => setEditorGitMenu(undefined)}><div className="context-menu editor-git-menu" style={{ left: editorGitMenu.x, top: editorGitMenu.y }} onMouseDown={(event) => event.stopPropagation()}><button onClick={() => attachWorkspaceFile(editorGitMenu.path)}><Bot size={14} /><span>Attach to AI</span></button><div className="context-submenu-trigger"><button><GitBranch size={14} /><span>Git</span><ChevronRight size={13} /></button><div className="context-menu context-submenu"><button onClick={() => { setGitHistory({ path: editorGitMenu.path }); setEditorGitMenu(undefined); }}><FileDiff size={14} /><span>Show file changes</span></button><button disabled={editorGitMenu.startLine === undefined} onClick={() => { setGitHistory({ path: editorGitMenu.path, startLine: editorGitMenu.startLine, endLine: editorGitMenu.endLine }); setEditorGitMenu(undefined); }}><ListTree size={14} /><span>Show selection changes</span></button></div></div></div></div>}
    {gitRollbackMenu && <div className="context-menu-layer" onMouseDown={() => setGitRollbackMenu(undefined)}><div className="context-menu" style={{ left: gitRollbackMenu.x, top: gitRollbackMenu.y }} onMouseDown={(event) => event.stopPropagation()}><button className="danger" disabled={gitOperationRunning} onClick={() => void rollbackFile(gitRollbackMenu.entry)}><RefreshCw size={14} /><span>Rollback</span></button></div></div>}
    {tabContextMenu && <div className="context-menu-layer" onMouseDown={() => setTabContextMenu(undefined)}><div className="context-menu tab-context-menu" style={{ left: tabContextMenu.x, top: tabContextMenu.y }} onMouseDown={(event) => event.stopPropagation()}><button onClick={() => closeTabs(tabContextMenu.tab, "all")}><X size={14} /><span>Close All</span></button><button disabled={group.tabs.findIndex((tab) => tab.id === tabContextMenu.tab.id) === group.tabs.length - 1} onClick={() => closeTabs(tabContextMenu.tab, "right")}><ArrowUpRight className="close-right-icon" size={14} /><span>Close All to the Right</span></button><button disabled={tabContextMenu.tab.type === "diff" || tabContextMenu.tab.type === "agent"} onClick={() => void openTabInWindow(tabContextMenu.tab)}><Columns2 size={14} /><span>Open in New Window</span></button></div></div>}
    {searchScope !== undefined && <FindInFilesDialog client={clientRef.current!} scope={searchScope} onClose={() => setSearchScope(undefined)} onNavigate={(result, matchLength) => void navigateToSearchResult(result, matchLength)} />}
    {importChoices && <div className="dialog-overlay" onMouseDown={() => setImportChoices(undefined)}><section className="import-chooser" role="dialog" aria-modal="true" aria-label="Choose Java import" onMouseDown={(event) => event.stopPropagation()}><header><span>Import class</span><button title="Close" onClick={() => setImportChoices(undefined)}><X size={15} /></button></header><div>{importChoices.suggestions.map((suggestion) => <button key={suggestion.qualifiedName} onClick={() => applyJavaImport(suggestion)}><span>{suggestion.simpleName}</span><code>{suggestion.qualifiedName}</code><small>{suggestion.source}</small></button>)}</div></section></div>}
    {javaUsages && <div className="dialog-overlay" onMouseDown={() => setJavaUsages(undefined)}><section className="import-chooser usage-chooser" role="dialog" aria-modal="true" aria-label="Java usages" onMouseDown={(event) => event.stopPropagation()}><header><span>Usages ({javaUsages.length})</span><button title="Close" onClick={() => setJavaUsages(undefined)}><X size={15} /></button></header><div>{javaUsages.length === 0 ? <div className="problems-empty">No project usages found</div> : javaUsages.map((location, index) => <button key={`${location.path}:${location.startLine}:${location.startColumn}:${index}`} onClick={() => void openJavaLocation(location)}><span>{location.path.split("/").pop()}</span><code>{location.path}</code><small>{location.startLine}:{location.startColumn}</small></button>)}</div></section></div>}
    {gitHistory && <GitHistoryDialog client={clientRef.current!} path={gitHistory.path} startLine={gitHistory.startLine} endLine={gitHistory.endLine} onClose={() => setGitHistory(undefined)} />}
    {gitRollbackDialog && <RollbackSelectedDialog entries={gitRollbackDialog} busy={gitRollingBack} onClose={() => { if (!gitRollingBack) setGitRollbackDialog(undefined); }} onConfirm={(deleteUntracked) => void rollbackSelected(deleteUntracked)} />}
    {gitHunkDialog && <div className="context-menu-layer" onMouseDown={() => setGitHunkDialog(undefined)}><section className="git-hunk-popup" role="dialog" aria-label={`Previous content in ${gitHunkDialog.path}`} style={{ left: gitHunkDialog.x, top: gitHunkDialog.y }} onMouseDown={(event) => event.stopPropagation()}><header><div><strong>Before this change</strong><span>{gitHunkDialog.path.split("/").pop()} · line {gitHunkDialog.hunk.originalStart}</span></div><button title="Close" onClick={() => setGitHunkDialog(undefined)}><X size={14} /></button></header>{gitHunkDialog.error && <div className="git-hunk-error">{gitHunkDialog.error}</div>}<pre>{gitHunkDialog.hunk.originalLines === 0 ? "This block did not exist before." : gitHunkDialog.originalContent.split("\n").slice(Math.max(0, gitHunkDialog.hunk.originalStart - 1), Math.max(0, gitHunkDialog.hunk.originalStart - 1) + gitHunkDialog.hunk.originalLines).join("\n")}</pre><footer><button className="danger" onClick={() => void rollbackGitHunk()}><RefreshCw size={13} /><span>Rollback</span></button></footer></section></div>}
    {showRunConfigurationDialog && <RunConfigurationDialog client={clientRef.current!} onClose={() => setShowRunConfigurationDialog(false)} onSaved={(options) => { setJavaOptions(options); javaOptionsRef.current = options; setShowRunConfigurationDialog(false); }} />}
    {showCreateTaskDialog && <CreateTaskDialog client={clientRef.current!} onClose={() => setShowCreateTaskDialog(false)} onCreate={createTask} />}
    {mergeDialog && <MergeTaskDialog task={mergeDialog} onClose={() => setMergeDialog(undefined)} onMerge={(strategy) => void mergeTask(mergeDialog, strategy)} />}
    {usefulDialog && <UsefulFileDialog mode={usefulDialog.mode} initialName={usefulDialog.file?.name ?? ""} scope={usefulDialog.scope} onClose={() => setUsefulDialog(undefined)} onSave={saveUsefulFileDialog} />}
    {agentDialog && <AgentDialog mode={agentDialog.mode} initialName={agentDialog.file?.name ?? ""} scope={agentDialog.scope} onClose={() => setAgentDialog(undefined)} onSave={saveAgentDialog} />}
  </div>;
}

function BranchSelectorGroup({ title, branches, selected, onSelect, onCheckout, onRename }: { title: string; branches: GitBranchInfo[]; selected?: string; onSelect(name: string): void; onCheckout(branch: GitBranchInfo): void; onRename(branch: GitBranchInfo): void }) {
  const nodes = useMemo(() => buildBranchPathTree(branches), [branches]);
  const currentPaths = branches.filter((branch) => branch.current).flatMap((branch) => { const parts = branch.name.split("/"); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/")); });
  const currentPathsKey = currentPaths.join("\0");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(currentPaths));
  useEffect(() => { if (currentPaths.some((path) => !expanded.has(path))) setExpanded((current) => new Set([...current, ...currentPaths])); }, [currentPathsKey]);
  const renderBranch = (branch: GitBranchInfo, label: string, depth: number) => { const open = selected === branch.name; return <div className={`branch-selector-item ${open ? "open" : ""}`} key={`branch:${branch.name}`}><button className={`branch-selector-row ${branch.current ? "current" : ""} ${open ? "selected" : ""}`} title={branch.name} style={{ paddingLeft: 10 + depth * 15 }} onClick={() => onSelect(branch.name)}><GitBranch size={13} /><span>{label}</span>{branch.current && <span className="branch-current-label">Current</span>}<ChevronRight className={open ? "expanded" : ""} size={12} /></button>{open && <div className="branch-action-menu"><button disabled={branch.current} onClick={() => void onCheckout(branch)}><GitBranch size={13} /><span>Checkout</span></button><button disabled={branch.remote} onClick={() => void onRename(branch)}><Pencil size={13} /><span>Rename</span></button></div>}</div>; };
  const renderNodes = (items: BranchPathNode[], depth: number): ReactNode => items.map((node) => { if (node.children.length === 0 && node.branch) return renderBranch(node.branch, node.segment, depth); const open = expanded.has(node.path); return <div className="branch-path-group" key={`path:${node.path}`}><button className="branch-path-row" style={{ paddingLeft: 9 + depth * 15 }} aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); open ? next.delete(node.path) : next.add(node.path); return next; })}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{open ? <FolderOpen size={13} /> : <Folder size={13} />}<span>{node.segment}</span><small>{countBranchPathLeaves(node)}</small></button>{open && <div>{node.branch && renderBranch(node.branch, node.segment, depth + 1)}{renderNodes(node.children, depth + 1)}</div>}</div>; });
  return <section className="branch-selector-group"><header>{title}<small>{branches.length}</small></header>{branches.length === 0 ? <div className="branch-menu-empty">No {title.toLowerCase()} branches</div> : renderNodes(nodes, 0)}</section>;
}

type BranchPathNode = { segment: string; path: string; branch?: GitBranchInfo; children: BranchPathNode[] };

function buildBranchPathTree(branches: GitBranchInfo[]): BranchPathNode[] {
  const root: BranchPathNode[] = [];
  for (const branch of branches) {
    let children = root; let currentPath = ""; const parts = branch.name.split("/");
    parts.forEach((segment, index) => { currentPath = currentPath ? `${currentPath}/${segment}` : segment; let node = children.find((item) => item.segment === segment); if (!node) { node = { segment, path: currentPath, children: [] }; children.push(node); } if (index === parts.length - 1) node.branch = branch; children = node.children; });
  }
  const sort = (nodes: BranchPathNode[]) => { nodes.sort((left, right) => Number(right.children.length > 0) - Number(left.children.length > 0) || left.segment.localeCompare(right.segment)); for (const node of nodes) sort(node.children); };
  sort(root); return root;
}

function countBranchPathLeaves(node: BranchPathNode): number { return (node.branch ? 1 : 0) + node.children.reduce((total, child) => total + countBranchPathLeaves(child), 0); }

function ConnectionScreen(props: { host: string; port: string; status: ConnectionStatus; statusMessage: string; setHost(value: string): void; setPort(value: string): void; connect(): Promise<void> }) {
  const connecting = props.status === "connecting";
  return <main className="connection-screen"><form className="connection-form" onSubmit={(event) => { event.preventDefault(); void props.connect(); }}>
    <h1>Vibe Editor</h1><p>Connect to a core backend</p>
    <label>Host<input autoFocus value={props.host} onChange={(event) => props.setHost(event.target.value)} placeholder="192.168.1.50" required /></label>
    <label>Port<input value={props.port} onChange={(event) => props.setPort(event.target.value)} type="number" min="1" max="65535" required /></label>
    {props.statusMessage && <div className={`connection-message ${props.status}`}>{props.statusMessage}</div>}
    <button className="primary" disabled={connecting}>{connecting ? "Connecting..." : "Connect"}</button>
  </form></main>;
}

function readStackSizes(workspace: string, setting: string): Record<string, number[]> {
  try {
    const parsed: unknown = JSON.parse(readWorkspaceSetting(workspace, setting) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number[]> : {};
  } catch { return {}; }
}

function ResizablePanelStack({ children, workspace, setting, ids }: { children: ReactNode; workspace: string; setting: string; ids: string[] }) {
  const items = Children.toArray(children);
  const rootRef = useRef<HTMLDivElement>(null);
  const [savedSizes, setSavedSizes] = useState<Record<string, number[]>>(() => readStackSizes(workspace, setting));
  // The workspace is only known once the connection is established, so stored sizes are re-read
  // whenever it changes instead of staying on whatever was available when the stack first mounted.
  useEffect(() => { setSavedSizes(readStackSizes(workspace, setting)); }, [workspace, setting]);
  const signature = ids.join("|");
  const stored = savedSizes[signature];
  const sizes = stored?.length === items.length && stored.every((size) => Number.isFinite(size) && size > 0)
    ? stored
    : Array.from({ length: items.length }, () => 1 / Math.max(1, items.length));
  const saveSizes = (next: number[]) => setSavedSizes((current) => {
    const updated = { ...current, [signature]: next };
    writeWorkspaceSetting(workspace, setting, JSON.stringify(updated));
    return updated;
  });
  const beginResize = (event: React.PointerEvent<HTMLDivElement>, index: number) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const root = rootRef.current;
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    const available = bounds.height - (items.length - 1) * 5;
    const startY = event.clientY;
    const start = sizes;
    const combined = start[index]! + start[index + 1]!;
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientY - startY) / Math.max(1, available);
      const minimum = Math.min(.45, 70 / Math.max(1, available));
      const first = Math.max(minimum, Math.min(combined - minimum, start[index]! + delta));
      saveSizes(start.map((value, itemIndex) => itemIndex === index ? first : itemIndex === index + 1 ? combined - first : value));
    };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };
  return <div className="resizable-panel-stack" ref={rootRef}>{items.map((item, index) => <div className="resizable-panel-item" key={isValidElement(item) && item.key != null ? item.key : index} style={{ flexGrow: sizes[index] ?? 1 / Math.max(1, items.length) }}>{item}{index < items.length - 1 && <div className="focused-panel-divider" onPointerDown={(event) => beginResize(event, index)} />}</div>)}</div>;
}

function QuickFilter({ value, placeholder, label, onChange }: { value: string; placeholder: string; label: string; onChange(value: string): void }) {
  return <div className="quick-filter"><Search size={13} /><input aria-label={label} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />{value && <button title="Clear filter" aria-label="Clear filter" onClick={() => onChange("")}><X size={12} /></button>}</div>;
}

function filterFileTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node) => {
    if (node.type === "file") return `${node.name} ${node.path}`.toLowerCase().includes(needle) ? [node] : [];
    const children = filterFileTree(node.children ?? [], needle);
    return `${node.name} ${node.path}`.toLowerCase().includes(needle) || children.length > 0 ? [{ ...node, children }] : [];
  });
}

function Tree({ nodes, activePath, fileColors, gitStatuses, expandAll = false, onOpen, onContextMenu }: { nodes: FileTreeNode[]; activePath?: string; fileColors: Record<string, FileColor>; gitStatuses: Record<string, "M" | "C">; expandAll?: boolean; onOpen(node: FileTreeNode): void; onContextMenu(event: ReactMouseEvent, node: FileTreeNode): void }) {
  const initialAutoExpanded = useRef(new Set(collectSingleChildDirectories(nodes)));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialAutoExpanded.current));
  useEffect(() => {
    const additions = collectSingleChildDirectories(nodes).filter((directory) => !initialAutoExpanded.current.has(directory));
    if (!additions.length) return;
    for (const directory of additions) initialAutoExpanded.current.add(directory);
    setExpanded((current) => new Set([...current, ...additions]));
  }, [nodes]);
  return <>{nodes.map((node) => node.type === "directory" ? <div key={node.path}>
    <button className={`tree-row ${fileColors[node.path] ? `file-color-${fileColors[node.path]}` : ""}`} onContextMenu={(event) => onContextMenu(event, node)} onClick={() => setExpanded((current) => { const next = new Set(current); next.has(node.path) ? next.delete(node.path) : next.add(node.path); return next; })}>
      {expandAll || expanded.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{expandAll || expanded.has(node.path) ? <FolderOpen className="folder-kind-icon" size={15} /> : <Folder className="folder-kind-icon" size={15} />}<span>{node.name}</span>
    </button>{(expandAll || expanded.has(node.path)) && <div className="tree-children"><Tree nodes={node.children ?? []} activePath={activePath} fileColors={fileColors} gitStatuses={gitStatuses} expandAll={expandAll} onOpen={onOpen} onContextMenu={onContextMenu} /></div>}
  </div> : <FileTreeRow key={node.path} node={node} selected={activePath === node.path} color={fileColors[node.path]} gitStatus={gitStatuses[node.path]} onOpen={onOpen} onContextMenu={onContextMenu} />)}</>;
}

function collectSingleChildDirectories(nodes: FileTreeNode[]): string[] {
  const onlyEntry = nodes.length === 1 ? nodes[0] : undefined;
  return onlyEntry?.type === "directory" ? [onlyEntry.path] : [];
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

function TaskRow({ icon, name, summary, selected, disabled, onClick, onMerge, onDelete }: { icon: ReactNode; name: string; summary: AiTaskSummary; selected: boolean; disabled: boolean; onClick(): void; onMerge?(): void; onDelete?(): void }) {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const preview = summary.pendingPermission ? "Waiting for permission approval" : (summary.preview || "No AI activity yet");
  return <div className={`task-row ${selected ? "selected" : ""}`}><button className="task-open" disabled={disabled} title={`${name}\n${preview}`} onClick={onClick}>
    <span className="task-icon">{icon}</span>
    <span className="task-content"><span className="task-title"><strong>{name}</strong>{(summary.additions > 0 || summary.deletions > 0) && <span className="task-diff-stat"><small>+{summary.additions}</small><small>-{summary.deletions}</small></span>}{summary.pendingPermission ? <small className="task-ai-status permission"><ShieldAlert size={13} /> Permission needed</small> : summary.status !== "idle" && <small className={`task-ai-status ${summary.status}`}>{summary.status === "in_progress" && <LoaderCircle className="task-progress-spinner" size={13} />}{formatAiStatus(summary.status)}</small>}</span><span className="task-preview"><TaskPreviewMarkdown>{preview}</TaskPreviewMarkdown></span></span>
    {selected && <Check className="task-check" size={13} />}
  </button>{onDelete && <button className="task-actions" title={`Actions for ${name}`} disabled={disabled} onClick={(event) => { event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); setMenu({ x: Math.max(8, bounds.right - 180), y: bounds.bottom + 2 }); }}><MoreVertical size={14} /></button>}
    {menu && <div className="context-menu-layer" onMouseDown={() => setMenu(undefined)}><div className="context-menu task-actions-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
      <button onClick={() => { setMenu(undefined); onMerge?.(); }}><GitMerge size={14} /><span>Merge to main workspace</span></button>
      <button className="danger" onClick={() => { setMenu(undefined); onDelete?.(); }}><Trash2 size={14} /><span>Delete task</span></button>
    </div></div>}
  </div>;
}

function TaskPreviewMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ p: ({ children: value }) => <span>{value}</span>, strong: ({ children: value }) => <em>{value}</em> }}>{children}</ReactMarkdown>;
}

function UsefulFileSection({ title, scope, files, activeTab, onOpen, onCreate, onRename, onDelete }: { title: string; scope: UsefulFileScope; files: UsefulFile[]; activeTab?: EditorTab; onOpen(file: UsefulFile): void; onCreate(scope: UsefulFileScope): void; onRename(file: UsefulFile): void; onDelete(file: UsefulFile): void }) {
  const scoped = files.filter((file) => file.scope === scope);
  return <section className="useful-section"><header><span>{title}</span><button title={`Create ${title} file`} onClick={() => onCreate(scope)}><Plus size={14} /></button></header>
    {scoped.length === 0 ? <div className="useful-empty">No files</div> : scoped.map((file) => <div key={file.name} className={`useful-row ${activeTab?.type === "useful" && activeTab.usefulScope === scope && activeTab.path === file.name ? "selected" : ""}`}><button className="useful-open" title={file.name} onClick={() => void onOpen(file)}><FileText size={14} /><span>{file.name}</span></button><button title={`Rename ${file.name}`} onClick={() => onRename(file)}><Pencil size={12} /></button><button title={`Delete ${file.name}`} onClick={() => onDelete(file)}><Trash2 size={12} /></button></div>)}
  </section>;
}

function MergeTaskDialog({ task, onClose, onMerge }: { task: WorkspaceTask; onClose(): void; onMerge(strategy: "merge" | "smart"): void }) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  return <div className="dialog-overlay" onMouseDown={onClose}>
    <section className="run-config-dialog merge-task-dialog" role="dialog" aria-modal="true" aria-labelledby="merge-task-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="merge-task-title">Merge task to main workspace</h2><span>{task.name}</span></div><button title="Close" onClick={onClose}><X size={15} /></button></header>
      <div className="merge-task-content">
        <div className="merge-task-intro"><GitMerge size={22} /><div><strong>Ready to integrate this task?</strong><span>All task changes will be committed first.</span></div></div>
        <div className="merge-task-options">
          <button onClick={() => onMerge("merge")}><span className="merge-option-icon"><GitMerge size={17} /></span><span><strong>Commit and merge</strong><small>Commit the task, then merge it normally. Main must have no uncommitted changes.</small></span></button>
          <button className="recommended" autoFocus onClick={() => onMerge("smart")}><span className="merge-option-icon"><GitCompareArrows size={17} /></span><span><strong>Smart merge <em>Recommended</em></strong><small>Preserve local main changes, rebase the task onto main, then restore your work.</small></span></button>
        </div>
        <footer><button onClick={onClose}>Cancel</button></footer>
      </div>
    </section>
  </div>;
}

function UsefulFileDialog({ mode, initialName, scope, onClose, onSave }: { mode: "create" | "rename"; initialName: string; scope: UsefulFileScope; onClose(): void; onSave(name: string): Promise<void> }) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => { if (!name.trim() || saving) return; setSaving(true); setError(""); try { await onSave(name.trim()); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Could not save useful file"); setSaving(false); } };
  return <div className="dialog-overlay" onMouseDown={() => { if (!saving) onClose(); }}><section className="run-config-dialog useful-file-dialog" role="dialog" aria-modal="true" aria-label={`${mode} useful file`} onMouseDown={(event) => event.stopPropagation()}><header><div><h2>{mode === "create" ? "Create" : "Rename"} Useful File</h2><span>{scope === "global" ? "Global" : "Local"}</span></div><button title="Close" disabled={saving} onClick={onClose}><X size={15} /></button></header><form onSubmit={(event) => { event.preventDefault(); void save(); }}><label>File name<input autoFocus value={name} disabled={saving} maxLength={180} placeholder="notes.md" onChange={(event) => setName(event.target.value)} /></label>{error && <div className="find-error">{error}</div>}<footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" disabled={saving || !name.trim()}>{saving ? "Saving..." : mode === "create" ? "Create" : "Rename"}</button></footer></form></section></div>;
}

function AgentsPanel({ agents, activeTab, onRefresh, onOpen, onCreate, onRename, onDelete }: { agents: AgentFile[]; activeTab?: EditorTab; onRefresh(): void; onOpen(file: AgentFile): void; onCreate(scope: "global" | "local"): void; onRename(file: AgentFile): void; onDelete(file: AgentFile): void }) {
  return <><header className="panel-header"><span>Agents</span><button title="Refresh agents" onClick={onRefresh}><RefreshCw size={14} /></button></header><div className="useful-files-list"><AgentSection title="Global" scope="global" {...{ agents, activeTab, onOpen, onCreate, onRename, onDelete }} /><AgentSection title="Local" scope="local" {...{ agents, activeTab, onOpen, onCreate, onRename, onDelete }} /><AgentSection title="Workspace (.agents)" scope="workspace" {...{ agents, activeTab, onOpen, onCreate, onRename, onDelete }} /></div></>;
}

function AgentPicker({ agents, value, disabled, onChange }: { agents: AgentFile[]; value: string; disabled: boolean; onChange(value: string): void }) {
  return <select className="ai-agent-picker" aria-label="AI agent" title="Agent preset" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="">No agent</option>{(["global", "local", "workspace"] as const).map((scope) => { const scoped = agents.filter((agent) => agent.scope === scope); return scoped.length ? <optgroup key={scope} label={scope === "workspace" ? "Workspace" : scope[0]!.toUpperCase() + scope.slice(1)}>{scoped.map((agent) => <option key={agentKey(agent)} value={agentKey(agent)}>{agent.agent.name}</option>)}</optgroup> : null; })}</select>;
}

function AgentSection({ title, scope, agents, activeTab, onOpen, onCreate, onRename, onDelete }: { title: string; scope: AgentFileScope; agents: AgentFile[]; activeTab?: EditorTab; onOpen(file: AgentFile): void; onCreate(scope: "global" | "local"): void; onRename(file: AgentFile): void; onDelete(file: AgentFile): void }) {
  const scoped = agents.filter((agent) => agent.scope === scope);
  return <section className="useful-section"><header><span>{title}</span>{scope !== "workspace" && <button title={`Create ${title} agent`} onClick={() => onCreate(scope)}><Plus size={14} /></button>}</header>
    {scoped.length === 0 ? <div className="useful-empty">No agents</div> : scoped.map((file) => <div key={file.name} className={`useful-row ${activeTab?.type === "agent" && activeTab.agentScope === scope && activeTab.path === file.name || activeTab?.type === "file" && scope === "workspace" && activeTab.path === `.agents/${file.name}` ? "selected" : ""}`}><button className="useful-open" title={file.agent.description ?? file.agent.name} onClick={() => onOpen(file)}><Bot size={14} /><span>{file.agent.name}</span></button>{scope !== "workspace" && <><button title={`Rename ${file.name}`} onClick={() => onRename(file)}><Pencil size={12} /></button><button title={`Delete ${file.name}`} onClick={() => onDelete(file)}><Trash2 size={12} /></button></>}</div>)}
  </section>;
}

function AgentDialog({ mode, initialName, scope, onClose, onSave }: { mode: "create" | "rename"; initialName: string; scope: "global" | "local"; onClose(): void; onSave(name: string): Promise<void> }) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => { if (!name.trim() || saving) return; setSaving(true); setError(""); try { await onSave(name.trim()); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Could not save agent"); setSaving(false); } };
  return <div className="dialog-overlay" onMouseDown={() => { if (!saving) onClose(); }}><section className="run-config-dialog useful-file-dialog" role="dialog" aria-modal="true" aria-label={`${mode} agent`} onMouseDown={(event) => event.stopPropagation()}><header><div><h2>{mode === "create" ? "Create" : "Rename"} Agent</h2><span>{scope === "global" ? "Global" : "Local"}</span></div><button title="Close" disabled={saving} onClick={onClose}><X size={15} /></button></header><form onSubmit={(event) => { event.preventDefault(); void save(); }}><label>File name<input autoFocus value={name} disabled={saving} maxLength={180} placeholder="reviewer.md" onChange={(event) => setName(event.target.value)} /></label>{mode === "create" && <small>A Markdown agent template will be created.</small>}{error && <div className="find-error">{error}</div>}<footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" disabled={saving || !name.trim()}>{saving ? "Saving..." : mode === "create" ? "Create" : "Rename"}</button></footer></form></section></div>;
}

function GitChangesView({ entries, error, emptyMessage = "No local changes", groupTitle, selectedPaths, onTogglePath, activePath, onOpenDiff, onOpenFile, onContextMenu }: { entries: GitStatusEntry[]; error: string; emptyMessage?: string; groupTitle?: string; selectedPaths?: Set<string>; onTogglePath?(path: string): void; activePath?: string; onOpenDiff(entry: GitStatusEntry): void; onOpenFile(entry: GitStatusEntry): void; onContextMenu?(event: ReactMouseEvent, entry: GitStatusEntry): void }) {
  if (error) return <div className="git-empty error">{error}</div>;
  if (entries.length === 0) return <div className="git-empty">{emptyMessage}</div>;
  const groups = groupTitle ? [{ title: groupTitle, entries }] : [
    { title: "Conflicts", entries: entries.filter((entry) => entry.indexStatus === "U" || entry.worktreeStatus === "U" || ["AA", "DD"].includes(entry.indexStatus + entry.worktreeStatus)) },
    { title: "Untracked", entries: entries.filter((entry) => entry.indexStatus === "?" && entry.worktreeStatus === "?") },
    { title: "Staged", entries: entries.filter((entry) => entry.indexStatus !== " " && entry.indexStatus !== "?" && entry.indexStatus !== "U" && !["AA", "DD"].includes(entry.indexStatus + entry.worktreeStatus)) },
    { title: "Changes", entries: entries.filter((entry) => entry.indexStatus === " " && entry.worktreeStatus !== " " && entry.worktreeStatus !== "?" && entry.worktreeStatus !== "U") }
  ].filter((group) => group.entries.length > 0);
  return <div className="git-changes">{groups.map((group) => <GitChangeGroup key={group.title} title={group.title} entries={group.entries} selectedPaths={selectedPaths} onTogglePath={onTogglePath} activePath={activePath} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} onContextMenu={onContextMenu} />)}</div>;
}

function GitChangeGroup({ title, entries, selectedPaths, onTogglePath, activePath, onOpenDiff, onOpenFile, onContextMenu }: { title: string; entries: GitStatusEntry[]; selectedPaths?: Set<string>; onTogglePath?(path: string): void; activePath?: string; onOpenDiff(entry: GitStatusEntry): void; onOpenFile(entry: GitStatusEntry): void; onContextMenu?(event: ReactMouseEvent, entry: GitStatusEntry): void }) {
  const [expanded, setExpanded] = useState(true);
  const selectable = Boolean(onTogglePath);
  const selectedCount = entries.filter((entry) => selectedPaths?.has(entry.path)).length;
  const allSelected = entries.length > 0 && selectedCount === entries.length;
  return <section className={`git-group git-group-${title.toLowerCase()}`}>
    <button className="git-group-title" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{selectable && <input type="checkbox" aria-label={`Select all ${title.toLowerCase()} files`} checked={allSelected} ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }} onClick={(event) => event.stopPropagation()} onChange={() => entries.forEach((entry) => { if ((selectedPaths?.has(entry.path) ?? false) === allSelected) onTogglePath?.(entry.path); })} />}<span>{title}</span><span className="git-count">{entries.length}</span>
    </button>
    {expanded && <GitStatusTree entries={entries} selectedPaths={selectedPaths} onTogglePath={onTogglePath} activePath={activePath} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} onContextMenu={onContextMenu} />}
  </section>;
}

type GitTreeNode =
  | { type: "directory"; name: string; path: string; children: GitTreeNode[] }
  | { type: "file"; name: string; path: string; entry: GitStatusEntry };

function GitStatusTree({ entries, selectedPaths, onTogglePath, activePath, onOpenDiff, onOpenFile, onContextMenu }: { entries: GitStatusEntry[]; selectedPaths?: Set<string>; onTogglePath?(path: string): void; activePath?: string; onOpenDiff(entry: GitStatusEntry): void; onOpenFile(entry: GitStatusEntry): void; onContextMenu?(event: ReactMouseEvent, entry: GitStatusEntry): void }) {
  const nodes = useMemo(() => buildGitTree(entries), [entries]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(collectGitDirectories(nodes)));
  useEffect(() => setExpanded((current) => new Set([...current, ...collectGitDirectories(nodes)])), [nodes]);

  const renderNodes = (items: GitTreeNode[], depth: number): ReactNode => items.map((node) => {
    if (node.type === "directory") {
      const open = expanded.has(node.path);
      const descendantPaths = collectGitFiles(node);
      const selectedCount = descendantPaths.filter((path) => selectedPaths?.has(path)).length;
      const allSelected = descendantPaths.length > 0 && selectedCount === descendantPaths.length;
      return <div key={node.path}>
        <button className="git-file-row git-directory-row" style={{ paddingLeft: (onTogglePath ? 9 : 27) + depth * 13 }} onClick={() => setExpanded((current) => { const next = new Set(current); open ? next.delete(node.path) : next.add(node.path); return next; })}>
          {onTogglePath && <input type="checkbox" aria-label={`Select all changes under ${node.path}`} checked={allSelected} ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }} onClick={(event) => event.stopPropagation()} onChange={() => descendantPaths.forEach((path) => { if ((selectedPaths?.has(path) ?? false) === allSelected) onTogglePath(path); })} />}
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span className="git-file-name">{node.name}</span>
        </button>
        {open && renderNodes(node.children, depth + 1)}
      </div>;
    }
    const entry = node.entry;
    const deleted = entry.indexStatus === "D" || entry.worktreeStatus === "D";
    const status = entry.indexStatus === "?" ? "U" : `${entry.indexStatus}${entry.worktreeStatus}`.trim();
    const kind = entry.indexStatus === "U" || entry.worktreeStatus === "U" ? "conflict" : entry.indexStatus === "?" ? "untracked" : deleted ? "deleted" : entry.indexStatus === "A" ? "added" : "modified";
    return <button key={node.path} className={`git-file-row ${activePath === entry.path ? "selected" : ""}`} style={{ paddingLeft: (onTogglePath ? 9 : 27) + depth * 13 }} title={deleted ? `${entry.path} (deleted)` : `${entry.path} - double-click to open file`} onClick={() => onOpenDiff(entry)} onDoubleClick={() => { if (!deleted) onOpenFile(entry); }} onContextMenu={onContextMenu ? (event) => onContextMenu(event, entry) : undefined}>
      {onTogglePath && <input type="checkbox" aria-label={`Select ${entry.path}`} checked={selectedPaths?.has(entry.path) ?? false} onClick={(event) => event.stopPropagation()} onChange={() => onTogglePath(entry.path)} />}
      <FileCode2 size={14} /><span className="git-file-name">{node.name}</span><span className={`git-status ${kind}`}>{status}</span>
    </button>;
  });
  return <>{renderNodes(nodes, 0)}</>;
}

function buildGitTree(entries: GitStatusEntry[]): GitTreeNode[] {
  const root: GitTreeNode[] = [];
  const splitPaths = entries.map((entry) => entry.path.split("/"));
  let sharedDepth = 0;
  const maximumSharedDepth = Math.max(0, Math.min(...splitPaths.map((parts) => parts.length)) - 1);
  while (sharedDepth < maximumSharedDepth && splitPaths.every((parts) => parts[sharedDepth] === splitPaths[0]?.[sharedDepth])) sharedDepth += 1;
  for (const entry of entries) {
    const fullParts = entry.path.split("/");
    const parts = fullParts.slice(sharedDepth);
    let children = root;
    let currentPath = fullParts.slice(0, sharedDepth).join("/");
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
  return compactGitDirectories(root);
}

function compactGitDirectories(nodes: GitTreeNode[]): GitTreeNode[] {
  return nodes.map((node) => {
    if (node.type === "file") return node;
    let compacted: Extract<GitTreeNode, { type: "directory" }> = { ...node, children: compactGitDirectories(node.children) };
    while (compacted.children.length === 1 && compacted.children[0]?.type === "directory") {
      const child = compacted.children[0];
      compacted = { ...compacted, name: `${compacted.name}/${child.name}`, path: child.path, children: child.children };
    }
    return compacted;
  });
}

function collectGitDirectories(nodes: GitTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "directory" ? [node.path, ...collectGitDirectories(node.children)] : []);
}

function collectGitFiles(node: GitTreeNode): string[] {
  return node.type === "file" ? [node.entry.path] : node.children.flatMap(collectGitFiles);
}

function FileTreeRow({ node, selected, color: rowColor, gitStatus, onOpen, onContextMenu }: { node: FileTreeNode; selected: boolean; color?: FileColor; gitStatus?: "M" | "C"; onOpen(node: FileTreeNode): void; onContextMenu(event: ReactMouseEvent, node: FileTreeNode): void }) {
  const extension = node.name.split(".").pop()?.toLowerCase() ?? "";
  const appearance: Record<string, { color: string; Icon: typeof File }> = {
    ts: { color: "#5e9fd6", Icon: FileCode2 }, tsx: { color: "#5e9fd6", Icon: FileCode2 },
    js: { color: "#d9c65c", Icon: FileCode2 }, jsx: { color: "#d9c65c", Icon: FileCode2 },
    json: { color: "#c9b45d", Icon: FileJson }, xml: { color: "#d7a85e", Icon: FileCode2 }, html: { color: "#e8845b", Icon: FileCode2 },
    css: { color: "#8d7bd8", Icon: Hash }, md: { color: "#78a7cf", Icon: FileText },
    java: { color: "#d58b59", Icon: Coffee }, py: { color: "#63a86f", Icon: FileCode2 },
    yaml: { color: "#ca6b75", Icon: Braces }, yml: { color: "#ca6b75", Icon: Braces }, mta: { color: "#ca6b75", Icon: Braces }, mtaext: { color: "#ca6b75", Icon: Braces }, cds: { color: "#5aa7a0", Icon: FileCode2 }
  };
  const { color, Icon } = appearance[extension] ?? { color: "#9aa0a8", Icon: File };
  return <button className={`tree-row file-row ${selected ? "selected" : ""} ${rowColor ? `file-color-${rowColor}` : ""}`} onContextMenu={(event) => onContextMenu(event, node)} onClick={() => void onOpen(node)}>
    <span className="tree-indent" /><Icon className="file-kind-icon" color={color} size={14} /><span className="tree-file-name">{node.name}</span>{gitStatus && <span className={`tree-git-status ${gitStatus === "C" ? "created" : "modified"}`}>{gitStatus}</span>}
  </button>;
}

function CreateTaskDialog({ client, onClose, onCreate }: { client: CoreClient; onClose(): void; onCreate(branch: string, existing?: { remote: boolean }): Promise<void> }) {
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [selected, setSelected] = useState<GitBranchInfo>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [onClose, saving]);
  useEffect(() => {
    let current = true;
    void client.request("git.branches", {}).then((result) => { if (current) setBranches(result.branches); }).catch((loadError) => { if (current) setError(loadError instanceof Error ? loadError.message : "Could not load branches"); });
    return () => { current = false; };
  }, [client]);
  const suggestions = useMemo(() => {
    const query = branch.trim().toLowerCase();
    return branches.filter((item) => !item.current && (!query || item.name.toLowerCase().includes(query))).slice(0, 8);
  }, [branch, branches]);
  const create = async () => {
    if (!branch.trim() || saving) return;
    setSaving(true); setError("");
    try { await onCreate(branch.trim(), selected ? { remote: selected.remote } : undefined); onClose(); }
    catch (createError) { setError(createError instanceof Error ? createError.message : "Could not create task"); setSaving(false); }
  };
  return <div className="dialog-overlay" onMouseDown={() => { if (!saving) onClose(); }}>
    <section className="run-config-dialog task-create-dialog" role="dialog" aria-modal="true" aria-label="Create task" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2>Create Task</h2><span>A separate workspace copy will be created for this branch.</span></div><button title="Close" disabled={saving} onClick={onClose}><X size={15} /></button></header>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label>Branch name<input autoFocus value={branch} disabled={saving} onChange={(event) => { setBranch(event.target.value); setSelected(undefined); }} maxLength={200} placeholder="feature/my-task" /></label>
        {suggestions.length > 0 && <div className="task-branch-help" role="listbox" aria-label="Existing branches">{suggestions.map((item) => <button type="button" role="option" aria-selected={selected?.name === item.name} className={selected?.name === item.name ? "selected" : ""} key={`${item.remote ? "remote" : "local"}:${item.name}`} onClick={() => { setBranch(item.name); setSelected(item); }}><GitBranch size={13} /><span>{item.name}</span><small>{item.remote ? "remote" : "existing"}</small></button>)}</div>}
        <div className="task-branch-mode">{selected ? <>Use existing {selected.remote ? "remote " : ""}branch <strong>{selected.name}</strong></> : <>Create new branch <strong>{branch.trim() || "..."}</strong></>}</div>
        {error && <div className="find-error">{error}</div>}
        <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" disabled={saving || !branch.trim()}>{saving ? "Creating..." : "Create"}</button></footer>
      </form>
    </section>
  </div>;
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
            {previewError ? <div className="find-empty">{previewError}</div> : selected ? <Editor value={previewContent} language={languageByExtension[selected.path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext"} beforeMount={configureMonacoThemes} theme={monacoTheme()} onMount={(instance) => { previewEditorRef.current = instance; }} options={{ readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3, scrollBeyondLastLine: false, padding: { top: 6 }, renderLineHighlight: "all" }} /> : <div className="find-empty">Select a result</div>}
          </div>
        </section>
      </div>
    </section>
  </div>;
}
