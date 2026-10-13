// @vitest-environment node
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { CoreClient } from "./client";
import { ConnectionRecovery, reconnectWorkspace, restoreTerminal } from "./connection-recovery";

it.runIf(typeof globalThis.WebSocket === "function")("recovers a silent WHATWG WebSocket once and rebuilds subscriptions without replaying mutations", async () => {
  // Node's native WHATWG WebSocket has browser semantics: no ping method or ws EventEmitter API.
  expect("ping" in WebSocket.prototype).toBe(false);
  expect("on" in WebSocket.prototype).toBe(false);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  const received: Array<{ connection: number; type: string; payload: Record<string, unknown> }> = [];
  let connection = 0;
  let silent = false;
  let selectedRoot = "root-primary";
  let subscribed = false;
  server.on("connection", (socket) => {
    const current = ++connection;
    selectedRoot = "root-primary";
    subscribed = false;
    socket.on("message", (data) => {
      const request = JSON.parse(String(data));
      received.push({ connection: current, type: request.type, payload: request.payload });
      if (silent && current === 1) return; // no frames, no close/error, still OPEN
      let result: unknown = {};
      if (request.type === "protocol.handshake") result = { compatible: true };
      if (request.type === "workspace.selectRoot") { selectedRoot = request.payload.rootId; result = { root: { id: selectedRoot } }; }
      if (request.type === "workspace.roots") result = { roots: [{ id: "root-primary" }, { id: "root-api" }], selectedRootId: selectedRoot };
      if (request.type === "workspace.open") { subscribed = true; result = { workspace: "/api/tasks/task-a", options: { openFiles: [], terminal: { tabs: [{ terminalId: "terminal-a" }] } } }; }
      if (request.type === "terminal.attach") result = { state: "available", session: { terminalId: "terminal-a", status: "running", output: "history" } };
      if (request.type === "tasks.list") result = { tasks: [{ id: "task-a" }], selectedTaskId: "task-a" };
      socket.send(JSON.stringify({ id: request.id, ok: true, result }));
      if (request.type === "terminal.attach" && subscribed) socket.send(JSON.stringify({ type: "terminal.output", payload: { rootId: selectedRoot, terminalId: "terminal-a", data: "live" } }));
    });
  });
  const client = new CoreClient(1_000, { intervalMs: 40, timeoutMs: 100 });
  let restored = false;
  const attempts = vi.fn(async (signal: AbortSignal) => {
    const { workspace } = await reconnectWorkspace(client, "127.0.0.1", address.port, false, signal, { rootId: "root-api", workspace: "/api/tasks/task-a", taskId: "task-a" });
    expect(workspace.workspace).toBe("/api/tasks/task-a");
    expect(await client.request("tasks.list", {})).toMatchObject({ selectedTaskId: "task-a" });
    await restoreTerminal(client, "terminal-a", true);
    restored = true;
  });
  const recovery = new ConnectionRecovery(attempts, () => client.disconnect(), 5, 10);
  const disconnected = vi.fn(() => { recovery.start(); recovery.start(); });
  const events = vi.fn();
  client.onDisconnected = disconnected;
  client.onServerEvent = events;
  try {
    await client.connect("127.0.0.1", address.port);
    client.setRoot("root-api"); // remembered routing on the next connection
    await vi.waitFor(() => expect(received.filter((item) => item.type === "protocol.keepAlive").length).toBeGreaterThanOrEqual(2));
    expect(disconnected).not.toHaveBeenCalled();
    silent = true;
    const obsolete = client.request("filesystem.writeFile", { path: "a", content: "changed" });
    const rejected = expect(obsolete).rejects.toThrow("liveness check timed out");
    await vi.waitFor(() => expect(restored).toBe(true), { timeout: 2_000 });
    await rejected;
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "terminal.output" })));
    expect(disconnected).toHaveBeenCalledOnce();
    expect(attempts).toHaveBeenCalledOnce();
    expect(connection).toBe(2);
    expect(client.getRoot()).toBe("root-api");
    expect(received.filter((item) => item.type === "filesystem.writeFile")).toHaveLength(1);
    expect(received.filter((item) => item.connection === 2).map((item) => item.type)).toEqual(expect.arrayContaining(["workspace.selectRoot", "workspace.open", "terminal.attach"]));
    expect(received.find((item) => item.connection === 2 && item.type === "workspace.selectRoot")?.payload).toEqual({ rootId: "root-api", preserveTaskSelection: true });
    expect(received.some((item) => item.type === "terminal.create" || item.type === "tasks.switch")).toBe(false);
  } finally {
    recovery.stop(); client.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 5_000);

it("does not create a missing terminal during recovery", async () => {
  const request = vi.fn().mockResolvedValue({ state: "stale" });
  const client = { request } as unknown as CoreClient;
  await expect(restoreTerminal(client, "gone", true)).rejects.toThrow("unavailable");
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith("terminal.attach", { terminalId: "gone" });
  await expect(restoreTerminal(client, undefined, true)).rejects.toThrow("unavailable");
  expect(request).toHaveBeenCalledTimes(1);
});
