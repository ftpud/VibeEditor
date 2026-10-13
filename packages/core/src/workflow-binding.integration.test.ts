import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket, type WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { protocolCompatibility, type AiMcpServer, type AiSession, type HarnessBlock, type HarnessRun, type ProtocolOperations, type RequestType, type Response } from "@remote-ide/protocol";
import { AiTimerStore } from "./ai-timers.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { WorkspaceRootRegistry } from "./workspace-roots.js";
import { HarnessStore } from "./harnesses.js";
import { HarnessRunner } from "./harness-runner.js";
import { createServer } from "./server.js";

const fake = vi.hoisted(() => ({ registry: undefined as unknown }));
vi.mock("./ai/index.js", () => ({ createAcpRegistry: () => fake.registry }));
const exec = promisify(execFile);
let directory: string;
let server: WebSocketServer | undefined;
const sockets: WebSocket[] = [];
async function closeServer() {
  for (const socket of sockets.splice(0)) { const closed = once(socket, "close"); socket.terminate(); await closed; }
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
}
afterEach(async () => { await closeServer(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function connect(initialRootId: string) {
  const address = server!.address(); if (!address || typeof address === "string") throw new Error("No port");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); sockets.push(socket);
  const responses = new Map<string, Response>(); let sequence = 0; let rootId = initialRootId;
  socket.on("message", (data) => { const value = JSON.parse(data.toString()); if (value.id) responses.set(value.id, value); });
  await once(socket, "open");
  const request = async <T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]): Promise<ProtocolOperations[T]["result"]> => {
    const id = String(++sequence); socket.send(JSON.stringify({ id, type, payload, rootId }));
    await vi.waitFor(() => expect(responses.has(id)).toBe(true), { timeout: 5000 });
    const response = responses.get(id)!; if (!response.ok) throw new Error(response.error.message);
    return response.result as ProtocolOperations[T]["result"];
  };
  await request("protocol.handshake", { compatibility: protocolCompatibility });
  return { request, select: async (id: string) => { await request("workspace.selectRoot", { rootId: id }); rootId = id; } };
}
async function setup() {
  directory = await mkdtemp(path.join(os.tmpdir(), "workflow-binding-server-"));
  vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
  const primary = path.join(directory, "primary"), secondary = path.join(directory, "secondary");
  for (const root of [primary, secondary]) {
    await mkdir(root); await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
  }
  const roots = await WorkspaceRootRegistry.open(primary), second = await roots.add(secondary, "secondary");
  const tasks = new WorkspaceTaskStore(secondary), a = await tasks.create("task-a"), b = await tasks.create("task-b");
  const wa = tasks.taskPath(a.id), wb = tasks.taskPath(b.id);
  const sessions = new Map<string, AiSession>();
  const sends: Array<{ workspace: string; servers?: AiMcpServer[] }> = [];
  const starts: Array<{ workspace: string; servers?: AiMcpServer[] }> = [];
  const provider = {
    descriptor: { id: "codex", options: [] }, get: async (workspace: string) => sessions.get(workspace),
    send: async (workspace: string, request: { mcpServers?: AiMcpServer[] }) => {
      sends.push({ workspace, servers: request.mcpServers });
      const result = await exec(process.execPath, ["-e", 'require("node:fs").appendFileSync("continuation-cwd.txt",process.cwd()+"\\n");process.stdout.write(process.cwd())'], { cwd: workspace });
      const session = { id: "agent", model: "test", reasoning: "", status: "done", messages: [{ id: "reply", role: "assistant", text: result.stdout, timestamp: "now" }] } as AiSession;
      sessions.set(workspace, session); return session;
    },
    startFreshSession: async (workspace: string, request: { mcpServers?: AiMcpServer[] }) => {
      starts.push({ workspace, servers: request.mcpServers });
      const result = await exec(process.execPath, ["-e", 'require("node:fs").appendFileSync("actual-cwd.txt",process.cwd()+"\\n");process.stdout.write(process.cwd())'], { cwd: workspace });
      const session = { id: "agent", model: "test", reasoning: "", status: "done", messages: [{ id: "reply", role: "assistant", text: result.stdout, timestamp: "now" }] } as AiSession;
      sessions.set(workspace, session); return session;
    }
  };
  fake.registry = { get: () => provider, list: () => [provider.descriptor] };
  const store = new HarnessStore(secondary);
  const created = await store.create("Server binding");
  const block = (id: string, type: HarnessBlock["type"], extra: Partial<HarnessBlock> = {}): HarnessBlock => ({ id, type, label: id, prompt: "{{input}}", position: { x: 0, y: 0 }, ...extra });
  const definition = await store.update({ ...created, blocks: [block("agent", "ai"), block("script", "script", { command: "pwd > actual-script.txt" }), block("app", "run_app", { command: "pwd > actual-app.txt; exec sleep 300", app: { name: "bound-app", actions: ["start"] } })], edges: [{ id: "next", from: "agent", to: "script", type: "follow" }, { id: "app", from: "script", to: "app", type: "follow" }] });
  const start = async () => { server = await createServer("127.0.0.1", 0, primary); if (!server.address()) await once(server, "listening"); };
  return { primary, secondary, roots, second, tasks, a, b, wa, wb, store, definition, starts, sends, start };
}

it("keeps a secondary task binding through in-flight dispatch, peer task selection, root switches and reconnect", async () => {
  const f = await setup(); await f.start();
  const client = await connect(f.roots.primary().id), peer = await connect(f.roots.primary().id);
  await client.select(f.second.id); await peer.select(f.second.id);
  let entered = false; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const original = HarnessRunner.prototype.start;
  const gate = vi.spyOn(HarnessRunner.prototype, "start").mockImplementation(async function (this: HarnessRunner, ...args: Parameters<HarnessRunner["start"]>) { entered = true; await held; return original.apply(this, args); });
  const pending = client.request("harnesses.run", { harnessId: f.definition.id, input: "start", target: { taskId: f.a.id } });
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    await peer.request("tasks.switch", { taskId: f.b.id });
    await client.select(f.roots.primary().id);
  } finally { release(); }
  const { run } = await pending; gate.mockRestore();
  await vi.waitFor(async () => expect((await f.store.runs()).find((item) => item.id === run.id)).toMatchObject({ status: "succeeded" }));
  expect(await readFile(path.join(f.wa, "actual-cwd.txt"), "utf8")).toBe(`${f.wa}\n`);
  expect(await readFile(path.join(f.wa, "actual-script.txt"), "utf8")).toBe(`${f.wa}\n`);
  await expect(readFile(path.join(f.wb, "actual-cwd.txt"))).rejects.toThrow();
  await vi.waitFor(async () => expect(await readFile(path.join(f.wa, "actual-app.txt"), "utf8")).toBe(`${f.wa}\n`));
  await expect(readFile(path.join(f.wb, "actual-app.txt"))).rejects.toThrow();
  const reconnected = await connect(f.roots.primary().id); await reconnected.select(f.second.id);
  const listed = (await reconnected.request("harnesses.runs", {})).runs.find((item) => item.id === run.id)!;
  expect(listed.binding?.taskId).toBe(f.a.id);
  const rerun = (await reconnected.request("harnesses.run", { harnessId: f.definition.id, input: "rerun", rerunRunId: run.id, target: { taskId: f.b.id } })).run;
  await vi.waitFor(async () => expect((await f.store.runs()).find((item) => item.id === rerun.id)?.status).toBe("succeeded"));
  expect(rerun.binding).toEqual(run.binding);
}, 15000);

it("recovers queued secondary-root work on server restart with the primary Core bridge and rejects unavailable bindings", async () => {
  const f = await setup(); await f.start(); await closeServer();
  f.definition = await f.store.update({ ...f.definition, blocks: f.definition.blocks.filter((block) => block.id !== "app").map((block) => block.id === "agent" ? { ...block, type: "prompt" } : { ...block, type: "verification", command: undefined, verification: { command: "pwd > actual-script.txt" } }), edges: f.definition.edges.filter((edge) => edge.id !== "app").map(({ type, ...edge }) => edge) });
  const createdAt = new Date().toISOString();
  const run: HarnessRun = { id: "restart-secondary", harnessId: f.definition.id, harnessVersion: f.definition.version, definition: f.definition, executionPlan: { version: 1, createdAt, definitionVersion: f.definition.version, order: ["agent", "script"], blocks: [{ blockId: "agent", incoming: [], outgoing: ["next"] }, { blockId: "script", incoming: ["next"], outgoing: [] }] }, binding: { rootWorkspace: f.secondary, workspace: f.wa, taskId: f.a.id, taskName: f.a.name }, workspace: f.wa, input: "recover", status: "queued", createdAt, blocks: [{ blockId: "agent", status: "queued" }, { blockId: "script", status: "queued" }], operations: [] };
  await f.store.saveRun(run); await f.tasks.select(f.b.id); await f.start();
  await vi.waitFor(async () => expect((await f.store.runs()).find((item) => item.id === run.id)).toMatchObject({ status: "succeeded" }));
  expect(await readFile(path.join(f.wa, "actual-cwd.txt"), "utf8")).toBe(`${f.wa}\n`);
  expect(await readFile(path.join(f.wa, "actual-script.txt"), "utf8")).toBe(`${f.wa}\n`);
  const tools = f.starts[0]!.servers?.find((item) => item.name === "vibe-editor");
  expect(tools && tools.transport === "stdio" ? tools.env : undefined).toMatchObject({ VIBE_EDITOR_ROOT_WORKSPACE: f.secondary, VIBE_EDITOR_BRIDGE_WORKSPACE: f.primary });
  await closeServer();
  await f.store.saveRun({ ...run, id: "restart-missing" }); await rm(f.wa, { recursive: true, force: true });
  await f.start();
  await vi.waitFor(async () => expect((await f.store.runs()).find((item) => item.id === "restart-missing")?.error).toContain("unavailable"));
  expect(f.starts).toHaveLength(1);
}, 15000);

it("uses secondary recoveryAppend and the server timer owner loop after switches and reconnect", async () => {
  const f = await setup();
  f.definition = await f.store.update({ ...f.definition, blocks: [{ ...f.definition.blocks[0]!, type: "prompt" }], edges: [] });
  await f.start(); const initial = await connect(f.roots.primary().id); await initial.select(f.second.id);
  const { run } = await initial.request("harnesses.run", { harnessId: f.definition.id, input: "initial", target: { taskId: f.a.id } });
  await vi.waitFor(async () => expect((await f.store.runs()).find((item) => item.id === run.id)?.status).toBe("succeeded"));
  const saved = (await f.store.runs()).find((item) => item.id === run.id)!;
  await closeServer();
  const alias = saved.blocks[0]!.workspace!;
  await f.store.saveRun({ ...saved, status: "retry_scheduled", completedAt: undefined, blocks: [{ ...saved.blocks[0]!, status: "retry_scheduled", failureReason: "recovery_orphaned", pauseId: "resume-after-restart", completedAt: undefined }] });
  const timer = await new AiTimerStore(f.primary).set(alias, "codex", "delayed continuation", 3600, { runId: saved.id, blockId: "agent" });
  await f.tasks.select(f.b.id); await f.start();
  const resumed = await connect(f.roots.primary().id); await resumed.select(f.second.id);
  await resumed.request("harnesses.pause.retry", { runId: saved.id, blockId: "agent", pauseId: "resume-after-restart" });
  await vi.waitFor(async () => expect((await f.store.runs()).find((item) => item.id === saved.id)?.blocks[0]?.status).toBe("waiting_timer"));
  await resumed.request("tasks.switch", { taskId: f.b.id }); await resumed.select(f.roots.primary().id);
  const peer = await connect(f.roots.primary().id);
  await peer.request("timers.fire", { timerId: timer.id });
  await vi.waitFor(async () => expect((await f.store.runs()).find((item) => item.id === saved.id)?.status).toBe("succeeded"));
  expect(f.sends).toHaveLength(2);
  expect(f.sends.every((send) => send.workspace === alias)).toBe(true);
  const tools = f.sends[0]!.servers?.find((item) => item.name === "vibe-editor");
  expect(tools && tools.transport === "stdio" ? tools.env : undefined).toMatchObject({ VIBE_EDITOR_ROOT_WORKSPACE: f.secondary, VIBE_EDITOR_BRIDGE_WORKSPACE: f.primary });
  expect(await readFile(path.join(f.wa, "continuation-cwd.txt"), "utf8")).toBe(`${f.wa}\n${f.wa}\n`);
  await expect(readFile(path.join(f.wb, "continuation-cwd.txt"))).rejects.toThrow();
}, 15000);
