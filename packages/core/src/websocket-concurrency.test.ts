import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket, type WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { protocolCompatibility, type ProtocolOperations, type RequestType, type Response, type ServerEvent } from "@remote-ide/protocol";
import { WorkspaceFileSystem } from "./filesystem.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { createServer } from "./server.js";

it("delivers independent responses and real terminal output while a file read is held", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-ws-concurrency-"));
  const workspace = path.join(directory, "project");
  let server: WebSocketServer | undefined;
  let socket: WebSocket | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const originalRead = WorkspaceFileSystem.prototype.read;
  const read = vi.spyOn(WorkspaceFileSystem.prototype, "read").mockImplementation(async function (this: WorkspaceFileSystem, file) {
    if (file === "slow.txt") { entered(); await gate; }
    return originalRead.call(this, file);
  });
  let releaseSwitch: (() => void) | undefined;
  let restoreSelect: (() => void) | undefined;
  vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
  try {
    await mkdir(workspace);
    await promisify(execFile)("git", ["-C", workspace, "init", "-q"]);
    await writeFile(path.join(workspace, "slow.txt"), "slow contents");
    await writeFile(path.join(workspace, "fast.txt"), "fast contents");
    server = await createServer("127.0.0.1", 0, workspace);
    if (!server.address()) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server port");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const responses = new Map<string, Response>();
    const events: ServerEvent[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Response | ServerEvent;
      if ("type" in message) events.push(message);
      else responses.set(message.id, message);
    });
    await once(socket, "open");
    let sequence = 0;
    let rootId: string | undefined;
    const send = <T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]) => {
      const id = String(++sequence);
      socket!.send(JSON.stringify({ id, type, payload, rootId }));
      return id;
    };
    const response = async (id: string) => {
      await vi.waitFor(() => expect(responses.has(id)).toBe(true), { timeout: 5_000 });
      return responses.get(id)!;
    };
    expect(await response(send("protocol.handshake", { compatibility: protocolCompatibility, clientVersion: "test" }))).toMatchObject({ ok: true, result: { compatible: true } });
    const roots = await response(send("workspace.roots", {}));
    if (!roots.ok) throw new Error("Root discovery failed");
    rootId = (roots.result as ProtocolOperations["workspace.roots"]["result"]).selectedRootId;
    expect(await response(send("workspace.open", {}))).toMatchObject({ ok: true });
    const terminal = await response(send("terminal.create", { cols: 80, rows: 24 }));
    if (!terminal.ok) throw new Error("Terminal creation failed");
    const { terminalId } = terminal.result as ProtocolOperations["terminal.create"]["result"];

    const slowId = send("filesystem.readFile", { path: "slow.txt" });
    await started;
    expect(await response(send("protocol.keepAlive", {}))).toMatchObject({ ok: true, result: {} });
    const fastId = send("filesystem.readFile", { path: "fast.txt" });
    const errorId = send("filesystem.readFile", { path: "missing.txt" });
    // printf emits a contiguous marker; terminal echo contains the split arguments.
    const inputId = send("terminal.input", { terminalId, data: "printf '%s%s\\n' VIBE_ CONCURRENT\r" });
    expect(await response(fastId)).toMatchObject({ id: fastId, ok: true, rootId, result: { content: "fast contents" } });
    expect(await response(errorId)).toMatchObject({ id: errorId, ok: false });
    expect(await response(inputId)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(events.filter((event) => event.type === "terminal.output" && event.payload.terminalId === terminalId).map((event) => event.type === "terminal.output" ? event.payload.data : "").join("")).toContain("VIBE_CONCURRENT"), { timeout: 5_000 });
    expect(responses.has(slowId)).toBe(false);
    release();
    expect(await response(slowId)).toMatchObject({ id: slowId, ok: true, result: { content: "slow contents" } });
    expect([...responses.keys()].indexOf(fastId)).toBeLessThan([...responses.keys()].indexOf(slowId));

    // Dependent mutations remain explicitly awaited before the next read.
    expect(await response(send("filesystem.rename", { path: "fast.txt", newPath: "renamed.txt" }))).toMatchObject({ ok: true });
    expect(await response(send("filesystem.readFile", { path: "renamed.txt" }))).toMatchObject({ ok: true, result: { content: "fast contents" } });
    expect(await response(send("terminal.close", { terminalId }))).toMatchObject({ ok: true });

    let switchEntered!: () => void;
    const switching = new Promise<void>((resolve) => { switchEntered = resolve; });
    const switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve; });
    const originalSelect = WorkspaceTaskStore.prototype.select;
    const select = vi.spyOn(WorkspaceTaskStore.prototype, "select").mockImplementation(async function (this: WorkspaceTaskStore, taskId) {
      switchEntered();
      await switchGate;
      return originalSelect.call(this, taskId);
    });
    restoreSelect = () => select.mockRestore();
    const switchId = send("tasks.switch", {});
    await switching;
    read.mockClear();
    const orderedReadId = send("filesystem.readFile", { path: "renamed.txt" });
    // An unscoped round trip proves Core admitted the messages behind the switch.
    await response(send("workspace.roots", {}));
    expect(await response(send("protocol.keepAlive", {}))).toMatchObject({ ok: true, result: {} });
    expect(read).not.toHaveBeenCalled();
    expect(responses.has(orderedReadId)).toBe(false);
    releaseSwitch!();
    expect(await response(switchId)).toMatchObject({ ok: true });
    expect(await response(orderedReadId)).toMatchObject({ ok: true, result: { content: "fast contents" } });
    restoreSelect(); restoreSelect = undefined;

    // Recovery of a secondary root must retain its durable selected task/worktree.
    const secondary = path.join(directory, "secondary");
    await mkdir(secondary);
    const git = promisify(execFile);
    await git("git", ["-C", secondary, "init", "-q"]);
    await writeFile(path.join(secondary, "task.txt"), "root contents");
    await git("git", ["-C", secondary, "add", "task.txt"]);
    await git("git", ["-C", secondary, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
    const taskStore = new WorkspaceTaskStore(secondary);
    const task = await taskStore.create("recovery-task");
    const taskWorkspace = taskStore.taskPath(task.id);
    await writeFile(path.join(taskWorkspace, "task.txt"), "task contents");
    const added = await response(send("workspace.addRoot", { path: secondary, alias: "secondary" }));
    if (!added.ok) throw new Error("Could not add secondary root");
    const secondaryId = (added.result as ProtocolOperations["workspace.addRoot"]["result"]).root.id;
    const selectSecondary = () => send("workspace.selectRoot", { rootId: secondaryId, preserveTaskSelection: true });
    expect(await response(selectSecondary())).toMatchObject({ ok: true, result: { workspace: taskWorkspace } });
    rootId = secondaryId;
    const durableTerminal = await response(send("terminal.create", { cols: 80, rows: 24 }));
    if (!durableTerminal.ok) throw new Error("Could not create durable terminal");
    const durableTerminalId = (durableTerminal.result as ProtocolOperations["terminal.create"]["result"]).terminalId;
    const closed = once(socket, "close"); socket.close(); await closed;
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Response | ServerEvent;
      if ("type" in message) events.push(message); else responses.set(message.id, message);
    });
    await once(socket, "open");
    rootId = undefined;
    expect(await response(send("protocol.handshake", { compatibility: protocolCompatibility }))).toMatchObject({ ok: true });
    rootId = secondaryId;
    expect(await response(selectSecondary())).toMatchObject({ ok: true, result: { workspace: taskWorkspace } });
    rootId = secondaryId;
    expect(await response(send("workspace.open", {}))).toMatchObject({ ok: true, result: { workspace: taskWorkspace } });
    expect(await response(send("tasks.list", {}))).toMatchObject({ ok: true, result: { selectedTaskId: task.id } });
    expect(await response(send("filesystem.readFile", { path: "task.txt" }))).toMatchObject({ ok: true, result: { content: "task contents" } });
    expect(await response(send("terminal.attach", { terminalId: durableTerminalId }))).toMatchObject({ ok: true, result: { state: "available" } });
    expect(await response(send("terminal.input", { terminalId: durableTerminalId, data: "printf '%s%s\\n' RESTORED_ OUTPUT\r" }))).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(events.filter((event) => event.type === "terminal.output" && event.payload.terminalId === durableTerminalId).map((event) => event.type === "terminal.output" ? event.payload.data : "").join("")).toContain("RESTORED_OUTPUT"), { timeout: 5_000 });
    expect(await response(send("terminal.close", { terminalId: durableTerminalId }))).toMatchObject({ ok: true });
    // Ordinary user root selection still returns to the root and clears task selection.
    expect(await response(send("workspace.selectRoot", { rootId: secondaryId }))).toMatchObject({ ok: true, result: { workspace: secondary } });
    const afterSelection = await response(send("tasks.list", {}));
    expect(afterSelection.ok && (afterSelection.result as ProtocolOperations["tasks.list"]["result"]).selectedTaskId).toBeUndefined();
  } finally {
    release();
    releaseSwitch?.();
    restoreSelect?.();
    read.mockRestore();
    if (socket && socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.close(); await closed; }
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
