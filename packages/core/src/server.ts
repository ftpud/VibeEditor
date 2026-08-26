import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import chokidar from "chokidar";
import path from "node:path";
import { requestTypes, type FileChangeKind, type Request, type RequestType, type Response, type ServerEvent } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";
import { PtyProcessManager } from "./process-manager.js";
import { GitService } from "./git.js";
import { WorkspaceStateStore } from "./workspace-state.js";
import { WorkspaceSearch } from "./search.js";
import { JavaProjectService } from "./java.js";
import { JdtLanguageService } from "./jdtls.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { CodexSessionManager } from "./codex.js";
import { CopilotSessionManager } from "./copilot.js";
import { UsefulFilesStore } from "./useful-files.js";
import { executeHttpRequest } from "./http.js";
import { summarizeAiSessions } from "./ai-summary.js";

type SessionServices = {
  workspacePath: string;
  filesystem: WorkspaceFileSystem;
  search: WorkspaceSearch;
  processManager: PtyProcessManager;
  git: GitService;
  java: JavaProjectService;
  jdt: JdtLanguageService;
  workspaceState: WorkspaceStateStore;
};

export async function createServer(host: string, port: number, workspacePath: string): Promise<WebSocketServer> {
  const rootWorkspace = workspacePath;
  const tasks = new WorkspaceTaskStore(rootWorkspace);
  const usefulFiles = new UsefulFilesStore(rootWorkspace);
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
  const aiChanged = (changedWorkspace: string) => {
    const encoded = JSON.stringify({ type: "ai.changed", payload: { workspace: changedWorkspace } } satisfies ServerEvent);
    for (const socket of activeSessions) if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
  };
  const codex = new CodexSessionManager(aiChanged);
  const copilot = new CopilotSessionManager(aiChanged);
  const gitIndexWatcher = chokidar.watch(path.join(workspace, ".git", "index"), { ignoreInitial: true });
  gitIndexWatcher.on("change", () => {
    const encoded = JSON.stringify({ type: "git.changed", payload: {} } satisfies ServerEvent);
    for (const socket of activeSessions) if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
  });
  const broadcastChange = (kind: FileChangeKind, absolutePath: string) => {
    const relativePath = absolutePath.slice(workspace.length + 1).split("\\").join("/");
    if (!relativePath) return;
    const event: ServerEvent = { type: "filesystem.changed", payload: { path: relativePath, kind } };
    const encoded = JSON.stringify(event);
    for (const socket of activeSessions) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
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
  server.on("close", () => { void watcher.close(); void gitIndexWatcher.close(); });
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
      socket.send(JSON.stringify(message));
      });
      const jdt = new JdtLanguageService(filesystem);
      const processManager = new PtyProcessManager(nextWorkspace, (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const message: ServerEvent = event.type === "output"
        ? { type: "terminal.output", payload: { terminalId: event.terminalId, data: event.data } }
        : { type: "terminal.exit", payload: { terminalId: event.terminalId, exitCode: event.exitCode } };
      socket.send(JSON.stringify(message));
      });
      return { workspacePath: nextWorkspace, filesystem, search, git, java, jdt, processManager, workspaceState };
    };
    let servicesPromise = makeServices(workspace);
    let switchedWatcher: ReturnType<typeof chokidar.watch> | undefined;
    const watchSwitchedWorkspace = async (nextWorkspace: string) => {
      await switchedWatcher?.close();
      if (nextWorkspace === workspace) { switchedWatcher = undefined; return; }
      switchedWatcher = chokidar.watch(nextWorkspace, {
        ignoreInitial: true,
        ignored: (watchPath) => path.relative(nextWorkspace, watchPath).split(path.sep).some((part) => part === ".git" || part === "node_modules"),
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
      });
      const sendChange = (kind: FileChangeKind, absolutePath: string) => {
        const relativePath = path.relative(nextWorkspace, absolutePath).split(path.sep).join("/");
        if (!relativePath || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "filesystem.changed", payload: { path: relativePath, kind } } satisfies ServerEvent));
      };
      switchedWatcher.on("add", (file) => sendChange("add", file)).on("change", (file) => sendChange("change", file)).on("unlink", (file) => sendChange("unlink", file)).on("addDir", (directory) => sendChange("addDir", directory)).on("unlinkDir", (directory) => sendChange("unlinkDir", directory));
      await new Promise<void>((resolve, reject) => { switchedWatcher!.once("ready", resolve); switchedWatcher!.once("error", reject); });
    };
    const client = request.socket.remoteAddress ?? "unknown";
    console.log(`[core] connected: ${client}`);
    socket.on("message", async (data) => {
      let id = "unknown";
      try {
        const parsed = parseRequest(data);
        id = parsed.id;
        console.log(`[core] request ${parsed.id}: ${parsed.type}`);
        let services = await servicesPromise;
        if (parsed.type === "tasks.switch" || (parsed.type === "tasks.delete" && (await tasks.list()).selectedTaskId === parsed.payload.taskId)) {
          const selected = await tasks.select(parsed.type === "tasks.switch" ? parsed.payload.taskId : undefined);
          services.processManager.closeAll(); services.java.close(); services.jdt.close();
          servicesPromise = makeServices(selected.workspace);
          services = await servicesPromise;
          await watchSwitchedWorkspace(selected.workspace);
        }
        const result = await handleRequest(services, tasks, codex, copilot, usefulFiles, rootWorkspace, parsed);
        if (parsed.type === "workspace.open") activeSessions.add(socket);
        socket.send(JSON.stringify({ id, ok: true, result }));
      } catch (error) {
        const coreError = error instanceof CoreError ? error : new CoreError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid request");
        console.error(`[core] error ${id}: ${coreError.code} ${coreError.message}`);
        socket.send(JSON.stringify({ id, ok: false, error: { code: coreError.code, message: coreError.message } } satisfies Response));
      }
    });
    socket.on("close", () => {
      activeSessions.delete(socket);
      void servicesPromise.then((services) => { services.processManager.closeAll(); services.java.close(); services.jdt.close(); });
      void switchedWatcher?.close();
      console.log(`[core] disconnected: ${client}`);
    });
    socket.on("error", (error) => console.error(`[core] socket error: ${error.message}`));
  });
  return server;
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

async function handleRequest(services: SessionServices, tasks: WorkspaceTaskStore, codex: CodexSessionManager, copilot: CopilotSessionManager, usefulFiles: UsefulFilesStore, rootWorkspace: string, request: Request): Promise<unknown> {
  const { filesystem, search, processManager, git, java, jdt, workspaceState, workspacePath } = services;
  if (request.type !== "workspace.open") filesystem.getWorkspace();
  switch (request.type) {
    case "workspace.open": {
      const tree = await filesystem.open(workspacePath);
      return { workspace: filesystem.getWorkspace(), projectName: path.basename(path.resolve(rootWorkspace)), tree, options: await workspaceState.load() };
    }
    case "workspace.saveOptions": {
      await workspaceState.save(request.payload.options);
      return {};
    }
    case "tasks.list": return tasks.list();
    case "tasks.create": return { task: await tasks.create(request.payload.branch) };
    case "tasks.merge": return tasks.merge(request.payload.taskId);
    case "tasks.delete": return tasks.delete(request.payload.taskId);
    case "tasks.switch": {
      const registry = await tasks.list();
      return { workspace: workspacePath, projectName: path.basename(path.resolve(rootWorkspace)), tree: await filesystem.listTree(), options: await workspaceState.load(), ...registry };
    }
    case "ai.get": return { session: await (request.payload.provider === "copilot" ? copilot : codex).get(workspacePath) };
    case "ai.models": return { models: await (request.payload.provider === "copilot" ? copilot : codex).models() };
    case "ai.configure": return { session: await (request.payload.provider === "copilot" ? copilot : codex).configure(workspacePath, request.payload.model, request.payload.reasoning) };
    case "ai.send": return { session: await (request.payload.provider === "copilot" ? copilot : codex).send(workspacePath, request.payload.prompt, request.payload.model, request.payload.reasoning) };
    case "ai.clear": return { session: await (request.payload.provider === "copilot" ? copilot : codex).clear(workspacePath) };
    case "ai.statuses": {
      const registry = await tasks.list();
      const summarize = async (target: string) => { const summary = summarizeAiSessions(await Promise.all([codex.get(target), copilot.get(target)])); return { ...summary, ...await new GitService(target).diffStats() }; };
      const entries = await Promise.all(registry.tasks.map(async (task) => [task.id, await summarize(tasks.taskPath(task.id))] as const));
      return { root: await summarize(rootWorkspace), tasks: Object.fromEntries(entries) };
    }
    case "useful.list": return { files: await usefulFiles.list() };
    case "useful.read": return { content: await usefulFiles.read(request.payload.scope, request.payload.name) };
    case "useful.create": await usefulFiles.create(request.payload.scope, request.payload.name); return {};
    case "useful.write": await usefulFiles.write(request.payload.scope, request.payload.name, request.payload.content); return {};
    case "useful.rename": await usefulFiles.rename(request.payload.scope, request.payload.name, request.payload.newName); return {};
    case "useful.delete": await usefulFiles.delete(request.payload.scope, request.payload.name); return {};
    case "http.execute": return executeHttpRequest(request.payload.method, request.payload.url, request.payload.headers, request.payload.body);
    case "filesystem.listTree": return { tree: await filesystem.listTree() };
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
      return { terminalId: processManager.create(request.payload.cols, request.payload.rows) };
    }
    case "terminal.input": {
      if (typeof request.payload.terminalId !== "string" || typeof request.payload.data !== "string") throw new CoreError("INVALID_REQUEST", "terminalId and data must be strings");
      processManager.input(request.payload.terminalId, request.payload.data);
      return {};
    }
    case "terminal.resize": {
      if (typeof request.payload.terminalId !== "string") throw new CoreError("INVALID_REQUEST", "terminalId must be a string");
      processManager.resize(request.payload.terminalId, request.payload.cols, request.payload.rows);
      return {};
    }
    case "terminal.close": {
      if (typeof request.payload.terminalId !== "string") throw new CoreError("INVALID_REQUEST", "terminalId must be a string");
      processManager.close(request.payload.terminalId);
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
    case "git.commit": return { hash: await git.commit(request.payload.paths, request.payload.message) };
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
