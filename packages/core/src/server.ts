import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import chokidar from "chokidar";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { protocolCompatibility, requestTypes, type FileTreeNode, type ProtocolOperations, type Request, type RequestType, type Response, type ServerEvent, type WorkspaceOptions, type WorkspaceRoot } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";
import { TerminalSessionHost } from "./process-manager.js";
import { GitService } from "./git.js";
import { WorkspaceStateStore } from "./workspace-state.js";
import { WorkspaceSearch } from "./search.js";
import { JavaProjectService } from "./java.js";
import { JdtLanguageService } from "./jdtls.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { UsefulFilesStore } from "./useful-files.js";
import { ConfigurationService } from "./configuration.js";
import { ensureSelfConfiguration } from "./self-configuration.js";
import { SkillsStore } from "./skills.js";
import { AgentsStore } from "./agents.js";
import { HarnessStore } from "./harnesses.js";
import { executeFlowScript } from "./workflow-script.js";
import { WorkflowAppService } from "./workflow-app.js";
import { HarnessRunner } from "./harness-runner.js";
import { validateHarness } from "./harness-graph.js";
import { RunConfigService } from "./run-configs.js";
import { executeHttpRequest } from "./http.js";
import { summarizeAiSessions } from "./ai/summary.js";
import { createAcpRegistry, type AcpRegistry } from "./ai/index.js";
import { AppEventBridge, appBridgeInstanceId } from "./app-events.js";
import { ScheduleService, validateSchedule } from "./schedules.js";
import { AiTimerService, AiTimerStore } from "./ai-timers.js";
import { AppToolService, appToolServer, withAppTools } from "./app-tools.js";
import { TaskCheckpointStore } from "./task-checkpoints.js";
import { RemoteTransferService } from "./remote-transfer.js";
import { WorkspaceRootRegistry } from "./workspace-roots.js";
import type { AiProvider, AiSession, HarnessBlock, HarnessDefinition } from "@remote-ide/protocol";
import { AiProviderError, findAutopilotOption, normalizeAiFailure } from "@remote-ide/acp";

const execFileAsync = promisify(execFile);
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type SessionServices = {
  workspacePath: string;
  filesystem: WorkspaceFileSystem;
  search: WorkspaceSearch;
  git: GitService;
  java: JavaProjectService;
  jdt: JdtLanguageService;
  workspaceState: WorkspaceStateStore;
  checkpoints: TaskCheckpointStore;
};

type SwitchedWatch = { watcher: ReturnType<typeof chokidar.watch>; gitWatcher: ReturnType<typeof chokidar.watch>; batcher: WorkspaceWatchBatcher };

/**
 * `readyState` can change between the check and `send`. Supplying a callback keeps
 * ws from surfacing that race as an uncaught error, while the try/catch also makes
 * this safe for implementations that throw synchronously.
 */
export function sendWebSocketData(socket: WebSocket, data: string): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(data, () => undefined);
    return true;
  } catch {
    return false;
  }
}

export class LiveRootSelections<T extends object> {
  private readonly selections = new Map<T, string>();
  private readonly pending = new Map<T, string>();
  connect(session: T, rootId: string): void { this.selections.set(session, rootId); }
  beginSelection(session: T, rootId: string): void { if (!this.selections.has(session)) throw new Error("Session is not connected"); this.pending.set(session, rootId); }
  select(session: T, rootId: string): void { if (!this.selections.has(session)) throw new Error("Session is not connected"); this.selections.set(session, rootId); this.pending.delete(session); }
  cancelSelection(session: T): void { this.pending.delete(session); }
  disconnect(session: T): void { this.selections.delete(session); this.pending.delete(session); }
  isSelected(rootId: string): boolean { return [...this.selections.values(), ...this.pending.values()].some((selected) => selected === rootId); }
  selected(session: T): string | undefined { return this.selections.get(session); }
}

export function assertRootRemovalAllowed<T extends object>(selections: LiveRootSelections<T>, rootId: string): void {
  if (selections.isSelected(rootId)) throw new CoreError("INVALID_REQUEST", "Every connected client must select another root before removing this root");
}

export async function transactionalRootSelection<T>(prepare: () => Promise<T>, commit: (candidate: T) => Promise<void> | void, dispose: (candidate: T) => Promise<void> | void): Promise<T> {
  let candidate: T | undefined;
  try { candidate = await prepare(); await commit(candidate); return candidate; }
  catch (error) { if (candidate !== undefined) await dispose(candidate); throw error; }
}

const coreProtocolCompatibility = protocolCompatibility;

/** Collapses noisy watcher streams into a bounded, state-reconciliation signal. */
export class WorkspaceWatchBatcher {
  private paths = new Set<string>();
  private overflow = false;
  private degraded?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly rootId: string;
  private readonly emit: (event: Extract<ServerEvent, { type: "filesystem.changed" }>) => void;
  private readonly delay: number;
  private readonly limit: number;
  constructor(emit: (event: Extract<ServerEvent, { type: "filesystem.changed" }>) => void, delay?: number, limit?: number);
  constructor(rootId: string, emit: (event: Extract<ServerEvent, { type: "filesystem.changed" }>) => void, delay?: number, limit?: number);
  constructor(rootOrEmit: string | ((event: Extract<ServerEvent, { type: "filesystem.changed" }>) => void), emitOrDelay?: ((event: Extract<ServerEvent, { type: "filesystem.changed" }>) => void) | number, delayOrLimit = 120, limit = 256) {
    this.rootId = typeof rootOrEmit === "string" ? rootOrEmit : "legacy";
    this.emit = typeof rootOrEmit === "string" ? emitOrDelay as (event: Extract<ServerEvent, { type: "filesystem.changed" }>) => void : rootOrEmit;
    this.delay = typeof rootOrEmit === "string" ? delayOrLimit : typeof emitOrDelay === "number" ? emitOrDelay : 120;
    this.limit = typeof rootOrEmit === "string" ? limit : delayOrLimit;
  }
  change(relativePath: string): void {
    if (this.paths.size >= this.limit) this.overflow = true;
    else this.paths.add(relativePath);
    this.schedule();
  }
  degrade(message: string): void { this.degraded = message; this.overflow = true; this.schedule(); }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.paths.size && !this.degraded) return;
    this.emit({ type: "filesystem.changed", payload: { rootId: this.rootId, paths: [...this.paths], overflow: this.overflow, health: this.degraded ? "degraded" : "healthy", ...(this.degraded ? { message: this.degraded } : {}) } });
    this.paths.clear(); this.overflow = false; this.degraded = undefined;
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); }
  private schedule(): void { if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delay); }
}

export function protocolHandshake(compatibility: { minimum: number; maximum: number }): { compatibility: typeof coreProtocolCompatibility; compatible: boolean; message?: string } {
  const valid = Number.isInteger(compatibility.minimum) && Number.isInteger(compatibility.maximum) && compatibility.minimum > 0 && compatibility.minimum <= compatibility.maximum;
  const compatible = valid && compatibility.minimum <= coreProtocolCompatibility.maximum && coreProtocolCompatibility.minimum <= compatibility.maximum;
  return compatible
    ? { compatible, compatibility: coreProtocolCompatibility }
    : { compatible, compatibility: coreProtocolCompatibility, message: `Core supports protocol ${coreProtocolCompatibility.minimum}-${coreProtocolCompatibility.maximum}; this Desktop supports ${compatibility.minimum}-${compatibility.maximum}` };
}

export async function createServer(host: string, port: number, workspacePath: string): Promise<WebSocketServer> {
  await ensureSelfConfiguration();
  const rootWorkspace = workspacePath;
  const roots = await WorkspaceRootRegistry.open(rootWorkspace);
  const tasks = new WorkspaceTaskStore(rootWorkspace);
  const usefulFiles = new UsefulFilesStore(rootWorkspace);
  const agents = new AgentsStore(rootWorkspace);
  const harnesses = new HarnessStore(rootWorkspace);
  const rootContexts = new Map<string, { tasks: WorkspaceTaskStore; usefulFiles: UsefulFilesStore; agents: AgentsStore; harnesses: HarnessStore }>();
  rootContexts.set(roots.primary().id, { tasks, usefulFiles, agents, harnesses });
  const contextFor = (rootId: string) => {
    let context = rootContexts.get(rootId);
    if (!context) { const root = roots.get(rootId); context = { tasks: new WorkspaceTaskStore(root.path), usefulFiles: new UsefulFilesStore(root.path), agents: new AgentsStore(root.path), harnesses: new HarnessStore(root.path) }; rootContexts.set(rootId, context); }
    return context;
  };
  const savedTasks = await tasks.list();
  const workspaceOwners = new Map<string, string>([[path.resolve(rootWorkspace), roots.primary().id], ...savedTasks.tasks.map((task) => [path.resolve(tasks.taskPath(task.id)), roots.primary().id] as const)]);
  const ownerRootId = async (target: string): Promise<string | undefined> => {
    const resolved = path.resolve(target); const known = workspaceOwners.get(resolved); if (known) return known;
    const direct = roots.list().filter((root) => resolved === root.path || resolved.startsWith(`${root.path}${path.sep}`)).sort((left, right) => right.path.length - left.path.length)[0];
    if (direct) { workspaceOwners.set(resolved, direct.id); return direct.id; }
    for (const [rootId, context] of rootContexts) { const registry = await context.tasks.list(); if (registry.tasks.some((task) => path.resolve(context.tasks.taskPath(task.id)) === resolved)) { workspaceOwners.set(resolved, rootId); return rootId; } }
    return undefined;
  };
  if (savedTasks.selectedTaskId) workspacePath = tasks.taskPath(savedTasks.selectedTaskId);
  const validation = new WorkspaceFileSystem();
  await validation.open(workspacePath);
  const workspace = validation.getWorkspace();
  const workspaceState = new WorkspaceStateStore(workspace, process.env.REMOTE_IDE_STATE_DIR);
  const watcher = chokidar.watch(workspace, {
    ignoreInitial: true,
    ignored: (watchPath) => path.relative(workspace, watchPath).split(path.sep).some((part) => part === ".git" || part === "node_modules"),
    // chokidar 4 falls back to kqueue-backed fs.watch on macOS, which retains a
    // descriptor for every file. A root plus its task worktree can then leave
    // enough descriptors in flight for later Git/node-pty spawns to fail with
    // EBADF. Polling trades a little latency for a bounded descriptor count.
    usePolling: process.platform === "darwin",
    interval: 1_000,
    binaryInterval: 1_500,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  });
  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", resolve);
    watcher.once("error", reject);
  });
  const server = new WebSocketServer({ host, port });
  const remoteTransfers = new RemoteTransferService();
  const activeSessions = new Set<WebSocket>();
  const liveRootSelections = new LiveRootSelections<WebSocket>();
  const rootWatchSubscriptionsForServer = new Map<string, Set<SwitchedWatch>>();
  const rootWatchOwnersForServer = new Map<SwitchedWatch, () => void>();
  const removingRoots = new Set<string>();
  const terminalSubscriptions = new Map<WebSocket, { rootId: string; workspace: string; terminalIds: Set<string> }>();
  const terminalOwners = new Map<string, { socket: WebSocket; rootId: string; workspace: string }>();
  const workflowApps = new WorkflowAppService();
  let runConfigs: RunConfigService;
  const terminalHost = new TerminalSessionHost((event) => {
    runConfigs?.onTerminalEvent(event);
    const owner = terminalOwners.get(event.terminalId);
    if (owner && owner.workspace === event.workspace) {
      const message: ServerEvent = event.type === "output"
        ? { type: "terminal.output", payload: { rootId: owner.rootId, terminalId: event.terminalId, data: event.data } }
        : { type: "terminal.exit", payload: { rootId: owner.rootId, terminalId: event.terminalId, exitCode: event.exitCode } };
      sendWebSocketData(owner.socket, JSON.stringify(message));
    }
  });
  runConfigs = new RunConfigService(terminalHost, (changedWorkspace) => {
    void Promise.all([runConfigs.list(changedWorkspace), ownerRootId(changedWorkspace)]).then(([configs, rootId]) => { if (!rootId) return; const encoded = JSON.stringify({ type: "runConfig.changed", payload: { rootId, configs } } satisfies ServerEvent); for (const socket of activeSessions) sendWebSocketData(socket, encoded); });
  }, rootWorkspace);
  const runConfigWatcher = chokidar.watch([runConfigs.directory(rootWorkspace, "global"), runConfigs.directory(rootWorkspace, "local")], { ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
  runConfigWatcher.on("all", () => {
    for (const [changedWorkspace, rootId] of workspaceOwners) {
      void runConfigs.list(changedWorkspace).then((configs) => { const encoded = JSON.stringify({ type: "runConfig.changed", payload: { rootId, configs } } satisfies ServerEvent); for (const socket of activeSessions) sendWebSocketData(socket, encoded); });
    }
  });
  const appEvents = new AppEventBridge(rootWorkspace, undefined, appBridgeInstanceId);
  await appEvents.ready();
  const appEventWatcher = chokidar.watch(appEvents.directory, { ignoreInitial: true, depth: 0 });
  await new Promise<void>((resolve, reject) => { appEventWatcher.once("ready", resolve); appEventWatcher.once("error", reject); });
  appEventWatcher.on("add", (file) => {
    void appEvents.consume(file).then((event) => {
      if (!event) return;
      const rootId = roots.primary().id;
      const message: ServerEvent = event.type === "tasks.changed" ? { type: "tasks.changed", payload: { rootId } }
        : event.type === "ai.changed" ? { type: "ai.changed", payload: { rootId } }
        : { type: "commit-message.changed", payload: { rootId, message: event.message } };
      const encoded = JSON.stringify(message);
      for (const socket of activeSessions) sendWebSocketData(socket, encoded);
    }).catch((error) => console.error(`[core] app event error: ${error instanceof Error ? error.message : String(error)}`));
  });
  const aiChanged = (changedWorkspace: string) => {
    void ownerRootId(changedWorkspace).then((rootId) => { if (!rootId) return; const encoded = JSON.stringify({ type: "ai.changed", payload: { rootId } } satisfies ServerEvent); for (const socket of activeSessions) sendWebSocketData(socket, encoded); });
  };
  const checkpointStores = new Map<string, TaskCheckpointStore>();
  const checkpointStore = (target: string) => { const key = path.resolve(target); let store = checkpointStores.get(key); if (!store) { store = new TaskCheckpointStore(key); checkpointStores.set(key, store); } return store; };
  await Promise.all([rootWorkspace, ...savedTasks.tasks.map((task) => tasks.taskPath(task.id))].map((target) => checkpointStore(target).recover()));
  const taskGitChanged = (changedWorkspace: string) => { void ownerRootId(changedWorkspace).then((rootId) => { if (!rootId) return; const encoded = JSON.stringify({ type: "taskGit.changed", payload: { rootId } } satisfies ServerEvent); for (const socket of activeSessions) sendWebSocketData(socket, encoded); }); };
  const acp = createAcpRegistry(aiChanged, {
    begin: async (target, provider, prompt, sessionId, provenance) => { const id = await checkpointStore(target).begin(provider as AiProvider, prompt, sessionId, undefined, provenance); taskGitChanged(target); return id; },
    complete: async (target, ids, status, provenance) => { await Promise.all(ids.map((id) => checkpointStore(target).complete(id, status, provenance))); taskGitChanged(target); }
  }, async (target) => { const rootId = await ownerRootId(target); return rootId ? roots.get(rootId).path : rootWorkspace; }, rootWorkspace);
  const harnessRunners = new Map<string, HarnessRunner>();
  const harnessRunner = (rootId: string) => {
    let runner = harnessRunners.get(rootId);
    if (!runner) {
      runner = new HarnessRunner(contextFor(rootId).harnesses, (runId) => {
        const harnessEvent = JSON.stringify({ type: "harness.changed", payload: { rootId, runId } } satisfies ServerEvent);
        const tasksEvent = JSON.stringify({ type: "tasks.changed", payload: { rootId } } satisfies ServerEvent);
        for (const socket of activeSessions) { sendWebSocketData(socket, harnessEvent); sendWebSocketData(socket, tasksEvent); }
      }, 4, undefined, (document) => {
        const event = JSON.stringify({ type: "workflow.document", payload: { rootId, ...document } } satisfies ServerEvent);
        for (const socket of activeSessions) sendWebSocketData(socket, event);
      });
      harnessRunners.set(rootId, runner);
    }
    return runner;
  };
  const aiTimers = new AiTimerService(new AiTimerStore(rootWorkspace), acp, rootWorkspace, (workspace) => {
    aiChanged(workspace);
    const encoded = JSON.stringify({ type: "timers.changed", payload: {} } satisfies ServerEvent);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  }, (timer, effect, reconcile) => {
    if (!timer.workflowRunId || !timer.workflowBlockId) return effect();
    return harnessRunner(roots.primary().id).runTimerOperation(timer.workflowRunId, timer.workflowBlockId, `timer-fire:${timer.workflowOperationKey ?? timer.id}`, { timerId: timer.id, dueAt: timer.dueAt }, effect, reconcile);
  });
  const recoveryRunner = harnessRunner(roots.primary().id);
  const recoveryDispatch = async (block: HarnessBlock, prompt: string, runtime: Parameters<Parameters<HarnessRunner["start"]>[2]>[2]) => providerOperation(async () => {
    if (block.type === "script") return executeFlowScript(block, prompt, rootWorkspace, runtime.assertActive);
    if (block.type === "run_app") return workflowApps.execute(block, prompt, rootWorkspace, runtime.assertActive);
    const provider = acp.get(block.provider ?? "codex");
    await assertWorkflowModelAvailable(provider, block.model, block.reasoning);
    if (block.watchdog) return recoveryRunner.watch(runtime.runId, runtime.blockId, () => provider.usage());
    const sessionWorkspace = await workflowSessionWorkspace(rootWorkspace, runtime.runId, runtime.blockId); await runtime.started(sessionWorkspace);
    const agentFile = block.agent ? (await agents.list(rootWorkspace)).find((item) => item.scope === block.agent!.scope && item.name === block.agent!.name) : undefined;
    if (block.agent && !agentFile) throw new CoreError("FILE_NOT_FOUND", `Agent preset '${block.agent.name}' does not exist`);
    const appTools = withAppTools(rootWorkspace, sessionWorkspace, undefined, agentFile?.agent, provider.descriptor.id, rootWorkspace);
    const workflowTools = appToolServer(rootWorkspace, sessionWorkspace, provider.descriptor.id, rootWorkspace, { ...runtime, flow: ["ai", "chatbox"].includes(block.type) });
    const mcpServers = [...appTools.servers.filter((server) => server.name !== workflowTools.name), workflowTools];
    const workflowAgent = appTools.agent ? { ...appTools.agent, mcpServers: [...new Set([...(appTools.agent.mcpServers ?? []), workflowTools.name])] } : undefined;
    const autopilot = findAutopilotOption(provider.descriptor.options); const configuration = { ...(block.model ? { model: block.model } : {}), ...(block.reasoning ? { reasoning: block.reasoning } : {}), ...(autopilot ? { [autopilot.option.id]: autopilot.on } : {}) };
    runtime.assertActive(); await provider.startFreshSession(sessionWorkspace, { prompt, configuration, mcpServers, agent: workflowAgent, ...(block.agent ? { agentPreset: block.agent } : {}) }); runtime.assertActive();
    return settleWorkflowSession(provider, sessionWorkspace, aiTimers, undefined, () => recoveryRunner.isActive(runtime.runId), runtime.activity);
  });
  const recoveryAppend: NonNullable<Parameters<HarnessRunner["start"]>[4]> = async (block, prompt, runtime) => providerOperation(async () => {
    const provider = acp.get(block.provider ?? "codex"); if (!recoveryRunner.isActive(runtime.runId)) throw new Error("Workflow is no longer active"); const current = await provider.get(runtime.workspace);
    const workflowTools = appToolServer(rootWorkspace, runtime.workspace, provider.descriptor.id, rootWorkspace, { runId: runtime.runId, blockId: runtime.blockId, flow: ["ai", "chatbox"].includes(block.type) });
    if (current.status === "in_progress" || current.status === "user_prompt") await provider.steer(runtime.workspace, prompt);
    else await provider.send(runtime.workspace, { prompt, configuration: current.configuration ?? { model: current.model, reasoning: current.reasoning }, mcpServers: [workflowTools] });
    if (!recoveryRunner.isActive(runtime.runId)) throw new Error("Workflow is no longer active");
    return settleWorkflowSession(provider, runtime.workspace, aiTimers, undefined, () => recoveryRunner.isActive(runtime.runId), runtime.activity);
  });
  await recoveryRunner.recover(recoveryDispatch, "codex", recoveryAppend, {
    session: async (provider, target) => acp.get(provider).get(target).catch(() => undefined),
    timer: async (runId, blockId, provider, target) => { const timer = await aiTimers.next(target, provider); return timer?.workflowRunId === runId && timer.workflowBlockId === blockId; },
    child: async (child) => (await tasks.list()).tasks.some((task) => task.id === child.taskId && path.resolve(tasks.taskPath(task.id)) === path.resolve(child.workspace))
  });
  const scheduledPromptTargets = new Set<string>();
  const schedules = new ScheduleService(rootWorkspace, async (schedule, active) => {
    const root = roots.get(schedule.rootId);
    const context = contextFor(root.id);
    const task = schedule.taskId ? (await context.tasks.list()).tasks.find((item) => item.id === schedule.taskId) : undefined;
    if (schedule.taskId && (!task || task.archived || task.status === "finished")) throw new CoreError("INVALID_REQUEST", "Scheduled task is missing, archived, or finished");
    const target = task ? context.tasks.taskPath(task.id) : root.path;
    const action = schedule.action;
    const provider = acp.get(action.provider);
    if (action.type === "workflow") {
      const previous = schedule.lastWorkflowRunId ? (await context.harnesses.runs()).find((item) => item.id === schedule.lastWorkflowRunId) : undefined;
      if (previous && ["queued", "running", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"].includes(previous.status)) throw new CoreError("INVALID_REQUEST", "Previous scheduled workflow is still active; schedule paused to prevent overlap");
      if (!active()) return {};
      const run = await startWorkflow({ harnessId: action.harnessId, input: action.input, provider: action.provider, startBlockId: action.startBlockId }, { acp, tasks: context.tasks, agents: context.agents, harnessRunner: harnessRunner(root.id), workflowApps, aiTimers, rootWorkspace: root.path, bridgeWorkspace: rootWorkspace, workspacePath: target });
      return { workflowRunId: run.id };
    }
    const targetKey = `${target}\0${provider.descriptor.id}`;
    if (scheduledPromptTargets.has(targetKey)) throw new CoreError("INVALID_REQUEST", "Another schedule is starting this agent; schedule paused to prevent overlap");
    scheduledPromptTargets.add(targetKey);
    try {
      const session = await provider.get(target);
      if (session.status === "in_progress" || session.status === "user_prompt") throw new CoreError("INVALID_REQUEST", "Target agent is busy; schedule paused to preserve its current turn");
      const preset = action.agent ? (await context.agents.list(target)).find((item) => item.scope === action.agent!.scope && item.name === action.agent!.name) : undefined;
      if (action.agent && !preset) throw new CoreError("FILE_NOT_FOUND", "Scheduled agent preset no longer exists");
      const tools = withAppTools(root.path, target, undefined, preset?.agent, action.provider, rootWorkspace);
      if (!active()) return {};
      await provider.send(target, { prompt: action.prompt, configuration: session.configuration ?? { model: session.model, reasoning: session.reasoning }, mcpServers: tools.servers, agent: tools.agent, agentPreset: action.agent });
      return {};
    } finally { scheduledPromptTargets.delete(targetKey); }
  }, () => {
    const encoded = JSON.stringify({ type: "timers.changed", payload: {} } satisfies ServerEvent);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  });
  await aiTimers.start();
  const onTasksChanged = async () => {
    const encoded = JSON.stringify({ type: "tasks.changed", payload: { rootId: roots.primary().id } } satisfies ServerEvent);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  };
  const onCommitMessageChanged = async (changedWorkspace: string, message: string) => {
    const rootId = await ownerRootId(changedWorkspace); if (!rootId) return; const encoded = JSON.stringify({ type: "commit-message.changed", payload: { rootId, message } } satisfies ServerEvent); for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  };
  const appCommandWatcher = chokidar.watch(appEvents.commandsDirectory, { ignoreInitial: true, depth: 0 });
  await new Promise<void>((resolve, reject) => { appCommandWatcher.once("ready", resolve); appCommandWatcher.once("error", reject); });
  appCommandWatcher.on("add", (file) => {
    void appEvents.consumeCommand(file, async (command) => {
      const currentWorkspace = command.currentWorkspace ?? rootWorkspace;
      const workflowRootId = command.workflowRunId ? [...harnessRunners].find(([, runner]) => runner.isActive(command.workflowRunId!))?.[0] : undefined;
      const rootId = workflowRootId ?? await ownerRootId(currentWorkspace) ?? roots.primary().id; const root = roots.get(rootId); const context = contextFor(rootId);
      const changed = async () => { const encoded = JSON.stringify({ type: "tasks.changed", payload: { rootId } } satisfies ServerEvent); for (const socket of activeSessions) sendWebSocketData(socket, encoded); };
      if (command.workflowRunId && command.workflowBlockId && ["workflow_connections", "workflow_use_block", "workflow_block_messages", "workflow_choose_path"].includes(command.name)) return harnessRunner(rootId).flowTool(command.workflowRunId, command.workflowBlockId, command.name, command.args);
      const workflow = command.workflowRunId && command.workflowBlockId ? { runId: command.workflowRunId, blockId: command.workflowBlockId, resumeFailed: () => harnessRunner(rootId).resumeFailed(command.workflowRunId!, command.workflowBlockId!), runStack: (inputs: string[], path?: string) => harnessRunner(rootId).runStack(command.workflowRunId!, command.workflowBlockId!, inputs, path) } : undefined;
      const ownedWorkflow = workflow ? {
        ...workflow,
        flow: harnessRunner(rootId).isFlowBlock(workflow.runId, workflow.blockId),
        assertActive: () => { if (!harnessRunner(rootId).isActive(workflow.runId)) throw new Error("Workflow is no longer active"); },
        planFeatures: (features: Array<{ id: string; prompt: string; prerequisites?: string[] }>) => harnessRunner(rootId).planFeatures(workflow.runId, features),
        assertFeatureReady: (featureId: string) => harnessRunner(rootId).assertFeatureReady(workflow.runId, featureId),
        dispatchFeature: (featureId: string, taskId: string) => harnessRunner(rootId).dispatchFeature(workflow.runId, featureId, taskId),
        completeFeature: (taskId: string, commit: string) => harnessRunner(rootId).completeFeature(workflow.runId, taskId, commit),
        registerChild: (taskId: string, provider: AiProvider, workspace: string) => harnessRunner(rootId).registerChild(workflow.runId, { taskId, provider, workspace, blockId: workflow.blockId }),
        operation: <T>(kind: "timer_create" | "task_create" | "prompt_delivery" | "merge", key: string, input: unknown, effect: () => Promise<T>, reconcile?: () => Promise<T | null | undefined>) => harnessRunner(rootId).runOperation(workflow.runId, workflow.blockId, kind, key, input, effect, reconcile),
        recordTool: (name: string, args: Record<string, unknown>, result?: unknown, error?: unknown) => harnessRunner(rootId).recordTool(workflow.runId, workflow.blockId, name, args, result, error)
      } : undefined;
      const configuration = new ConfigurationService(root.path, currentWorkspace, { agents: context.agents, skills: new SkillsStore(undefined, root.path), useful: context.usefulFiles, workflows: context.harnesses, tasks: context.tasks }, acp, async (resource, global) => {
        const encoded = JSON.stringify({ type: "configuration.changed", payload: { rootId, resource, global } } satisfies ServerEvent);
        for (const socket of activeSessions) sendWebSocketData(socket, encoded);
        if (resource.startsWith("tasks/")) await changed();
      });
      return new AppToolService(context.tasks, acp, currentWorkspace, changed, onCommitMessageChanged, command.currentProvider, context.agents, root.path, aiTimers, rootWorkspace, ownedWorkflow, configuration, async (id) => {
        if (!command.currentProvider) throw new CoreError("INVALID_REQUEST", "Skill loading requires a provider conversation");
        const session = await acp.get(command.currentProvider).get(currentWorkspace);
        return new SkillsStore(undefined, root.path).load(currentWorkspace, id, session);
      }).call(command.name, command.args);
    });
  });
  const gitIndexWatcher = chokidar.watch(await gitIndexPath(workspace), { ignoreInitial: true });
  gitIndexWatcher.on("all", () => {
    const encoded = JSON.stringify({ type: "git.changed", payload: { rootId: roots.primary().id } } satisfies ServerEvent);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  });
  const rootBatcher = new WorkspaceWatchBatcher(roots.primary().id, (event) => {
    const encoded = JSON.stringify(event);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  });
  const broadcastChange = (absolutePath: string) => {
    const relativePath = path.relative(workspace, absolutePath).split(path.sep).join("/");
    if (relativePath && !relativePath.startsWith("..")) rootBatcher.change(relativePath);
  };
  watcher
    .on("add", broadcastChange).on("change", broadcastChange).on("unlink", broadcastChange).on("addDir", broadcastChange).on("unlinkDir", broadcastChange)
    .on("raw", (eventName) => { if (String(eventName).includes("OVERFLOW")) rootBatcher.degrade("Filesystem watcher overflow; synchronizing affected files."); })
    .on("error", (error) => { console.error(`[core] watcher error: ${String(error)}`); rootBatcher.degrade(`Filesystem watcher degraded: ${String(error)}`); });
  server.on("close", () => { schedules.close(); rootBatcher.dispose(); workflowApps.closeAll(); terminalHost.closeAll(); void watcher.close(); void gitIndexWatcher.close(); void runConfigWatcher.close(); void appEventWatcher.close(); void appCommandWatcher.close(); });
  server.on("listening", () => console.log(`[core] listening on ws://${host}:${port}`));
  server.on("connection", (socket, request) => {
    if (remoteTransfers.accepts(request.url)) { void remoteTransfers.attach(socket, request.url); return; }
    let protocolAccepted = false;
    let selectedRoot = roots.primary();
    liveRootSelections.connect(socket, selectedRoot.id);
    const makeServices = async (nextWorkspace: string, ownerRootId = selectedRoot.id): Promise<SessionServices> => {
      const filesystem = new WorkspaceFileSystem();
      await filesystem.open(nextWorkspace);
      workspaceOwners.set(path.resolve(nextWorkspace), ownerRootId);
      runConfigs.registerWorkspace(nextWorkspace, roots.get(ownerRootId).path);
      runConfigWatcher.add(runConfigs.directory(nextWorkspace, "local"));
      const workspaceState = new WorkspaceStateStore(nextWorkspace, process.env.REMOTE_IDE_STATE_DIR);
      const search = new WorkspaceSearch(filesystem);
      const git = new GitService(nextWorkspace);
      const jdt = new JdtLanguageService(filesystem);
      const java = new JavaProjectService(filesystem, workspaceState, (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const message: ServerEvent = event.type === "output" ? { type: "java.output", payload: { rootId: ownerRootId, data: event.data } }
        : event.type === "debug" ? { type: "java.debug.state", payload: { ...event.state, rootId: ownerRootId } }
        : { type: "java.exit", payload: { rootId: ownerRootId, exitCode: event.exitCode, signal: event.signal } };
      sendWebSocketData(socket, JSON.stringify(message));
      }, async () => {
        try { await jdt.rebuild(); }
        finally { if (socket.readyState === WebSocket.OPEN) sendWebSocketData(socket, JSON.stringify({ type: "java.semantic.changed", payload: { rootId: ownerRootId } } satisfies ServerEvent)); }
      });
      const checkpoints = checkpointStore(nextWorkspace); await checkpoints.recover();
      return { workspacePath: nextWorkspace, filesystem, search, git, java, jdt, workspaceState, checkpoints };
    };
    let servicesPromise: Promise<SessionServices>;
    /** Resolves once no task switch is in flight for this connection. */
    let switching: Promise<void> = Promise.resolve();
    const switchedWatches = new Map<string, SwitchedWatch>();
    const rootWatchSubscriptions = rootWatchSubscriptionsForServer;
    const closeSwitchedWatch = async (rootId: string, subscription: SwitchedWatch) => {
      rootWatchOwnersForServer.get(subscription)?.(); rootWatchOwnersForServer.delete(subscription);
      subscription.batcher.dispose(); await Promise.all([subscription.watcher.close(), subscription.gitWatcher.close()]);
      rootWatchSubscriptions.get(rootId)?.delete(subscription);
      if (!rootWatchSubscriptions.get(rootId)?.size) rootWatchSubscriptions.delete(rootId);
    };
    const prepareSwitchedWatch = async (nextWorkspace: string, ownerRootId = selectedRoot.id): Promise<SwitchedWatch | undefined> => {
      if (nextWorkspace === workspace) return undefined;
      const switchedWatcher = chokidar.watch(nextWorkspace, {
        ignoreInitial: true,
        ignored: (watchPath) => path.relative(nextWorkspace, watchPath).split(path.sep).some((part) => part === ".git" || part === "node_modules"),
        usePolling: process.platform === "darwin",
        interval: 1_000,
        binaryInterval: 1_500,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
      });
      // Subscribe immediately: on a small/cached worktree chokidar can become ready while
      // gitIndexPath() below is still running. Registering after that await misses the one-shot
      // event and leaves tasks.switch (and the renderer's switching state) pending forever.
      const watcherReady = new Promise<void>((resolve, reject) => {
        switchedWatcher.once("ready", resolve);
        switchedWatcher.once("error", reject);
      });
      const batcher = new WorkspaceWatchBatcher(ownerRootId, (event) => sendWebSocketData(socket, JSON.stringify(event)));
      const sendChange = (absolutePath: string) => {
        const relativePath = path.relative(nextWorkspace, absolutePath).split(path.sep).join("/");
        if (relativePath && !relativePath.startsWith("..")) batcher.change(relativePath);
      };
      switchedWatcher.on("add", sendChange).on("change", sendChange).on("unlink", sendChange).on("addDir", sendChange).on("unlinkDir", sendChange)
        .on("raw", (eventName) => { if (String(eventName).includes("OVERFLOW")) batcher.degrade("Filesystem watcher overflow; synchronizing affected files."); })
        .on("error", (error) => batcher.degrade(`Filesystem watcher degraded: ${String(error)}`));
      let switchedGitIndexWatcher: ReturnType<typeof chokidar.watch> | undefined;
      try {
        switchedGitIndexWatcher = chokidar.watch(await gitIndexPath(nextWorkspace), { ignoreInitial: true });
        switchedGitIndexWatcher.on("all", () => {
          sendWebSocketData(socket, JSON.stringify({ type: "git.changed", payload: { rootId: ownerRootId } } satisfies ServerEvent));
        });
        await watcherReady;
        return { watcher: switchedWatcher, gitWatcher: switchedGitIndexWatcher, batcher };
      } catch (error) {
        batcher.dispose(); await switchedWatcher.close(); await switchedGitIndexWatcher?.close(); throw error;
      }
    };
    const commitSwitchedWatch = async (rootId: string, next: SwitchedWatch | undefined) => {
      const previous = switchedWatches.get(rootId);
      if (next) {
        switchedWatches.set(rootId, next);
        let subscriptions = rootWatchSubscriptions.get(rootId); if (!subscriptions) { subscriptions = new Set(); rootWatchSubscriptions.set(rootId, subscriptions); }
        subscriptions.add(next);
        rootWatchOwnersForServer.set(next, () => { if (switchedWatches.get(rootId) === next) switchedWatches.delete(rootId); });
      } else switchedWatches.delete(rootId);
      if (previous) await closeSwitchedWatch(rootId, previous).catch((error) => console.error(`[core] watcher cleanup error: ${String(error)}`));
    };
    // Task selection is durable server state and may have changed since Core started. A fresh
    // post-sleep socket must be routed to that selected worktree before workspace.open runs.
    // Otherwise the renderer restores the selected task label while requests still hit the old
    // startup workspace until another explicit task switch happens.
    servicesPromise = (async () => {
      const registry = await tasks.list();
      const selectedWorkspace = registry.selectedTaskId ? tasks.taskPath(registry.selectedTaskId) : rootWorkspace;
      terminalSubscriptions.set(socket, { rootId: selectedRoot.id, workspace: selectedWorkspace, terminalIds: new Set() });
      await commitSwitchedWatch(selectedRoot.id, await prepareSwitchedWatch(selectedWorkspace));
      return makeServices(selectedWorkspace);
    })();
    const client = request.socket.remoteAddress ?? "unknown";
    console.log(`[core] connected: ${client}`);
    socket.on("message", async (data) => {
      let id = "unknown";
      try {
        const parsed = parseRequest(data);
        id = parsed.id;
        console.log(`[core] request ${parsed.id}: ${parsed.type}`);
        if (parsed.type === "protocol.handshake") {
          if (protocolAccepted) throw new CoreError("INVALID_REQUEST", "Protocol handshake has already completed");
          const result = protocolHandshake(parsed.payload.compatibility);
          const compatible = result.compatible;
          sendWebSocketData(socket, JSON.stringify({ id, ok: true, result } satisfies Response));
          if (!compatible) setTimeout(() => socket.close(1008, "Incompatible protocol"), 0);
          else protocolAccepted = true;
          return;
        }
        if (!protocolAccepted) throw new CoreError("INVALID_REQUEST", "Complete protocol.handshake before sending requests");
        if (parsed.type === "workspace.roots") {
          sendWebSocketData(socket, JSON.stringify({ id, ok: true, result: { roots: roots.list(), selectedRootId: selectedRoot.id } }));
          return;
        }
        if (parsed.type === "workspace.addRoot") {
          const root = await roots.add(parsed.payload.path, parsed.payload.alias);
          sendWebSocketData(socket, JSON.stringify({ id, ok: true, result: { root, roots: roots.list() } }));
          return;
        }
        assertRequestRoot(parsed, selectedRoot.id);
        if (parsed.type === "workspace.removeRoot") {
          assertRootRemovalAllowed(liveRootSelections, parsed.payload.rootId);
          const target = roots.get(parsed.payload.rootId);
          const targetContext = contextFor(target.id);
          if (workflowApps.hasWorkspace(target.path)) throw new CoreError("INVALID_REQUEST", "Kill running workflow apps before removing this root");
          const [targetTasks, targetOptions] = await Promise.all([targetContext.tasks.list(), new WorkspaceStateStore(target.path, process.env.REMOTE_IDE_STATE_DIR).load()]);
          const blocker = rootRemovalBlocker({ tasks: targetTasks.tasks.length, openFiles: targetOptions.openFiles.length, terminals: terminalHost.hasWorkspace(target.path), transfers: remoteTransfers.hasWorkspace(target.path) });
          if (blocker) throw new CoreError("INVALID_REQUEST", blocker);
          assertRootRemovalAllowed(liveRootSelections, target.id);
          removingRoots.add(target.id);
          try {
            const subscriptions = [...(rootWatchSubscriptions.get(target.id) ?? [])];
            await Promise.all(subscriptions.map((subscription) => closeSwitchedWatch(target.id, subscription)));
            await roots.remove(parsed.payload.rootId);
            rootContexts.delete(parsed.payload.rootId);
          } finally { removingRoots.delete(target.id); }
          sendWebSocketData(socket, JSON.stringify({ id, ok: true, rootId: parsed.rootId, result: { roots: roots.list(), selectedRootId: selectedRoot.id } }));
          return;
        }
        if (parsed.type === "filesystem.searchRoots") {
          const rootIds = [...new Set(parsed.payload.rootIds)]; if (!rootIds.length || rootIds.length > 16) throw new CoreError("INVALID_REQUEST", "Search must name between 1 and 16 registered roots");
          const results = await Promise.all(rootIds.map(async (rootId) => {
            const root = roots.get(rootId); const context = contextFor(rootId); const taskRegistry = await context.tasks.list(); const target = taskRegistry.selectedTaskId ? context.tasks.taskPath(taskRegistry.selectedTaskId) : root.path;
            const filesystem = new WorkspaceFileSystem(); await filesystem.open(target); const result = await new WorkspaceSearch(filesystem).search(parsed.payload.query, parsed.payload.path, parsed.payload.matchCase, { include: parsed.payload.include, exclude: parsed.payload.exclude });
            return { matches: result.matches.map((match) => ({ ...match, rootId })), truncated: result.truncated };
          }));
          const matches = results.flatMap((result) => result.matches).slice(0, 500); sendWebSocketData(socket, JSON.stringify({ id, ok: true, rootId: parsed.rootId, result: { matches, truncated: results.some((result) => result.truncated) || results.reduce((count, result) => count + result.matches.length, 0) > matches.length } })); return;
        }
        if (parsed.type === "filesystem.readRootFile") {
          const root = roots.get(parsed.payload.targetRootId); const context = contextFor(root.id); const taskRegistry = await context.tasks.list(); const target = taskRegistry.selectedTaskId ? context.tasks.taskPath(taskRegistry.selectedTaskId) : root.path;
          const filesystem = new WorkspaceFileSystem(); await filesystem.open(target); const file = await filesystem.read(parsed.payload.path); sendWebSocketData(socket, JSON.stringify({ id, ok: true, rootId: parsed.rootId, result: { rootId: root.id, path: parsed.payload.path, ...file } })); return;
        }
        // Requests are handled concurrently, so anything that arrives while a task switch is
        // rebuilding the services has to wait for it. Otherwise it would run against the
        // previous worktree and answer the client with another task's state.
        const rootContext = contextFor(parsed.type === "workspace.selectRoot" ? parsed.payload.rootId : selectedRoot.id);
        const switchesWorkspace = parsed.type === "tasks.switch" || parsed.type === "tasks.delete" || parsed.type === "workspace.selectRoot";
        if (!switchesWorkspace) await switching;
        let release: (() => void) | undefined;
        if (switchesWorkspace) { const previous = switching; switching = new Promise<void>((resolve) => { release = resolve; }); await previous; }
        let services: SessionServices;
        let rootSelectionResult: { root: WorkspaceRoot; workspace: string; projectName: string; tree: FileTreeNode[]; options: WorkspaceOptions } | undefined;
        try {
          services = await servicesPromise;
          if (parsed.type === "workspace.selectRoot") {
            const nextRoot = roots.get(parsed.payload.rootId);
            if (removingRoots.has(nextRoot.id)) throw new CoreError("INVALID_REQUEST", "Workspace root is being removed");
            liveRootSelections.beginSelection(socket, nextRoot.id);
            const previousServices = services;
            let candidate: { nextServices: SessionServices; nextWatch: SwitchedWatch | undefined; result: { root: WorkspaceRoot; workspace: string; projectName: string; tree: FileTreeNode[]; options: WorkspaceOptions } };
            try { candidate = await transactionalRootSelection(async () => {
              const nextServices = await makeServices(nextRoot.path, nextRoot.id);
              let nextWatch: SwitchedWatch | undefined;
              try {
                nextWatch = await prepareSwitchedWatch(nextRoot.path, nextRoot.id);
                const result = { root: nextRoot, workspace: nextServices.workspacePath, projectName: nextRoot.alias, tree: await nextServices.filesystem.listTree(parsed.payload.includeIgnored === true), options: await nextServices.workspaceState.load() };
                return { nextServices, nextWatch, result };
              } catch (error) { nextServices.java.close(); nextServices.jdt.close(); if (nextWatch) await closeSwitchedWatch(nextRoot.id, nextWatch); throw error; }
            }, async ({ nextServices, nextWatch }) => {
              await commitSwitchedWatch(nextRoot.id, nextWatch);
              await selectRootWorkspace(rootContext.tasks);
              selectedRoot = nextRoot; liveRootSelections.select(socket, nextRoot.id);
              servicesPromise = Promise.resolve(nextServices);
              terminalSubscriptions.set(socket, { rootId: nextRoot.id, workspace: nextRoot.path, terminalIds: new Set() });
              previousServices.java.close(); previousServices.jdt.close();
            }, async ({ nextServices, nextWatch }) => {
              nextServices.java.close(); nextServices.jdt.close(); if (nextWatch) await closeSwitchedWatch(nextRoot.id, nextWatch);
            }); } catch (error) { liveRootSelections.cancelSelection(socket); throw error; }
            services = candidate.nextServices; rootSelectionResult = candidate.result;
          } else if (parsed.type === "tasks.switch" || (parsed.type === "tasks.delete" && (await rootContext.tasks.list()).selectedTaskId === parsed.payload.taskId)) {
            const selected = await rootContext.tasks.select(parsed.type === "tasks.switch" ? parsed.payload.taskId : undefined);
            services.java.close(); services.jdt.close();
            servicesPromise = makeServices(selected.workspace);
            services = await servicesPromise;
            terminalSubscriptions.set(socket, { rootId: selectedRoot.id, workspace: selected.workspace, terminalIds: new Set() });
            await commitSwitchedWatch(selectedRoot.id, await prepareSwitchedWatch(selected.workspace));
          }
        } finally { release?.(); }
        const result = parsed.type === "workspace.selectRoot"
          ? rootSelectionResult!
          : await handleRequest(services, rootContext.tasks, acp, rootContext.usefulFiles, rootContext.agents, rootContext.harnesses, harnessRunner(selectedRoot.id), workflowApps, terminalHost, runConfigs, aiTimers, schedules, remoteTransfers, selectedRoot.path, parsed, rootWorkspace);
        if (["tasks.create", "tasks.createFromPrompt", "tasks.status", "tasks.rename", "tasks.archive", "tasks.delete"].includes(parsed.type)) { const encoded = JSON.stringify({ type: "tasks.changed", payload: { rootId: selectedRoot.id } } satisfies ServerEvent); for (const session of activeSessions) sendWebSocketData(session, encoded); }
        const terminalSubscription = terminalSubscriptions.get(socket);
        if (terminalSubscription && parsed.type === "terminal.create") { const terminalId = (result as { terminalId: string }).terminalId; terminalSubscription.terminalIds.add(terminalId); terminalOwners.set(terminalId, { socket, rootId: parsed.rootId, workspace: services.workspacePath }); }
        if (terminalSubscription && parsed.type === "terminal.attach" && (result as { state: string }).state === "available") { terminalSubscription.terminalIds.add(parsed.payload.terminalId); terminalOwners.set(parsed.payload.terminalId, { socket, rootId: parsed.rootId, workspace: services.workspacePath }); }
        if (terminalSubscription && parsed.type === "terminal.close") { terminalSubscription.terminalIds.delete(parsed.payload.terminalId); terminalOwners.delete(parsed.payload.terminalId); }
        if (terminalSubscription && (parsed.type === "runConfig.run" || parsed.type === "runConfig.restart" || parsed.type === "runConfig.openTerminal")) {
          const terminalId = (result as { config: { terminalId?: string } }).config.terminalId; if (terminalId) terminalSubscription.terminalIds.add(terminalId);
        }
        if (parsed.type === "workspace.open") activeSessions.add(socket);
        sendWebSocketData(socket, JSON.stringify({ id, ok: true, rootId: parsed.rootId, result }));
      } catch (error) {
        const coreError = error instanceof CoreError ? error : new CoreError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid request");
        console.error(`[core] error ${id}: ${coreError.code} ${coreError.message}`);
        sendWebSocketData(socket, JSON.stringify({ id, ok: false, error: { code: coreError.code, message: coreError.message } } satisfies Response));
      }
    });
    socket.on("close", () => {
      activeSessions.delete(socket);
      liveRootSelections.disconnect(socket);
      terminalSubscriptions.delete(socket);
      for (const [rootId, subscription] of switchedWatches) void closeSwitchedWatch(rootId, subscription);
      void servicesPromise.then((services) => { services.java.close(); services.jdt.close(); });
      console.log(`[core] disconnected: ${client}`);
    });
    socket.on("error", (error) => console.error(`[core] socket error: ${error.message}`));
  });
  await schedules.start();
  return server;
}

async function gitIndexPath(workspace: string): Promise<string> {
  const value = (await execFileAsync("git", ["-C", workspace, "rev-parse", "--git-path", "index"], { encoding: "utf8" })).stdout.trim();
  return path.isAbsolute(value) ? value : path.resolve(workspace, value);
}

function parseRequest(data: RawData): Request {
  let value: unknown;
  try { value = JSON.parse(data.toString()); } catch { throw new CoreError("INVALID_REQUEST", "Message must be valid JSON"); }
  if (!value || typeof value !== "object") throw new CoreError("INVALID_REQUEST", "Request must be an object");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string" || !("payload" in candidate) || (candidate.type !== "protocol.handshake" && !requestTypes.includes(candidate.type as RequestType))) {
    throw new CoreError("INVALID_REQUEST", "Request must contain a valid id, type, and payload");
  }
  return value as Request;
}

export function assertRequestRoot(request: Request, selectedRootId: string): void {
  if (request.type === "protocol.handshake" || request.type === "workspace.roots" || request.type === "workspace.addRoot") return;
  if (!request.rootId) throw new CoreError("INVALID_REQUEST", `Request ${request.type} requires an explicit rootId`);
  if (request.type !== "workspace.selectRoot" && request.rootId !== selectedRootId) throw new CoreError("INVALID_REQUEST", `Request root ${request.rootId} is not the selected root ${selectedRootId}`);
}

export async function selectRootWorkspace(tasks: Pick<WorkspaceTaskStore, "select">): Promise<void> {
  await tasks.select(undefined);
}

export function rootRemovalBlocker(state: { tasks: number; openFiles: number; terminals: boolean; transfers: boolean }): string | undefined {
  if (state.tasks) return "Remove or relocate this root's task worktrees before unregistering it";
  if (state.openFiles) return "Close this root's persisted open files before unregistering it";
  if (state.terminals) return "Close this root's terminal sessions before unregistering it";
  if (state.transfers) return "Finish or cancel this root's file transfers before unregistering it";
  return undefined;
}

async function handleRequest(services: SessionServices, tasks: WorkspaceTaskStore, acp: AcpRegistry, usefulFiles: UsefulFilesStore, agents: AgentsStore, harnesses: HarnessStore, harnessRunner: HarnessRunner, workflowApps: WorkflowAppService, terminalHost: TerminalSessionHost, runConfigs: RunConfigService, aiTimers: AiTimerService, schedules: ScheduleService, remoteTransfers: RemoteTransferService, rootWorkspace: string, request: Request, bridgeWorkspace = rootWorkspace): Promise<unknown> {
  const { filesystem, search, git, java, jdt, workspaceState, workspacePath, checkpoints } = services;
  if (request.type !== "workspace.open") filesystem.getWorkspace();
  if (request.type === "filesystem.remoteTransferBegin") return remoteTransfers.begin(workspacePath, request.payload);
  if (request.type === "filesystem.remoteTransferCancel") return { cancelled: remoteTransfers.cancel(request.payload.token) };
  switch (request.type) {
    case "workspace.open": {
      const tree = await filesystem.open(workspacePath, request.payload.includeIgnored === true);
      return { workspace: filesystem.getWorkspace(), projectName: path.basename(path.resolve(rootWorkspace)), tree, options: await workspaceState.load() };
    }
    case "workspace.saveOptions": {
      await workspaceState.save(request.payload.options);
      return {};
    }
    case "tasks.list": return tasks.list();
    case "tasks.create": return { task: await tasks.create(request.payload.branch, request.payload.existing, request.payload.remote) };
    case "tasks.createFromPrompt": {
      if (workspacePath !== rootWorkspace) throw new CoreError("INVALID_REQUEST", "New tasks can only be started from the root workspace");
      const task = await tasks.createRandom(false);
      try {
        const appTools = withAppTools(rootWorkspace, tasks.taskPath(task.id), request.payload.mcpServers, request.payload.agent, request.payload.provider, bridgeWorkspace);
        await acp.get(request.payload.provider).send(tasks.taskPath(task.id), {
          prompt: request.payload.prompt,
          content: request.payload.content,
          configuration: request.payload.configuration,
          mcpServers: appTools.servers,
          agent: appTools.agent,
          agentPreset: request.payload.agentPreset,
          skillIds: request.payload.skillIds
        });
        return { task };
      } catch (error) {
        await tasks.delete(task.id).catch(() => undefined);
        throw error;
      }
    }
    case "tasks.merge": return tasks.merge(request.payload.taskId, request.payload.strategy);
    case "schedules.agents": {
      const task = request.payload.taskId ? (await tasks.list()).tasks.find((item) => item.id === request.payload.taskId) : undefined;
      if (request.payload.taskId && !task) throw new CoreError("FILE_NOT_FOUND", "Task no longer exists");
      return { agents: await agents.list(task ? tasks.taskPath(task.id) : rootWorkspace) };
    }
    case "schedules.list": return { schedules: schedules.list() };
    case "schedules.create": {
      validateSchedule(request.payload);
      const task = request.payload.taskId ? (await tasks.list()).tasks.find((item) => item.id === request.payload.taskId) : undefined;
      if (request.payload.taskId && (!task || task.archived || task.status === "finished")) throw new CoreError("INVALID_REQUEST", "Choose an active task");
      acp.get(request.payload.action.provider);
      if (request.payload.action.type === "workflow") {
        const action = request.payload.action;
        const workflow = await harnesses.read(action.harnessId);
        const starts = workflow.blocks.filter((block) => block.type === "start_button" || block.type === "start_input");
        if (starts.length > 1 && !action.startBlockId) throw new CoreError("INVALID_REQUEST", "Choose a workflow start block");
        if (action.startBlockId && !starts.some((block) => block.id === action.startBlockId)) throw new CoreError("INVALID_REQUEST", "Workflow start block no longer exists");
      }
      if (request.payload.action.type === "prompt" && request.payload.action.agent) {
        const preset = request.payload.action.agent;
        if (!(await agents.list(task ? tasks.taskPath(task.id) : rootWorkspace)).some((item) => item.scope === preset.scope && item.name === preset.name)) throw new CoreError("FILE_NOT_FOUND", "Agent preset does not exist in the selected task");
      }
      return { schedule: await schedules.create(request.rootId!, request.payload) };
    }
    case "schedules.enabled": return { schedule: await schedules.setEnabled(request.payload.scheduleId, request.payload.enabled) };
    case "schedules.delete": return { deleted: await schedules.delete(request.payload.scheduleId) };
    case "schedules.fire": return { fired: await schedules.fire(request.payload.scheduleId, true) };
    case "timers.list": return { timers: await aiTimers.list() };
    case "timers.cancel": return { cancelled: await aiTimers.cancel(request.payload.timerId) };
    case "timers.fire": return { fired: await aiTimers.fireById(request.payload.timerId) };
    case "timers.cancelAll": {
      let pausedSchedules = 0;
      for (const schedule of schedules.list()) if (schedule.enabled) { await schedules.setEnabled(schedule.id, false); pausedSchedules += 1; }
      return { cancelled: await aiTimers.cancelAll(), pausedSchedules };
    }
    case "tasks.timer.cancel": {
      const target = await permissionTargetWorkspace(tasks, rootWorkspace, request.payload.taskId);
      return { cancelled: await aiTimers.cancelNext(target) };
    }
    case "tasks.timer.fire": {
      const target = await permissionTargetWorkspace(tasks, rootWorkspace, request.payload.taskId);
      return { fired: await aiTimers.fireNext(target) };
    }
    case "tasks.status": return { task: await tasks.setStatus(request.payload.taskId, request.payload.status) };
    case "tasks.rename": return { task: await tasks.rename(request.payload.taskId, request.payload.name) };
    case "tasks.archive": return { task: await tasks.setArchived(request.payload.taskId, request.payload.archived) };
    case "tasks.delete": {
      await aiTimers.cancelWorkspace(tasks.taskPath(request.payload.taskId));
      const result = await tasks.delete(request.payload.taskId);
      terminalHost.closeWorkspace(tasks.taskPath(request.payload.taskId));
      return result;
    }
    case "tasks.switch": {
      const registry = await tasks.list();
      return { workspace: workspacePath, projectName: path.basename(path.resolve(rootWorkspace)), tree: await filesystem.listTree(request.payload.includeIgnored === true), options: await workspaceState.load(), ...registry };
    }
    case "skills.list": return new SkillsStore(undefined, rootWorkspace).list(workspacePath);
    case "skills.read": return { content: await new SkillsStore(undefined, rootWorkspace).read(request.payload.id, workspacePath) };
    case "skills.write": await new SkillsStore(undefined, rootWorkspace).write(request.payload.id, workspacePath, request.payload.content); return {};
    case "skills.delete": await new SkillsStore(undefined, rootWorkspace).delete(request.payload.id, workspacePath); return {};
    case "skills.policy.moveToLocal": await new SkillsStore(undefined, rootWorkspace).movePolicyToLocal(workspacePath); return {};
    case "skills.policy": await new SkillsStore(undefined, rootWorkspace).writePolicy(workspacePath, request.payload); return {};
    case "ai.skills": return { session: await acp.get(request.payload.provider).setSkills(workspacePath, request.payload.ids, request.payload.sessionId, request.payload.agentPreset) };
    case "ai.providers": return { providers: acp.list() };
    case "ai.get": return { session: await acp.get(request.payload.provider).get(workspacePath) };
    case "ai.models": return { models: await acp.get(request.payload.provider).models() };
    case "ai.configure": return { session: await acp.get(request.payload.provider).configure(workspacePath, { ...request.payload.configuration, ...(request.payload.model ? { model: request.payload.model } : {}), ...(request.payload.reasoning ? { reasoning: request.payload.reasoning } : {}) }) };
    case "ai.send": {
      const appTools = withAppTools(rootWorkspace, workspacePath, request.payload.mcpServers, request.payload.agent, request.payload.provider, bridgeWorkspace);
      return { session: await acp.get(request.payload.provider).send(workspacePath, { prompt: request.payload.prompt, content: request.payload.content, configuration: { ...request.payload.configuration, ...(request.payload.model ? { model: request.payload.model } : {}), ...(request.payload.reasoning ? { reasoning: request.payload.reasoning } : {}) }, mcpServers: appTools.servers, agent: appTools.agent, agentPreset: request.payload.agentPreset }) };
    }
    case "ai.permission.resolve": {
      // Permission cards can remain mounted while the user changes tasks. A target supplied by the
      // renderer must therefore win over this connection's selected workspace, which may already
      // point somewhere else by the time the click reaches the server.
      const targetWorkspace = request.payload.target
        ? await permissionTargetWorkspace(tasks, rootWorkspace, request.payload.target.taskId)
        : workspacePath;
      const provider = acp.get(request.payload.provider);
      const session = await provider.get(targetWorkspace);
      if (request.payload.target?.sessionId && session.id !== request.payload.target.sessionId) throw new CoreError("INVALID_REQUEST", "Permission request belongs to a different conversation");
      if (session.pendingPermission?.id !== request.payload.requestId) throw new CoreError("INVALID_REQUEST", "Permission request is no longer pending");
      return { session: await provider.resolvePermission(targetWorkspace, request.payload.requestId, request.payload.optionId) };
    }
    case "ai.interrupt": {
      const provider = acp.get(request.payload.provider);
      await aiTimers.cancelProvider(workspacePath, provider.descriptor.id);
      try { return { session: await provider.interrupt(workspacePath) }; }
      finally { await aiTimers.cancelProvider(workspacePath, provider.descriptor.id); }
    }
    case "ai.steer": return { session: await acp.get(request.payload.provider).steer(workspacePath, request.payload.prompt) };
    case "ai.clear": {
      const provider = acp.get(request.payload.provider);
      await assertSessionChangeAllowed(aiTimers, workspacePath, provider.descriptor.id);
      return { session: await provider.clear(workspacePath) };
    }
    case "ai.sessions": return { sessions: await acp.get(request.payload.provider).sessions(workspacePath) };
    case "ai.restore": {
      const provider = acp.get(request.payload.provider);
      await assertSessionChangeAllowed(aiTimers, workspacePath, provider.descriptor.id);
      return { session: await provider.restore(workspacePath, request.payload.sessionId) };
    }
    case "ai.remove": {
      const provider = acp.get(request.payload.provider);
      await assertSessionChangeAllowed(aiTimers, workspacePath, provider.descriptor.id);
      return { session: await provider.remove(workspacePath, request.payload.sessionId) };
    }
    case "ai.usage": return { usage: await acp.get(request.payload.provider).usage(workspacePath) };
    case "ai.statuses": {
      const registry = await tasks.list();
      const summarize = async (target: string) => {
        const summary = summarizeAiSessions(await Promise.all(acp.list().map((item) => acp.get(item.id).get(target))));
        const timer = await aiTimers.next(target);
        return { ...summary, ...(timer ? { ...(summary.status !== "in_progress" && summary.status !== "user_prompt" ? { status: "waiting" as const } : {}), waitingUntil: timer.dueAt } : {}), ...await new GitService(target).diffStats() };
      };
      const entries = await Promise.all(registry.tasks.map(async (task) => [task.id, await summarize(tasks.taskPath(task.id))] as const));
      return { root: await summarize(rootWorkspace), tasks: Object.fromEntries(entries) };
    }
    case "useful.list": return { files: await usefulFiles.list() };
    case "useful.read": return { content: await usefulFiles.read(request.payload.scope, request.payload.name) };
    case "useful.create": await usefulFiles.create(request.payload.scope, request.payload.name); return {};
    case "useful.write": await usefulFiles.write(request.payload.scope, request.payload.name, request.payload.content); return {};
    case "useful.rename": await usefulFiles.rename(request.payload.scope, request.payload.name, request.payload.newName); return {};
    case "useful.delete": await usefulFiles.delete(request.payload.scope, request.payload.name); return {};
    case "runConfig.list": return { configs: await runConfigs.list(workspacePath) };
    case "runConfig.create": return { config: await runConfigs.create(workspacePath, request.payload.scope, request.payload.name, request.payload.commands) };
    case "runConfig.read": return { config: await runConfigs.read(workspacePath, request.payload.scope, request.payload.name) };
    case "runConfig.write": return { config: await runConfigs.write(workspacePath, request.payload.scope, request.payload.name, request.payload.commands) };
    case "runConfig.rename": return { config: await runConfigs.rename(workspacePath, request.payload.scope, request.payload.name, request.payload.newName) };
    case "runConfig.delete": await runConfigs.delete(workspacePath, request.payload.scope, request.payload.name); return {};
    case "runConfig.run": return { config: await runConfigs.run(workspacePath, request.payload.scope, request.payload.name) };
    case "runConfig.stop": return { config: await runConfigs.stop(workspacePath, request.payload.scope, request.payload.name) };
    case "runConfig.restart": return { config: await runConfigs.restart(workspacePath, request.payload.scope, request.payload.name) };
    case "runConfig.openTerminal": return { config: await runConfigs.read(workspacePath, request.payload.scope, request.payload.name) };
    case "agents.list": return { agents: await agents.list(workspacePath) };
    case "agents.read": return { content: await agents.read(request.payload.scope, request.payload.name, workspacePath) };
    case "agents.create": await agents.create(request.payload.scope, request.payload.name, workspacePath); return {};
    case "agents.write": await agents.write(request.payload.scope, request.payload.name, request.payload.content, workspacePath); return {};
    case "agents.rename": return { name: await agents.rename(request.payload.scope, request.payload.name, request.payload.newName, workspacePath) };
    case "agents.delete": await agents.delete(request.payload.scope, request.payload.name, workspacePath); return {};
    case "harnesses.list": return { harnesses: await harnesses.list(), diagnostics: await harnesses.diagnostics() };
    case "harnesses.read": return { harness: await harnesses.read(request.payload.id) };
    case "harnesses.create": return { harness: await harnesses.create(request.payload.name, request.payload.template) };
    case "harnesses.update": {
      const validation = validateHarness(request.payload.harness);
      if (!validation.valid && request.payload.harness.blocks.length) throw new CoreError("INVALID_REQUEST", validation.issues.map((issue) => issue.message).join("; "));
      return { harness: await harnesses.update(request.payload.harness) };
    }
    case "harnesses.delete": await harnesses.delete(request.payload.id); return {};
    case "harnesses.validate": return validateHarness(request.payload.harness);
    case "harnesses.runs": return { runs: await harnesses.runs(request.payload.harnessId) };
    case "harnesses.runs.delete": await harnesses.deleteRun(request.payload.runId); return {};
    case "harnesses.test": {
      const { definition, blockId, input, provider } = request.payload;
      return { run: await startWorkflow({ harnessId: definition.id, input, provider, startBlockId: blockId, testDefinition: definition }, { acp, tasks, agents, harnessRunner, workflowApps, aiTimers, rootWorkspace, bridgeWorkspace, workspacePath }) };
    }
    case "harnesses.app.read":
    case "harnesses.app.kill": {
      const { harnessId, blockId, runId } = request.payload;
      const run = runId ? (await harnesses.runs(harnessId)).find((run) => run.id === runId) : undefined;
      if (runId && !run) throw new CoreError("FILE_NOT_FOUND", "Workflow run does not exist");
      const definition = run?.definition ?? await harnesses.read(harnessId);
      const block = definition.blocks.find((block) => block.id === blockId);
      if (block?.type !== "run_app" || !block.app) throw new CoreError("INVALID_REQUEST", "Selected block is not a Run App");
      if (request.type === "harnesses.app.read") return { app: workflowApps.read(block.app.name, workspacePath) };
      await workflowApps.execute({ ...block, app: { ...block.app, actions: ["kill"] } }, '{"action":"kill"}', workspacePath, () => {});
      return {};
    }
    case "harnesses.run": return { run: await startWorkflow(request.payload, { acp, tasks, agents, harnessRunner, workflowApps, aiTimers, rootWorkspace, bridgeWorkspace, workspacePath }) };
    case "harnesses.chat": {
      const payload = request.payload;
      if (typeof payload.input !== "string" || !payload.input.trim() || payload.input.length > 100_000) throw new CoreError("INVALID_REQUEST", "Chat input must contain 1–100,000 characters");
      const existing = payload.runId ? (await harnesses.runs()).find((run) => run.id === payload.runId) : undefined;
      if (payload.runId && (!existing || existing.harnessId !== payload.harnessId)) throw new CoreError("INVALID_REQUEST", "Chat run does not belong to this workflow");
      const definition = existing?.definition ?? await harnesses.read(payload.harnessId);
      if (definition.blocks.find((block) => block.id === payload.blockId)?.type !== "chatbox") throw new CoreError("INVALID_REQUEST", "Select a Chatbox block");
      return { run: await startWorkflow({ harnessId: payload.harnessId, input: payload.input, startBlockId: payload.blockId, chatRunId: payload.runId, provider: existing?.blocks.find((block) => block.blockId === payload.blockId)?.provider ?? payload.provider }, { acp, tasks, agents, harnessRunner, workflowApps, aiTimers, rootWorkspace, bridgeWorkspace, workspacePath }) };
    }
    case "harnesses.append": return { run: await harnessRunner.appendInput(request.payload.runId, request.payload.input) };
    case "harnesses.permission.resolve": return { run: await harnessRunner.resolvePermission(request.payload.runId, request.payload.blockId, request.payload.sessionId, request.payload.pauseId, request.payload.requestId, request.payload.optionId, async (provider, target, requestId, optionId) => acp.get(provider).resolvePermission(target, requestId, optionId)) };
    case "harnesses.answer": return { run: await harnessRunner.answerQuestion(request.payload.runId, request.payload.blockId, request.payload.sessionId, request.payload.pauseId, request.payload.input, async (provider, target, input) => acp.get(provider).steer(target, input)) };
    case "harnesses.pause.resume": return { run: await harnessRunner.resumeTimer(request.payload.runId, request.payload.blockId, request.payload.pauseId, (provider, target) => aiTimers.fireNext(target, provider)) };
    case "harnesses.pause.retry": return { run: await harnessRunner.retryPause(request.payload.runId, request.payload.blockId, request.payload.pauseId) };
    case "harnesses.pause.cancel": return { run: await harnessRunner.cancelPause(request.payload.runId, request.payload.blockId, request.payload.pauseId, async (provider, runtime) => { const target = runtime.workspace ?? await workflowSessionWorkspace(workspacePath, runtime.runId, runtime.blockId); await aiTimers.cancelWorkspace(target); await acp.get(provider).interrupt(target); }) };
    case "harnesses.cancel": return { run: await harnessRunner.cancel(request.payload.runId, async (provider, runtime) => { const target = runtime.workspace ?? await workflowSessionWorkspace(workspacePath, runtime.runId, runtime.blockId); await aiTimers.cancelWorkspace(target); await acp.get(provider).interrupt(target); }) };
    case "http.execute": return executeHttpRequest(request.payload.method, request.payload.url, request.payload.headers, request.payload.body);
    case "filesystem.listTree": return { tree: await filesystem.listTree(request.payload.includeIgnored === true) };
    case "filesystem.snapshot": return { entries: await filesystem.snapshot(request.payload.paths) };
    case "filesystem.readFile": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      const file = await filesystem.read(request.payload.path);
      return { path: request.payload.path, ...file };
    }
    case "filesystem.writeFile": {
      if (typeof request.payload.path !== "string" || typeof request.payload.content !== "string") throw new CoreError("INVALID_REQUEST", "path and content must be strings");
      const file = await filesystem.write(request.payload.path, request.payload.content, request.payload.expectedRevision, request.payload.force === true, request.payload.create === true);
      return { path: request.payload.path, ...file };
    }
    case "filesystem.createFile": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      await filesystem.createFile(request.payload.path); return { path: request.payload.path };
    }
    case "filesystem.createDirectory": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      await filesystem.createDirectory(request.payload.path); return { path: request.payload.path };
    }
    case "filesystem.rename": {
      if (typeof request.payload.path !== "string" || typeof request.payload.newPath !== "string") throw new CoreError("INVALID_REQUEST", "path and newPath must be strings");
      const options = await workspaceState.load();
      await filesystem.rename(request.payload.path, request.payload.newPath);
      try { await workspaceState.save(renameWorkspacePaths(options, request.payload.path, request.payload.newPath)); }
      catch (error) { await filesystem.rename(request.payload.newPath, request.payload.path).catch(() => undefined); throw error; }
      return { path: request.payload.newPath };
    }
    case "filesystem.transferPreflight": return filesystem.transferPreflight(request.payload.kind, request.payload.items, request.payload.overwritePaths, request.payload.openFiles, request.payload.dirtyFiles);
    case "filesystem.transferApply": {
      const result = await filesystem.transferApply(request.payload.kind, request.payload.items, request.payload.overwritePaths, request.payload.openFiles, request.payload.dirtyFiles, request.payload.confirmed);
      if (request.payload.kind === "move" && result.completed.length) {
        let options = await workspaceState.load();
        for (const item of result.completed) options = renameWorkspacePaths(options, item.source, item.destination);
        await workspaceState.save(options);
      }
      return result;
    }
    case "filesystem.previewDelete": return filesystem.previewDelete(request.payload.path);
    case "filesystem.delete": return filesystem.delete(request.payload.path, request.payload.permanent === true);
    case "filesystem.restore": return { path: await filesystem.restore(request.payload.recoveryId) };
    case "filesystem.search": {
      if (typeof request.payload.query !== "string" || typeof request.payload.path !== "string" || typeof request.payload.matchCase !== "boolean") throw new CoreError("INVALID_REQUEST", "query, path, and matchCase are required");
      const result = await search.search(request.payload.query, request.payload.path, request.payload.matchCase, { include: request.payload.include, exclude: request.payload.exclude, filesOnly: request.payload.filesOnly });
      return { ...result, matches: result.matches.map((match) => ({ ...match, rootId: request.rootId })) };
    }
    case "filesystem.replacePreview": {
      if (typeof request.payload.query !== "string" || typeof request.payload.replacement !== "string" || typeof request.payload.path !== "string" || typeof request.payload.matchCase !== "boolean") throw new CoreError("INVALID_REQUEST", "query, replacement, path, and matchCase are required");
      return search.previewReplace(request.payload.query, request.payload.replacement, request.payload.path, request.payload.matchCase, { include: request.payload.include, exclude: request.payload.exclude });
    }
    case "filesystem.replaceApply": {
      if (typeof request.payload.previewId !== "string" || typeof request.payload.confirmed !== "boolean") throw new CoreError("INVALID_REQUEST", "previewId and confirmed are required");
      return search.applyReplace(request.payload.previewId, request.payload.confirmed);
    }
    case "terminal.create": {
      return terminalHost.create(workspacePath, request.payload.cols, request.payload.rows);
    }
    case "terminal.attach": {
      if (typeof request.payload.terminalId !== "string") throw new CoreError("INVALID_REQUEST", "terminalId must be a string");
      const session = terminalHost.attach(workspacePath, request.payload.terminalId);
      return session ? { state: "available" as const, session } : { state: "stale" as const, reason: "session-unavailable" as const };
    }
    case "terminal.input": {
      if (typeof request.payload.terminalId !== "string" || typeof request.payload.data !== "string") throw new CoreError("INVALID_REQUEST", "terminalId and data must be strings");
      terminalHost.input(workspacePath, request.payload.terminalId, request.payload.data);
      return {};
    }
    case "terminal.resize": {
      if (typeof request.payload.terminalId !== "string") throw new CoreError("INVALID_REQUEST", "terminalId must be a string");
      terminalHost.resize(workspacePath, request.payload.terminalId, request.payload.cols, request.payload.rows);
      return {};
    }
    case "terminal.close": {
      if (typeof request.payload.terminalId !== "string") throw new CoreError("INVALID_REQUEST", "terminalId must be a string");
      runConfigs.onTerminalClosed(workspacePath, request.payload.terminalId);
      terminalHost.close(workspacePath, request.payload.terminalId);
      return {};
    }
    case "git.status": return git.status();
    case "git.diff": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      return git.diff(request.payload.path, filesystem);
    }
    case "git.stage": await git.stage(request.payload.path, request.payload.hunk); return {};
    case "git.unstage": await git.unstage(request.payload.path, request.payload.hunk); return {};
    case "git.conflicts": return git.conflicts();
    case "git.resolveConflict": return git.resolveConflict(request.payload.path, request.payload.result);
    case "git.conflictAction": return { outcome: await git.conflictAction(request.payload.action) };
    case "git.branches": return { branches: await git.branches() };
    case "git.tags": return { tags: await git.tags() };
    case "git.createTag": return { tag: await git.createTag(request.payload.name, request.payload.target) };
    case "git.deleteTag": await git.deleteTag(request.payload.name); return {};
    case "git.checkoutBranch": return { branch: await git.checkoutBranch(request.payload.branch, request.payload.remote) };
    case "git.renameBranch": {
      if ((await tasks.list()).tasks.some((task) => task.branch === request.payload.branch)) throw new CoreError("INVALID_REQUEST", "Cannot rename a branch owned by a task worktree");
      return { branch: await git.renameBranch(request.payload.branch, request.payload.newName) };
    }
    case "git.createBranch": return { branch: await git.createBranch(request.payload.name) };
    case "git.branchDeletePreview": return git.branchDeletePreview(request.payload.branch, request.payload.remote);
    case "git.deleteBranch": {
      const localName = request.payload.remote ? request.payload.branch.split("/").slice(1).join("/") : request.payload.branch;
      if ((await tasks.list()).tasks.some((task) => task.branch === localName)) throw new CoreError("INVALID_REQUEST", "Cannot delete a branch owned by a task worktree");
      await git.deleteBranch(request.payload.branch, request.payload.remote, request.payload.force, request.payload.confirm); return {};
    }
    case "git.publishBranch": await git.publishBranch(request.payload.branch, request.payload.remote, request.payload.force, request.payload.confirm); return {};
    case "git.setBranchUpstream": await git.setBranchUpstream(request.payload.branch, request.payload.remote, request.payload.upstream, request.payload.confirm); return {};
    case "git.log": return { commits: await git.log(request.payload.branch, request.payload.limit) };
    case "git.mergePreview": return git.mergePreview(request.payload.source);
    case "git.merge": return git.merge(request.payload.source, request.payload.expectedHead, request.payload.expectedRefHead, request.payload.expectedMergeBase);
    case "git.commitFiles": return { files: await git.commitFiles(request.payload.hash) };
    case "git.commitMessage": return { message: await git.commitMessage(request.payload.hash) };
    case "git.commitDiff": return git.commitDiff(request.payload.hash, request.payload.path, request.payload.originalPath);
    case "git.cherryPick": return { branch: await git.cherryPick(request.payload.hash, request.payload.commit) };
    case "git.saveCommitResults": return git.saveCommitResults(request.payload.hash, request.payload.indexVersion, request.payload.files);
    case "git.saveCommitWorktreeResults": return git.saveCommitWorktreeResults(request.payload.hash, request.payload.files, filesystem);
    case "git.commitPatch": return git.commitPatch(request.payload.hash);
    case "git.applyCommitHunks": return git.applyCommitHunks(request.payload.hash, request.payload.indexVersion, request.payload.hunkIds);
    case "git.fileHistory": return { commits: await git.fileHistory(request.payload.path, request.payload.startLine, request.payload.endLine) };
    case "git.compareFiles": return { files: await git.compareFiles(request.payload.ref, request.payload.path) };
    case "git.compareDiff": return git.compareDiff(request.payload.ref, request.payload.path, filesystem, request.payload.originalPath);
    case "git.rollback": await git.rollback(request.payload.path); return {};
    case "git.rollbackCompared": await git.rollbackCompared(request.payload.ref, request.payload.path); return {};
    case "git.rollbackSelected": {
      if (!Array.isArray(request.payload.paths) || typeof request.payload.deleteUntracked !== "boolean") throw new CoreError("INVALID_REQUEST", "paths and deleteUntracked are required");
      return git.rollbackSelected(request.payload.paths, request.payload.deleteUntracked);
    }
    case "git.commit": return { hash: await git.commit(request.payload.paths, request.payload.message) };
    case "git.historyRewritePreview": return git.historyRewritePreview();
    case "git.amend": return { hash: await git.amend(request.payload.confirmHistoryRewrite) };
    case "git.undoLastCommit": return { undone: await git.undoLastCommit(request.payload.confirmHistoryRewrite) };
    case "git.stashes": return { stashes: await git.stashes() };
    case "git.createStash": return { stash: await git.createStash(request.payload.include, request.payload.message, request.payload.paths) };
    case "git.stashPreview": return git.stashPreview(request.payload.reference);
    case "git.applyStash": return git.applyStash(request.payload.reference);
    case "git.popStash": return git.popStash(request.payload.reference, request.payload.confirm);
    case "git.dropStash": await git.dropStash(request.payload.reference, request.payload.confirm); return {};
    case "git.push": await git.push(); return {};
    case "git.fetch": return git.fetch();
    case "git.cancelFetch": return { cancelled: git.cancelFetch() };
    case "git.pullPreview": return git.pullPreview();
    case "git.pull": return git.pull(request.payload.strategy, request.payload.expectedHead, request.payload.expectedUpstreamHead);
    case "git.rebasePreview": return git.rebasePreview();
    case "git.rebaseStart": return git.rebaseStart(request.payload.expectedHead, request.payload.expectedUpstreamHead, request.payload.base, request.payload.items);
    case "git.rebaseAbort": return git.rebaseAbort();
    case "taskGit.history": return { checkpoints: await checkpoints.history() };
    case "taskGit.diff": return checkpoints.diff(request.payload.checkpointId, request.payload.path);
    case "taskGit.review": return checkpoints.review(request.payload.checkpointId, request.payload.paths);
    case "taskGit.restore": {
      const sessions = await Promise.all(acp.list().map((provider) => acp.get(provider.id).get(workspacePath)));
      if (sessions.some((session) => session.status === "in_progress" || session.status === "user_prompt")) throw new CoreError("INVALID_REQUEST", "Stop the running task agent before restoring a checkpoint");
      return checkpoints.restore(request.payload.checkpointId);
    }
    case "java.loadMavenProject": {
      if (typeof request.payload.pomPath !== "string") throw new CoreError("INVALID_REQUEST", "pomPath must be a string");
      return java.loadMavenProject(request.payload.pomPath);
    }
    case "java.configuration.read": return java.readConfiguration();
    case "java.configuration.save": return java.saveConfiguration(request.payload.content, request.payload.expectedRevision);
    case "java.tools.check": return { checks: await java.checkTools(request.payload.content) };
    case "java.getOptions": return { options: await java.getOptions() };
    case "java.addSourceRoot": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      return java.addSourceRoot(request.payload.path);
    }
    case "java.getProjectTree": return { tree: await java.getProjectTree() };
    case "java.workspaceSymbols": {
      const result = await jdt.workspaceSymbols(request.payload.query, request.payload.limit);
      return { ...result, symbols: result.symbols.map((symbol) => ({ ...symbol, rootId: request.rootId })) };
    }
    case "java.listMainClasses": return { classes: await java.listMainClasses() };
    case "java.addRunConfiguration": {
      if (typeof request.payload.name !== "string" || typeof request.payload.mainClass !== "string") throw new CoreError("INVALID_REQUEST", "name and mainClass must be strings");
      return { options: await java.addRunConfiguration(request.payload.name, request.payload.mainClass) };
    }
    case "java.selectRunConfiguration": {
      if (typeof request.payload.id !== "string") throw new CoreError("INVALID_REQUEST", "id must be a string");
      return { options: await java.selectRunConfiguration(request.payload.id) };
    }
    case "java.build": await java.build(); return {};
    case "java.run": await java.run(); return {};
    case "java.stop": java.stop(); return {};
    case "java.debug.setBreakpoints": await java.setDebugBreakpoints(request.payload.breakpoints); return {};
    case "java.debug.start": await java.debug(request.payload.breakpoints); return {};
    case "java.debug.applyChanges": return java.applyDebugChanges();
    case "java.debug.variables": return java.debugVariables(request.payload.reference, request.payload.start);
    case "java.debug.command": java.debugCommand(request.payload.command); return {};
    case "java.check": return { diagnostics: (await java.check()).map((diagnostic) => ({ ...diagnostic, rootId: request.rootId })) };
    case "java.completeType": {
      if (typeof request.payload.prefix !== "string") throw new CoreError("INVALID_REQUEST", "prefix must be a string");
      return { suggestions: await java.completeType(request.payload.prefix) };
    }
    case "java.completion": return { items: await jdt.completion(request.payload.path, request.payload.content, request.payload.line, request.payload.column) };
    case "java.definition": return { locations: (await jdt.definition(request.payload.path, request.payload.content, request.payload.line, request.payload.column)).map((location) => ({ ...location, rootId: request.rootId })) };
    case "java.references": return { locations: (await jdt.references(request.payload.path, request.payload.content, request.payload.line, request.payload.column)).map((location) => ({ ...location, rootId: request.rootId })) };
    case "java.semanticTokens": return { tokens: await jdt.semanticTokens(request.payload.path, request.payload.content) };
  }
}

type WorkflowGateRuntime = { runId: string; blockId: string; attemptId: string; assertActive(): void };
type WorkflowReviewEvidence = { revision: string; baseRevision: string; files: string[]; diff: string };

async function collectWorkflowReviewEvidence(block: HarnessBlock, workspace: string, runner: HarnessRunner, runtime: WorkflowGateRuntime): Promise<WorkflowReviewEvidence> {
  const review = block.review;
  if (!review) throw new CoreError("INVALID_REQUEST", "Review blocks require a review configuration");
  return runner.runOperation(runtime.runId, runtime.blockId, "review", `review:${runtime.attemptId}`, { revision: review.revision, baseRevision: review.baseRevision }, async () => {
    runtime.assertActive();
    const revision = await resolveWorkflowCommit(workspace, review.revision);
    const baseRevision = review.baseRevision ? await resolveWorkflowCommit(workspace, review.baseRevision) : (await execFileAsync("git", ["-C", workspace, "rev-parse", `${revision}^`], { encoding: "utf8" })).stdout.trim();
    const [diffResult, filesResult] = await Promise.all([
      execFileAsync("git", ["-C", workspace, "diff", "--no-ext-diff", "--unified=3", baseRevision, revision], { encoding: "utf8", maxBuffer: 2_000_000 }),
      execFileAsync("git", ["-C", workspace, "diff", "--name-only", baseRevision, revision], { encoding: "utf8" })
    ]);
    runtime.assertActive();
    return { revision, baseRevision, files: filesResult.stdout.split("\n").filter(Boolean).slice(0, 500), diff: boundedWorkflowOutput(diffResult.stdout, 500_000) };
  });
}

async function runWorkflowVerification(block: HarnessBlock, workspace: string, runner: HarnessRunner, runtime: WorkflowGateRuntime): Promise<AiSession> {
  const verification = block.verification;
  if (!verification) throw new CoreError("INVALID_REQUEST", "Verification blocks require a verification configuration");
  const workingDirectory = path.resolve(workspace, verification.workingDirectory ?? ".");
  if (workingDirectory !== workspace && !workingDirectory.startsWith(`${workspace}${path.sep}`)) throw new CoreError("INVALID_REQUEST", "Verification working directory must be inside the workspace");
  const result = await runner.runOperation(runtime.runId, runtime.blockId, "verification", `verification:${runtime.attemptId}`, { command: verification.command, workingDirectory: verification.workingDirectory ?? ".", revision: verification.revision }, async () => {
    runtime.assertActive();
    const revision = await resolveWorkflowCommit(workingDirectory, verification.revision ?? "HEAD");
    if (verification.revision && revision.toLowerCase() !== verification.revision.toLowerCase()) throw new CoreError("INVALID_REQUEST", `Verification revision '${verification.revision}' resolved to '${revision}', so Core refused to test a different revision`);
    const startedAt = Date.now();
    try {
      const completed = await execFileAsync("sh", ["-lc", verification.command], { cwd: workingDirectory, encoding: "utf8", timeout: verification.timeoutMs ?? 10 * 60_000, maxBuffer: 2_000_000 });
      runtime.assertActive();
      return { revision, workingDirectory, command: verification.command, exitCode: 0, durationMs: Date.now() - startedAt, output: boundedWorkflowOutput(`${completed.stdout}${completed.stderr}`) };
    } catch (error) {
      const failed = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      const result = { revision, workingDirectory, command: verification.command, exitCode: typeof failed.code === "number" ? failed.code : null, durationMs: Date.now() - startedAt, output: boundedWorkflowOutput(`${failed.stdout ?? ""}${failed.stderr ?? ""}`), timedOut: Boolean(failed.killed) };
      throw new CoreError("INVALID_REQUEST", `Verification failed for ${revision} (exit ${result.exitCode ?? "unknown"}) after ${result.durationMs}ms: ${result.output || "no output"}`);
    }
  });
  return { id: `core-verification-${runtime.attemptId}`, model: "core", reasoning: "none", status: "done", messages: [{ id: `verification-${runtime.attemptId}`, role: "assistant", text: JSON.stringify(result), timestamp: new Date().toISOString() }] };
}

async function resolveWorkflowCommit(workspace: string, reference: string): Promise<string> {
  if (reference !== "HEAD" && !/^[0-9a-f]{7,64}$/i.test(reference)) throw new CoreError("INVALID_REQUEST", "Workflow gates require a commit SHA");
  try { return (await execFileAsync("git", ["-C", workspace, "rev-parse", "--verify", `${reference}^{commit}`], { encoding: "utf8" })).stdout.trim(); }
  catch { throw new CoreError("INVALID_REQUEST", `Workflow gate commit '${reference}' does not exist in this workspace`); }
}

function boundedWorkflowOutput(value: string, limit = 200_000): string { return value.length <= limit ? value : `${value.slice(0, limit)}\n… output truncated by Core`; }

async function startWorkflow(input: ProtocolOperations["harnesses.run"]["payload"] & { chatRunId?: string; testDefinition?: HarnessDefinition }, context: {
  acp: AcpRegistry; tasks: WorkspaceTaskStore; agents: AgentsStore; harnessRunner: HarnessRunner; workflowApps: WorkflowAppService;
  aiTimers: AiTimerService; rootWorkspace: string; bridgeWorkspace: string; workspacePath: string;
}): Promise<import("@remote-ide/protocol").HarnessRun> {
  const { acp, tasks, agents, harnessRunner, workflowApps, aiTimers, rootWorkspace, bridgeWorkspace, workspacePath } = context;
  const dispatch: Parameters<HarnessRunner["start"]>[2] = async (block, prompt, runtime) => providerOperation(async () => {
      if (block.type === "script") return executeFlowScript(block, prompt, workspacePath, runtime.assertActive);
      if (block.type === "run_app") return workflowApps.execute(block, prompt, workspacePath, runtime.assertActive);
      if (block.type === "verification") return runWorkflowVerification(block, workspacePath, harnessRunner, runtime);
      if (block.type === "review") {
        const evidence = await collectWorkflowReviewEvidence(block, workspacePath, harnessRunner, runtime);
        prompt = `${prompt}\n\nCore-recorded review evidence (review this exact revision; do not infer it from another session):\nCommit: ${evidence.revision}\nBase: ${evidence.baseRevision}\nChanged files: ${evidence.files.join(", ") || "none"}\n\nDiff:\n${evidence.diff}`;
        if (block.review?.correction) prompt += `\n\nThis review drives a Core correction loop. Reply with JSON only: {"revision":"${evidence.revision}","findings":[{"id":"stable-finding-id","message":"actionable finding","ownerBlockId":"${block.review.correction.ownerBlockId}"}]}. Use an empty findings array when the revision is approved.`;
      }
      const provider = acp.get(block.provider ?? input.provider);
      await assertWorkflowModelAvailable(provider, block.model, block.reasoning);
      if (block.watchdog) return harnessRunner.watch(runtime.runId, runtime.blockId, () => provider.usage(), () => harnessRunner.recoverChildren(runtime.runId, async (child) => {
        const task = (await tasks.list()).tasks.find((item) => item.id === child.taskId);
        if (!task || task.status === "finished" || task.archived || await aiTimers.next(child.workspace, child.provider)) return undefined;
        return acp.get(child.provider).get(child.workspace);
      }, async (child, session) => {
        const manager = acp.get(child.provider);
        const current = await manager.get(child.workspace);
        if (current.status !== "error" || current.id !== session.id || !harnessRunner.isActive(runtime.runId)) return;
        const tools = withAppTools(rootWorkspace, child.workspace, undefined, undefined, child.provider, bridgeWorkspace);
        const resumed = await manager.send(child.workspace, { prompt: "Continue your interrupted implementation from the existing session. Preserve completed work and recorded task IDs. Do not create replacement tasks.", configuration: current.configuration ?? { model: current.model, reasoning: current.reasoning }, mcpServers: tools.servers });
        if (!harnessRunner.isActive(runtime.runId)) await manager.interrupt(child.workspace);
        return resumed;
      }));
      const sessionWorkspace = await workflowSessionWorkspace(workspacePath, runtime.runId, runtime.blockId); await runtime.started(sessionWorkspace);
      const agentFile = block.agent ? (await agents.list(workspacePath)).find((item) => item.scope === block.agent!.scope && item.name === block.agent!.name) : undefined;
      if (block.agent && !agentFile) throw new CoreError("FILE_NOT_FOUND", `Agent preset '${block.agent.name}' does not exist`);
      const appTools = withAppTools(rootWorkspace, sessionWorkspace, undefined, agentFile?.agent, provider.descriptor.id, bridgeWorkspace);
      const workflowTools = appToolServer(rootWorkspace, sessionWorkspace, provider.descriptor.id, bridgeWorkspace, { ...runtime, flow: ["ai", "chatbox"].includes(block.type) });
      const mcpServers = [...appTools.servers.filter((server) => server.name !== workflowTools.name), workflowTools];
      const workflowAgent = appTools.agent ? { ...appTools.agent, mcpServers: [...new Set([...(appTools.agent.mcpServers ?? []), workflowTools.name])] } : undefined;
      const autopilot = findAutopilotOption(provider.descriptor.options);
      const configuration = { ...(block.model ? { model: block.model } : {}), ...(block.reasoning ? { reasoning: block.reasoning } : {}), ...(autopilot ? { [autopilot.option.id]: autopilot.on } : {}) };
      runtime.assertActive();
      try { await provider.startFreshSession(sessionWorkspace, { prompt, configuration, mcpServers, agent: workflowAgent, ...(block.agent ? { agentPreset: block.agent } : {}) }); runtime.assertActive(); }
      catch (error) { runtime.assertActive(); if (!block.watchdog) throw error; console.error("[core] Watchdog startup failed; scheduling recovery", error); }
      return settleWorkflowSession(provider, sessionWorkspace, aiTimers, block.watchdog ? runtime : undefined, () => harnessRunner.isActive(runtime.runId), runtime.activity);
    });
  const append: NonNullable<Parameters<HarnessRunner["start"]>[4]> = async (block, prompt, runtime) => providerOperation(async () => {
      const provider = acp.get(block.provider ?? input.provider); if (!harnessRunner.isActive(runtime.runId)) throw new Error("Workflow is no longer active"); const current = await provider.get(runtime.workspace);
      if (!harnessRunner.isActive(runtime.runId)) throw new Error("Workflow is no longer active");
      const workflowTools = appToolServer(rootWorkspace, runtime.workspace, provider.descriptor.id, bridgeWorkspace, { runId: runtime.runId, blockId: runtime.blockId, flow: ["ai", "chatbox"].includes(block.type) });
      if (current.status === "in_progress" || current.status === "user_prompt") await provider.steer(runtime.workspace, prompt);
      else await provider.send(runtime.workspace, { prompt, configuration: current.configuration ?? { model: current.model, reasoning: current.reasoning }, mcpServers: [workflowTools] });
      if (!harnessRunner.isActive(runtime.runId)) throw new Error("Workflow is no longer active");
      return settleWorkflowSession(provider, runtime.workspace, aiTimers, block.watchdog ? runtime : undefined, () => harnessRunner.isActive(runtime.runId), runtime.activity);
    });
  return input.chatRunId
    ? harnessRunner.continueChat(input.chatRunId, input.startBlockId!, input.input, dispatch, input.provider ?? "codex", append)
    : harnessRunner.start(input.harnessId, input.input, dispatch, input.provider, append, input.startBlockId, input.rerunRunId, input.testDefinition);
}

async function workflowSessionWorkspace(workspace: string, runId: string, blockId: string): Promise<string> {
  const stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces");
  const workspaceKey = crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex");
  const sessionKey = crypto.createHash("sha256").update(`${runId}:${blockId}`).digest("hex");
  const directory = path.join(stateDirectory, "workflow-sessions", workspaceKey); const alias = path.join(directory, sessionKey);
  await mkdir(directory, { recursive: true });
  try { await symlink(path.resolve(workspace), alias, "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return alias;
}

export async function settleWorkflowSession(provider: ReturnType<AcpRegistry["get"]>, workspace: string, timers: Pick<AiTimerService, "next" | "scheduleAt">, watchdog?: { runId: string; blockId: string }, active: () => boolean = () => true, activity?: (session: AiSession, waitingUntil?: string) => Promise<void>) {
  let session = await provider.get(workspace);
  for (;;) {
    while ((session.status === "in_progress" || session.pendingPermission) && active()) { await activity?.(session); await delay(250); session = await provider.get(workspace); }
    if (!active()) return session;
    let timer = await timers.next(workspace, provider.descriptor.id);
    if (!timer && watchdog) {
      const usage = await provider.usage(workspace).catch(() => undefined);
      if (!active()) return session;
      const resets = [usage?.resetsAt, usage?.accountQuota?.primary?.resetsAt, usage?.accountQuota?.secondary?.resetsAt].filter((value): value is string => Boolean(value) && Date.parse(value!) > Date.now()).sort();
      timer = await timers.scheduleAt(workspace, provider.descriptor.id, "RESET_ELAPSED: Call workflow_resume_failed, then recheck ai_usage and arm the next reset timer. Preserve the existing request and sessions.", resets[0] ?? new Date(Date.now() + 300_000).toISOString(), watchdog);
    }
    await activity?.(session, timer?.dueAt);
    if (session.status === "user_prompt" && !timer && activity) { await delay(250); session = await provider.get(workspace); continue; }
    if (!timer) return session;
    while (active() && await timers.next(workspace, provider.descriptor.id)) await delay(Math.min(250, Math.max(10, new Date(timer.dueAt).getTime() - Date.now())));
    await delay(250); session = await provider.get(workspace);
  }
}

async function providerOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { if (error instanceof AiProviderError) throw error; throw new AiProviderError(normalizeAiFailure(error)); }
}

export function renameWorkspacePaths(options: WorkspaceOptions, oldPath: string, newPath: string): WorkspaceOptions {
  const oldPrefix = `${oldPath}/`; const newPrefix = `${newPath}/`;
  const moved = (value: string) => value === oldPath ? newPath : value.startsWith(oldPrefix) ? newPrefix + value.slice(oldPrefix.length) : value;
  const javaProject = options.javaProject ? { ...options.javaProject, pomPath: moved(options.javaProject.pomPath), sourceRoots: options.javaProject.sourceRoots.map(moved), outputPath: moved(options.javaProject.outputPath), testOutputPath: moved(options.javaProject.testOutputPath) } : undefined;
  const fileColors = options.fileColors ? Object.fromEntries(Object.entries(options.fileColors).map(([filePath, color]) => [moved(filePath), color])) : undefined;
  return { ...options, openFiles: options.openFiles.map(moved), ...(options.pinnedFiles ? { pinnedFiles: options.pinnedFiles.map(moved) } : {}), ...(options.activeFile ? { activeFile: moved(options.activeFile) } : {}), ...(javaProject ? { javaProject } : {}), ...(fileColors ? { fileColors } : {}) };
}

export async function permissionTargetWorkspace(tasks: Pick<WorkspaceTaskStore, "list" | "taskPath">, rootWorkspace: string, taskId?: string): Promise<string> {
  if (!taskId) return rootWorkspace;
  if (!(await tasks.list()).tasks.some((task) => task.id === taskId)) throw new CoreError("INVALID_REQUEST", "Task does not exist");
  return tasks.taskPath(taskId);
}

export async function assertWorkflowModelAvailable(provider: { models(): Promise<Array<{ id: string; available?: boolean; reasoningLevels: string[] }>> }, model?: string, reasoning?: string): Promise<void> {
  if (!model) return;
  const selected = (await provider.models()).find((item) => item.id === model);
  if (!selected || selected.available === false) throw new CoreError("INVALID_REQUEST", `Workflow model '${model}' is unavailable. Select an available model before running this workflow.`);
  if (reasoning && !selected.reasoningLevels.includes(reasoning)) throw new CoreError("INVALID_REQUEST", `Workflow reasoning effort '${reasoning}' is unavailable for model '${model}'. Select an available reasoning effort before running this workflow.`);
}

export async function assertSessionChangeAllowed(timers: Pick<AiTimerService, "next">, workspace: string, provider: AiProvider): Promise<void> {
  if (await timers.next(workspace, provider)) throw new CoreError("INVALID_REQUEST", "Cancel or run the active task timer before changing its AI session");
}
