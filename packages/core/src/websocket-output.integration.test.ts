import { execFile } from "node:child_process";
import { once } from "node:events";
import { realpath, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import chokidar from "chokidar";
import { WebSocket, type WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { protocolCompatibility, type ProtocolOperations, type RequestType, type Response, type ServerEvent } from "@remote-ide/protocol";
import { createServer } from "./server.js";
import { JavaProjectService } from "./java.js";
import { JdtLanguageService } from "./jdtls.js";
import { TaskCheckpointStore } from "./task-checkpoints.js";
import * as output from "./websocket-output.js";

for (const failure of ["buffer pressure", "asynchronous send error"] as const) {
  it(`disconnects on ${failure}, isolates healthy peers, and releases session services while preserving the PTY`, async () => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "vibe-output-integration-")));
    const workspace = path.join(directory, "primary");
    const secondary = path.join(directory, "secondary");
    vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
    const watch = vi.spyOn(chokidar, "watch");
    const javaClose = vi.spyOn(JavaProjectService.prototype, "close");
    const jdtClose = vi.spyOn(JdtLanguageService.prototype, "close");
    const sends = vi.spyOn(output, "sendWebSocketData");
    let server: WebSocketServer | undefined;
    const clients: WebSocket[] = [];
    try {
      for (const root of [workspace, secondary]) {
        await mkdir(root);
        await promisify(execFile)("git", ["-C", root, "init", "-q"]);
        await writeFile(path.join(root, "file.txt"), "file contents");
      }
      server = await createServer("127.0.0.1", 0, workspace, { outbound: { maxBufferedBytes: 4096, maxCoalescedBytes: 1024 } });
      if (!server.address()) await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing port");
      const peers: WebSocket[] = [];
      server.on("connection", (socket) => peers.push(socket));
      const connect = async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); clients.push(socket);
        const responses = new Map<string, Response>(); const events: ServerEvent[] = [];
        let sequence = 0; let rootId: string | undefined;
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString()) as Response | ServerEvent;
          if ("type" in message) events.push(message); else responses.set(message.id, message);
        });
        await once(socket, "open");
        const send = <T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]) => {
          const id = String(++sequence); socket.send(JSON.stringify({ id, type, payload, rootId })); return id;
        };
        const request = async <T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]): Promise<ProtocolOperations[T]["result"]> => {
          const id = send(type, payload);
          await vi.waitFor(() => expect(responses.has(id)).toBe(true), { timeout: 5_000 });
          const response = responses.get(id)!;
          if (!response.ok) throw new Error(response.error.message);
          return response.result as ProtocolOperations[T]["result"];
        };
        await request("protocol.handshake", { compatibility: protocolCompatibility });
        rootId = (await request("workspace.roots", {})).selectedRootId;
        await request("workspace.open", {});
        return { socket, request, send, responses, events, setRoot: (id: string) => { rootId = id; } };
      };
      const slow = await connect(); const healthy = await connect();
      const secondaryRoot = (await slow.request("workspace.addRoot", { path: secondary, alias: "secondary" })).root.id;
      await slow.request("workspace.selectRoot", { rootId: secondaryRoot }); slow.setRoot(secondaryRoot);
      const directoryWatch = watch.mock.results.find((result, index) => watch.mock.calls[index]?.[0] === secondary && result.type === "return")?.value;
      expect(directoryWatch).toBeDefined();
      expect(Object.keys(directoryWatch!.getWatched()).length).toBeGreaterThan(0);
      const terminal = await slow.request("terminal.create", { cols: 80, rows: 24 });
      await slow.request("terminal.input", { terminalId: terminal.terminalId, data: "printf '%s%s\\n' BEFORE_ LOSS\r" });
      await vi.waitFor(() => expect(slow.events.filter((event) => event.type === "terminal.output").map((event) => event.type === "terminal.output" ? event.payload.data : "").join("")).toContain("BEFORE_LOSS"));
      const beforeJava = javaClose.mock.calls.length; const beforeJdt = jdtClose.mock.calls.length;
      const peer = peers[0]!;
      if (failure === "buffer pressure") {
        Object.defineProperty(peer, "bufferedAmount", { configurable: true, get: () => 4090 });
        for (let index = 0; index < 1000; index++) output.sendWebSocketData(peer, JSON.stringify({ type: "ai.changed", payload: { rootId: secondaryRoot } }));
      } else {
        peer.send = ((_data: unknown, callback: (error?: Error) => void) => { process.nextTick(() => callback(new Error("simulated async write failure"))); }) as typeof peer.send;
      }
      const closed = once(slow.socket, "close");
      // The command is executed once even though its acknowledgement cannot be delivered.
      const interruptedId = slow.send("terminal.input", { terminalId: terminal.terminalId, data: "sleep 0.2; printf '%s%s\\n' AFTER_ LOSS\r" });
      const healthyRead = healthy.request("filesystem.readFile", { path: "file.txt" });
      await closed;
      expect(slow.responses.has(interruptedId)).toBe(false);
      expect(await healthyRead).toMatchObject({ content: "file contents" });
      expect(await healthy.request("protocol.keepAlive", {})).toEqual({});
      const pong = once(healthy.socket, "pong");
      const pingData = Buffer.from([0, 255, 1, 128]);
      healthy.socket.ping(pingData);
      expect((await pong)[0]).toEqual(pingData);
      await vi.waitFor(() => {
        expect(javaClose.mock.calls.length).toBeGreaterThan(beforeJava);
        expect(jdtClose.mock.calls.length).toBeGreaterThan(beforeJdt);
        expect(directoryWatch!.getWatched()).toEqual({});
      });
      const retiredSends = () => sends.mock.calls.filter(([socket]) => socket === peer).length;
      const afterClose = retiredSends();
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Output emitted after disconnect stays in the durable PTY buffer, without retaining/sending to the dead owner.
      expect(retiredSends()).toBe(afterClose);
      const recovered = await connect();
      await recovered.request("workspace.selectRoot", { rootId: secondaryRoot, preserveTaskSelection: true }); recovered.setRoot(secondaryRoot);
      await recovered.request("workspace.open", {});
      const attached = await recovered.request("terminal.attach", { terminalId: terminal.terminalId });
      expect(attached.state).toBe("available");
      if (attached.state !== "available") throw new Error("Durable PTY was lost");
      expect(attached.session.status).toBe("running");
      expect(attached.session.output).toContain("BEFORE_LOSS");
      expect(attached.session.output.match(/AFTER_LOSS/g)).toHaveLength(1);
      await recovered.request("terminal.input", { terminalId: terminal.terminalId, data: "printf '%s%s\\n' LIVE_ AGAIN\r" });
      await vi.waitFor(() => expect(recovered.events.filter((event) => event.type === "terminal.output").map((event) => event.type === "terminal.output" ? event.payload.data : "").join("")).toContain("LIVE_AGAIN"));
      await recovered.request("terminal.close", { terminalId: terminal.terminalId });
    } finally {
      for (const socket of clients) if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.close(); await closed; }
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      vi.restoreAllMocks(); vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
}

it("closes services that finish initialization after an outbound failure", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "vibe-output-startup-")));
  const workspace = path.join(directory, "primary");
  vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
  let server: WebSocketServer | undefined;
  let socket: WebSocket | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    await mkdir(workspace);
    await promisify(execFile)("git", ["-C", workspace, "init", "-q"]);
    server = await createServer("127.0.0.1", 0, workspace, { outbound: { maxBufferedBytes: 1024 } });
    if (!server.address()) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const recover = TaskCheckpointStore.prototype.recover;
    vi.spyOn(TaskCheckpointStore.prototype, "recover").mockImplementation(async function (this: TaskCheckpointStore) { entered(); await gate; await recover.call(this); });
    const javaClose = vi.spyOn(JavaProjectService.prototype, "close");
    const jdtClose = vi.spyOn(JdtLanguageService.prototype, "close");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ id: "handshake", type: "protocol.handshake", payload: { compatibility: protocolCompatibility } }));
    await started;
    const peer = [...server.clients][0]!;
    Object.defineProperty(peer, "bufferedAmount", { configurable: true, get: () => 2048 });
    socket.send(JSON.stringify({ id: "probe", type: "protocol.keepAlive", payload: {} }));
    await closed;
    release();
    await vi.waitFor(() => { expect(javaClose).toHaveBeenCalledOnce(); expect(jdtClose).toHaveBeenCalledOnce(); });
  } finally {
    release();
    if (socket && socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.close(); await closed; }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
