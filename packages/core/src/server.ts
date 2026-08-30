import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import chokidar from "chokidar";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestTypes, type FileChangeKind, type Request, type RequestType, type Response, type ServerEvent } from "@remote-ide/protocol";
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
import { AgentsStore } from "./agents.js";
import { RunConfigService } from "./run-configs.js";
import { executeHttpRequest } from "./http.js";
import { summarizeAiSessions } from "./ai/summary.js";
import { createAcpRegistry, type AcpRegistry } from "./ai/index.js";
import { AppEventBridge } from "./app-events.js";
import { AppToolService, withAppTools } from "./app-tools.js";
import { TaskCheckpointStore } from "./task-checkpoints.js";
import type { AiProvider } from "@remote-ide/protocol";

const execFileAsync = promisify(execFile);

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

export async function createServer(host: string, port: number, workspacePath: string): Promise<WebSocketServer> {
  const rootWorkspace = workspacePath;
  const tasks = new WorkspaceTaskStore(rootWorkspace);
  const usefulFiles = new UsefulFilesStore(rootWorkspace);
  const agents = new AgentsStore(rootWorkspace);
  const savedTasks = await tasks.list();
  if (savedTasks.selectedTaskId) workspacePath = tasks.taskPath(savedTasks.selectedTaskId);
  const validation = new WorkspaceFileSystem();
  await validation.open(workspacePath);
  const workspace = validation.getWorkspace();
  const workspaceState = new WorkspaceStateStore(workspace, process.env.REMOTE_IDE_STATE_DIR);
  const watcher = chokidar.watch(workspace, {
    ignoreInitial: true,
    ignored: (watchPath) => path.relative(workspace, watchPath).split(path.sep).some((part) => part === ".git" || part === "node_modules"),
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  });
  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", resolve);
    watcher.once("error", reject);
  });
  const server = new WebSocketServer({ host, port });
  const activeSessions = new Set<WebSocket>();
  const terminalSubscriptions = new Map<WebSocket, { workspace: string; terminalIds: Set<string> }>();
  let runConfigs: RunConfigService;
  const terminalHost = new TerminalSessionHost((event) => {
    runConfigs?.onTerminalEvent(event);
    const message: ServerEvent = event.type === "output"
      ? { type: "terminal.output", payload: { terminalId: event.terminalId, data: event.data } }
      : { type: "terminal.exit", payload: { terminalId: event.terminalId, exitCode: event.exitCode } };
    const encoded = JSON.stringify(message);
    for (const [socket, subscription] of terminalSubscriptions) {
      if (subscription.workspace === event.workspace && subscription.terminalIds.has(event.terminalId)) sendWebSocketData(socket, encoded);
    }
  });
  runConfigs = new RunConfigService(terminalHost, (changedWorkspace) => {
    void runConfigs.list(changedWorkspace).then((configs) => {
      const encoded = JSON.stringify({ type: "runConfig.changed", payload: { workspace: changedWorkspace, configs } } satisfies ServerEvent);
      for (const [socket, subscription] of terminalSubscriptions) if (subscription.workspace === path.resolve(changedWorkspace)) sendWebSocketData(socket, encoded);
    });
  });
  const globalRunConfigWatcher = chokidar.watch(runConfigs.directory(rootWorkspace, "global"), { ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
  globalRunConfigWatcher.on("all", () => {
    for (const changedWorkspace of new Set([...terminalSubscriptions.values()].map((subscription) => subscription.workspace))) {
      void runConfigs.list(changedWorkspace).then((configs) => { const encoded = JSON.stringify({ type: "runConfig.changed", payload: { workspace: changedWorkspace, configs } } satisfies ServerEvent); for (const [socket, subscription] of terminalSubscriptions) if (subscription.workspace === changedWorkspace) sendWebSocketData(socket, encoded); });
    }
  });
  const appEvents = new AppEventBridge(rootWorkspace);
  await appEvents.ready();
  const appEventWatcher = chokidar.watch(appEvents.directory, { ignoreInitial: true, depth: 0 });
  await new Promise<void>((resolve, reject) => { appEventWatcher.once("ready", resolve); appEventWatcher.once("error", reject); });
  appEventWatcher.on("add", (file) => {
    void appEvents.consume(file).then((event) => {
      if (!event) return;
      const message: ServerEvent = event.type === "tasks.changed" ? { type: "tasks.changed", payload: {} }
        : event.type === "ai.changed" ? { type: "ai.changed", payload: { workspace: event.workspace } }
        : { type: "commit-message.changed", payload: { workspace: event.workspace, message: event.message } };
      const encoded = JSON.stringify(message);
      for (const socket of activeSessions) sendWebSocketData(socket, encoded);
    }).catch((error) => console.error(`[core] app event error: ${error instanceof Error ? error.message : String(error)}`));
  });
  const aiChanged = (changedWorkspace: string) => {
    const encoded = JSON.stringify({ type: "ai.changed", payload: { workspace: changedWorkspace } } satisfies ServerEvent);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  };
  const checkpointStores = new Map<string, TaskCheckpointStore>();
  const checkpointStore = (target: string) => { const key = path.resolve(target); let store = checkpointStores.get(key); if (!store) { store = new TaskCheckpointStore(key); checkpointStores.set(key, store); } return store; };
  await Promise.all([rootWorkspace, ...savedTasks.tasks.map((task) => tasks.taskPath(task.id))].map((target) => checkpointStore(target).recover()));
  const taskGitChanged = (changedWorkspace: string) => { const encoded = JSON.stringify({ type: "taskGit.changed", payload: { workspace: changedWorkspace } } satisfies ServerEvent); for (const socket of activeSessions) sendWebSocketData(socket, encoded); };
  const acp = createAcpRegistry(aiChanged, {
    begin: async (target, provider, prompt, sessionId) => { const id = await checkpointStore(target).begin(provider as AiProvider, prompt, sessionId); taskGitChanged(target); return id; },
    complete: async (target, ids, status) => { await Promise.all(ids.map((id) => checkpointStore(target).complete(id, status))); taskGitChanged(target); }
  });
  const onTasksChanged = async () => {
    const encoded = JSON.stringify({ type: "tasks.changed", payload: {} } satisfies ServerEvent);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  };
  const onCommitMessageChanged = async (changedWorkspace: string, message: string) => {
    const encoded = JSON.stringify({ type: "commit-message.changed", payload: { workspace: changedWorkspace, message } } satisfies ServerEvent);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  };
  const appCommandWatcher = chokidar.watch(appEvents.commandsDirectory, { ignoreInitial: true, depth: 0 });
  await new Promise<void>((resolve, reject) => { appCommandWatcher.once("ready", resolve); appCommandWatcher.once("error", reject); });
  appCommandWatcher.on("add", (file) => {
    void appEvents.consumeCommand(file, (command) => new AppToolService(
      tasks,
      acp,
      command.currentWorkspace ?? rootWorkspace,
      onTasksChanged,
      onCommitMessageChanged,
      command.currentProvider,
      agents,
      rootWorkspace
    ).call(command.name, command.args));
  });
  const gitIndexWatcher = chokidar.watch(await gitIndexPath(workspace), { ignoreInitial: true });
  gitIndexWatcher.on("all", () => {
    const encoded = JSON.stringify({ type: "git.changed", payload: {} } satisfies ServerEvent);
    for (const socket of activeSessions) sendWebSocketData(socket, encoded);
  });
  const broadcastChange = (kind: FileChangeKind, absolutePath: string) => {
    const relativePath = absolutePath.slice(workspace.length + 1).split("\\").join("/");
    if (!relativePath) return;
    const event: ServerEvent = { type: "filesystem.changed", payload: { path: relativePath, kind } };
    const encoded = JSON.stringify(event);
    for (const socket of activeSessions) {
      sendWebSocketData(socket, encoded);
    }
    console.log(`[core] filesystem ${kind}: ${relativePath}`);
  };
  watcher
    .on("add", (file) => broadcastChange("add", file))
    .on("change", (file) => broadcastChange("change", file))
    .on("unlink", (file) => broadcastChange("unlink", file))
    .on("addDir", (directory) => broadcastChange("addDir", directory))
    .on("unlinkDir", (directory) => broadcastChange("unlinkDir", directory))
    .on("error", (error) => console.error(`[core] watcher error: ${String(error)}`));
  server.on("close", () => { terminalHost.closeAll(); void watcher.close(); void gitIndexWatcher.close(); void globalRunConfigWatcher.close(); void appEventWatcher.close(); void appCommandWatcher.close(); });
  server.on("listening", () => console.log(`[core] listening on ws://${host}:${port}`));
  server.on("connection", (socket, request) => {
    const makeServices = async (nextWorkspace: string): Promise<SessionServices> => {
      const filesystem = new WorkspaceFileSystem();
      await filesystem.open(nextWorkspace);
      const workspaceState = new WorkspaceStateStore(nextWorkspace, process.env.REMOTE_IDE_STATE_DIR);
      const search = new WorkspaceSearch(filesystem);
      const git = new GitService(nextWorkspace);
      const java = new JavaProjectService(filesystem, workspaceState, (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const message: ServerEvent = event.type === "output" ? { type: "java.output", payload: { data: event.data } }
        : event.type === "debug" ? { type: "java.debug.state", payload: event.state }
        : { type: "java.exit", payload: { exitCode: event.exitCode, signal: event.signal } };
      sendWebSocketData(socket, JSON.stringify(message));
      });
      const jdt = new JdtLanguageService(filesystem);
      return { workspacePath: nextWorkspace, filesystem, search, git, java, jdt, workspaceState, checkpoints: checkpointStore(nextWorkspace) };
    };
    let servicesPromise: Promise<SessionServices>;
    /** Resolves once no task switch is in flight for this connection. */
    let switching: Promise<void> = Promise.resolve();
    let switchedWatcher: ReturnType<typeof chokidar.watch> | undefined;
    let switchedGitIndexWatcher: ReturnType<typeof chokidar.watch> | undefined;
    const watchSwitchedWorkspace = async (nextWorkspace: string) => {
      await switchedWatcher?.close();
      await switchedGitIndexWatcher?.close();
      if (nextWorkspace === workspace) { switchedWatcher = undefined; switchedGitIndexWatcher = undefined; return; }
      switchedWatcher = chokidar.watch(nextWorkspace, {
        ignoreInitial: true,
        ignored: (watchPath) => path.relative(nextWorkspace, watchPath).split(path.sep).some((part) => part === ".git" || part === "node_modules"),
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
      });
      // Subscribe immediately: on a small/cached worktree chokidar can become ready while
      // gitIndexPath() below is still running. Registering after that await misses the one-shot
      // event and leaves tasks.switch (and the renderer's switching state) pending forever.
      const watcherReady = new Promise<void>((resolve, reject) => {
        switchedWatcher!.once("ready", resolve);
        switchedWatcher!.once("error", reject);
      });
      const sendChange = (kind: FileChangeKind, absolutePath: string) => {
        const relativePath = path.relative(nextWorkspace, absolutePath).split(path.sep).join("/");
        if (!relativePath) return;
        sendWebSocketData(socket, JSON.stringify({ type: "filesystem.changed", payload: { path: relativePath, kind } } satisfies ServerEvent));
      };
      switchedWatcher.on("add", (file) => sendChange("add", file)).on("change", (file) => sendChange("change", file)).on("unlink", (file) => sendChange("unlink", file)).on("addDir", (directory) => sendChange("addDir", directory)).on("unlinkDir", (directory) => sendChange("unlinkDir", directory));
      switchedGitIndexWatcher = chokidar.watch(await gitIndexPath(nextWorkspace), { ignoreInitial: true });
      switchedGitIndexWatcher.on("all", () => {
        sendWebSocketData(socket, JSON.stringify({ type: "git.changed", payload: {} } satisfies ServerEvent));
      });
      await watcherReady;
    };
    // Task selection is durable server state and may have changed since Core started. A fresh
    // post-sleep socket must be routed to that selected worktree before workspace.open runs.
    // Otherwise the renderer restores the selected task label while requests still hit the old
    // startup workspace until another explicit task switch happens.
    servicesPromise = (async () => {
      const registry = await tasks.list();
      const selectedWorkspace = registry.selectedTaskId ? tasks.taskPath(registry.selectedTaskId) : rootWorkspace;
      terminalSubscriptions.set(socket, { workspace: selectedWorkspace, terminalIds: new Set() });
      await watchSwitchedWorkspace(selectedWorkspace);
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
        // Requests are handled concurrently, so anything that arrives while a task switch is
        // rebuilding the services has to wait for it. Otherwise it would run against the
        // previous worktree and answer the client with another task's state.
        const switchesWorkspace = parsed.type === "tasks.switch" || parsed.type === "tasks.delete";
        if (!switchesWorkspace) await switching;
        let release: (() => void) | undefined;
        if (switchesWorkspace) { const previous = switching; switching = new Promise<void>((resolve) => { release = resolve; }); await previous; }
        let services: SessionServices;
        try {
          services = await servicesPromise;
          if (parsed.type === "tasks.switch" || (parsed.type === "tasks.delete" && (await tasks.list()).selectedTaskId === parsed.payload.taskId)) {
            const selected = await tasks.select(parsed.type === "tasks.switch" ? parsed.payload.taskId : undefined);
            services.java.close(); services.jdt.close();
            servicesPromise = makeServices(selected.workspace);
            services = await servicesPromise;
            terminalSubscriptions.set(socket, { workspace: selected.workspace, terminalIds: new Set() });
            await watchSwitchedWorkspace(selected.workspace);
          }
        } finally { release?.(); }
        const result = await handleRequest(services, tasks, acp, usefulFiles, agents, terminalHost, runConfigs, rootWorkspace, parsed);
        const terminalSubscription = terminalSubscriptions.get(socket);
        if (terminalSubscription && parsed.type === "terminal.create") terminalSubscription.terminalIds.add((result as { terminalId: string }).terminalId);
        if (terminalSubscription && parsed.type === "terminal.attach" && (result as { session?: { terminalId: string } }).session) terminalSubscription.terminalIds.add(parsed.payload.terminalId);
        if (terminalSubscription && parsed.type === "terminal.close") terminalSubscription.terminalIds.delete(parsed.payload.terminalId);
        if (terminalSubscription && (parsed.type === "runConfig.run" || parsed.type === "runConfig.restart" || parsed.type === "runConfig.openTerminal")) {
          const terminalId = (result as { config: { terminalId?: string } }).config.terminalId; if (terminalId) terminalSubscription.terminalIds.add(terminalId);
        }
        if (parsed.type === "workspace.open") activeSessions.add(socket);
        sendWebSocketData(socket, JSON.stringify({ id, ok: true, result }));
      } catch (error) {
        const coreError = error instanceof CoreError ? error : new CoreError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid request");
        console.error(`[core] error ${id}: ${coreError.code} ${coreError.message}`);
        sendWebSocketData(socket, JSON.stringify({ id, ok: false, error: { code: coreError.code, message: coreError.message } } satisfies Response));
      }
    });
    socket.on("close", () => {
      activeSessions.delete(socket);
      terminalSubscriptions.delete(socket);
      void servicesPromise.then((services) => { services.java.close(); services.jdt.close(); });
      void switchedWatcher?.close();
      void switchedGitIndexWatcher?.close();
      console.log(`[core] disconnected: ${client}`);
    });
    socket.on("error", (error) => console.error(`[core] socket error: ${error.message}`));
  });
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
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string" || !("payload" in candidate) || !requestTypes.includes(candidate.type as RequestType)) {
    throw new CoreError("INVALID_REQUEST", "Request must contain a valid id, type, and payload");
  }
  return value as Request;
}

async function handleRequest(services: SessionServices, tasks: WorkspaceTaskStore, acp: AcpRegistry, usefulFiles: UsefulFilesStore, agents: AgentsStore, terminalHost: TerminalSessionHost, runConfigs: RunConfigService, rootWorkspace: string, request: Request): Promise<unknown> {
  const { filesystem, search, git, java, jdt, workspaceState, workspacePath, checkpoints } = services;
  if (request.type !== "workspace.open") filesystem.getWorkspace();
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
        const appTools = withAppTools(rootWorkspace, tasks.taskPath(task.id), request.payload.mcpServers, request.payload.agent, request.payload.provider);
        await acp.get(request.payload.provider).send(tasks.taskPath(task.id), {
          prompt: request.payload.prompt,
          content: request.payload.content,
          configuration: request.payload.configuration,
          mcpServers: appTools.servers,
          agent: appTools.agent
        });
        return { task };
      } catch (error) {
        await tasks.delete(task.id).catch(() => undefined);
        throw error;
      }
    }
    case "tasks.merge": return tasks.merge(request.payload.taskId, request.payload.strategy);
    case "tasks.delete": {
      const result = await tasks.delete(request.payload.taskId);
      terminalHost.closeWorkspace(tasks.taskPath(request.payload.taskId));
      return result;
    }
    case "tasks.switch": {
      const registry = await tasks.list();
      return { workspace: workspacePath, projectName: path.basename(path.resolve(rootWorkspace)), tree: await filesystem.listTree(request.payload.includeIgnored === true), options: await workspaceState.load(), ...registry };
    }
    case "ai.providers": return { providers: acp.list() };
    case "ai.get": return { session: await acp.get(request.payload.provider).get(workspacePath) };
    case "ai.models": return { models: await acp.get(request.payload.provider).models() };
    case "ai.configure": return { session: await acp.get(request.payload.provider).configure(workspacePath, { ...request.payload.configuration, ...(request.payload.model ? { model: request.payload.model } : {}), ...(request.payload.reasoning ? { reasoning: request.payload.reasoning } : {}) }) };
    case "ai.send": {
      const appTools = withAppTools(rootWorkspace, workspacePath, request.payload.mcpServers, request.payload.agent, request.payload.provider);
      return { session: await acp.get(request.payload.provider).send(workspacePath, { prompt: request.payload.prompt, content: request.payload.content, configuration: { ...request.payload.configuration, ...(request.payload.model ? { model: request.payload.model } : {}), ...(request.payload.reasoning ? { reasoning: request.payload.reasoning } : {}) }, mcpServers: appTools.servers, agent: appTools.agent }) };
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
    case "ai.interrupt": return { session: await acp.get(request.payload.provider).interrupt(workspacePath) };
    case "ai.steer": return { session: await acp.get(request.payload.provider).steer(workspacePath, request.payload.prompt) };
    case "ai.clear": return { session: await acp.get(request.payload.provider).clear(workspacePath) };
    case "ai.sessions": return { sessions: await acp.get(request.payload.provider).sessions(workspacePath) };
    case "ai.restore": return { session: await acp.get(request.payload.provider).restore(workspacePath, request.payload.sessionId) };
    case "ai.remove": return { session: await acp.get(request.payload.provider).remove(workspacePath, request.payload.sessionId) };
    case "ai.usage": return { usage: await acp.get(request.payload.provider).usage(workspacePath) };
    case "ai.statuses": {
      const registry = await tasks.list();
      const summarize = async (target: string) => { const summary = summarizeAiSessions(await Promise.all(acp.list().map((item) => acp.get(item.id).get(target)))); return { ...summary, ...await new GitService(target).diffStats() }; };
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
    case "http.execute": return executeHttpRequest(request.payload.method, request.payload.url, request.payload.headers, request.payload.body);
    case "filesystem.listTree": return { tree: await filesystem.listTree(request.payload.includeIgnored === true) };
    case "filesystem.readFile": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      return { path: request.payload.path, content: await filesystem.read(request.payload.path) };
    }
    case "filesystem.writeFile": {
      if (typeof request.payload.path !== "string" || typeof request.payload.content !== "string") throw new CoreError("INVALID_REQUEST", "path and content must be strings");
      return { path: request.payload.path, bytesWritten: await filesystem.write(request.payload.path, request.payload.content) };
    }
    case "filesystem.search": {
      if (typeof request.payload.query !== "string" || typeof request.payload.path !== "string" || typeof request.payload.matchCase !== "boolean") throw new CoreError("INVALID_REQUEST", "query, path, and matchCase are required");
      return search.search(request.payload.query, request.payload.path, request.payload.matchCase);
    }
    case "terminal.create": {
      return terminalHost.create(workspacePath, request.payload.cols, request.payload.rows);
    }
    case "terminal.attach": {
      if (typeof request.payload.terminalId !== "string") throw new CoreError("INVALID_REQUEST", "terminalId must be a string");
      return { session: terminalHost.attach(workspacePath, request.payload.terminalId) };
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
      terminalHost.close(workspacePath, request.payload.terminalId);
      return {};
    }
    case "git.status": return git.status();
    case "git.diff": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      return git.diff(request.payload.path, filesystem);
    }
    case "git.branches": return { branches: await git.branches() };
    case "git.checkoutBranch": return { branch: await git.checkoutBranch(request.payload.branch, request.payload.remote) };
    case "git.renameBranch": return { branch: await git.renameBranch(request.payload.branch, request.payload.newName) };
    case "git.log": return { commits: await git.log(request.payload.branch, request.payload.limit) };
    case "git.commitFiles": return { files: await git.commitFiles(request.payload.hash) };
    case "git.commitDiff": return git.commitDiff(request.payload.hash, request.payload.path, request.payload.originalPath);
    case "git.cherryPick": return { branch: await git.cherryPick(request.payload.hash, request.payload.commit) };
    case "git.fileHistory": return { commits: await git.fileHistory(request.payload.path, request.payload.startLine, request.payload.endLine) };
    case "git.compareFiles": return { files: await git.compareFiles(request.payload.ref, request.payload.path) };
    case "git.compareDiff": return git.compareDiff(request.payload.ref, request.payload.path, filesystem, request.payload.originalPath);
    case "git.rollback": await git.rollback(request.payload.path); return {};
    case "git.rollbackSelected": {
      if (!Array.isArray(request.payload.paths) || typeof request.payload.deleteUntracked !== "boolean") throw new CoreError("INVALID_REQUEST", "paths and deleteUntracked are required");
      return git.rollbackSelected(request.payload.paths, request.payload.deleteUntracked);
    }
    case "git.commit": return { hash: await git.commit(request.payload.paths, request.payload.message) };
    case "git.push": await git.push(); return {};
    case "taskGit.history": return { checkpoints: await checkpoints.history() };
    case "taskGit.diff": return checkpoints.diff(request.payload.checkpointId, request.payload.path);
    case "taskGit.restore": {
      const sessions = await Promise.all(acp.list().map((provider) => acp.get(provider.id).get(workspacePath)));
      if (sessions.some((session) => session.status === "in_progress" || session.status === "user_prompt")) throw new CoreError("INVALID_REQUEST", "Stop the running task agent before restoring a checkpoint");
      return { restored: await checkpoints.restore(request.payload.checkpointId) };
    }
    case "java.loadMavenProject": {
      if (typeof request.payload.pomPath !== "string") throw new CoreError("INVALID_REQUEST", "pomPath must be a string");
      return java.loadMavenProject(request.payload.pomPath);
    }
    case "java.getOptions": return { options: await java.getOptions() };
    case "java.addSourceRoot": {
      if (typeof request.payload.path !== "string") throw new CoreError("INVALID_REQUEST", "path must be a string");
      return java.addSourceRoot(request.payload.path);
    }
    case "java.getProjectTree": return { tree: await java.getProjectTree() };
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
    case "java.debug.start": await java.debug(request.payload.breakpoints); return {};
    case "java.debug.command": java.debugCommand(request.payload.command); return {};
    case "java.check": return { diagnostics: await java.check() };
    case "java.completeType": {
      if (typeof request.payload.prefix !== "string") throw new CoreError("INVALID_REQUEST", "prefix must be a string");
      return { suggestions: await java.completeType(request.payload.prefix) };
    }
    case "java.completion": return { items: await jdt.completion(request.payload.path, request.payload.content, request.payload.line, request.payload.column) };
    case "java.definition": return { locations: await jdt.definition(request.payload.path, request.payload.content, request.payload.line, request.payload.column) };
    case "java.references": return { locations: await jdt.references(request.payload.path, request.payload.content, request.payload.line, request.payload.column) };
    case "java.semanticTokens": return { tokens: await jdt.semanticTokens(request.payload.path, request.payload.content) };
  }
}

export async function permissionTargetWorkspace(tasks: Pick<WorkspaceTaskStore, "list" | "taskPath">, rootWorkspace: string, taskId?: string): Promise<string> {
  if (!taskId) return rootWorkspace;
  if (!(await tasks.list()).tasks.some((task) => task.id === taskId)) throw new CoreError("INVALID_REQUEST", "Task does not exist");
  return tasks.taskPath(taskId);
}
