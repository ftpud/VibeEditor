import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { protocolCompatibility } from "@remote-ide/protocol";
import { recoveryFailureFeedback } from "./connection-recovery";
import { CoalescedAsyncAction, CoreClient } from "./client";

it("keeps the downloadable Desktop manifest aligned with the protocol package", async () => {
  const manifestPath = path.resolve(process.cwd(), "compatibility.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { compatibility: unknown };
  expect(manifest.compatibility).toEqual(protocolCompatibility);
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket closed");
    this.sent.push(data);
    const request = JSON.parse(data) as { id: string; type: string };
    if (request.type === "protocol.handshake") this.receive({ id: request.id, ok: true, result: { compatible: true, compatibility: { minimum: 1, maximum: 1 } } });
    if (request.type === "protocol.keepAlive") this.receive({ id: request.id, ok: true, result: {} });
    if (request.type === "workspace.roots") this.receive({ id: request.id, ok: true, result: { roots: [{ id: "root-primary", alias: "project", path: "/project", primary: true }, { id: "root-api", alias: "api", path: "/api", primary: false }], selectedRootId: "root-primary" } });
    if (request.type === "workspace.selectRoot") this.receive({ id: request.id, ok: true, rootId: "root-api", result: { root: { id: "root-api", alias: "api", path: "/api", primary: false }, workspace: "/api", projectName: "api", tree: [], options: { openFiles: [] } } });
  }
  close(): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe("CoreClient streaming disconnects", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves snapshot error codes through response parsing and keeps the client usable", async () => {
    const client = new CoreClient();
    try {
      const connecting = client.connect("core", 7331);
      const socket = FakeWebSocket.instances[0]!;
      socket.open(); await connecting;
      const pending = client.request("workspace.open", {}).catch((error: unknown) => error);
      const id = JSON.parse(socket.sent.at(-1)!).id;
      socket.receive({ id, ok: false, error: { code: "WORKSPACE_TREE_TOO_LARGE", message: "Open a smaller workspace" } });
      const error = await pending;
      expect(error).toMatchObject({ code: "WORKSPACE_TREE_TOO_LARGE", message: "WORKSPACE_TREE_TOO_LARGE: Open a smaller workspace" });
      expect(recoveryFailureFeedback(error)).toMatchObject({ retry: false, kind: "error" });
      expect(client.isConnected()).toBe(true);
      await expect(client.request("protocol.keepAlive", {})).resolves.toEqual({});
    } finally { client.disconnect(); }
  });

  it("ignores malformed event sequences without consuming pending responses or leaking diagnostic payloads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = new CoreClient();
    try {
      const connecting = client.connect("core", 7331);
      const socket = FakeWebSocket.instances[0]!; socket.open(); await connecting;
      const events = vi.fn(); client.onServerEvent = events;
      let settled = false;
      const pending = client.request("filesystem.readFile", { path: "private-file" }).then((result) => { settled = true; return result; });
      const id = JSON.parse(socket.sent.at(-1)!).id;
      for (let i = 0; i < 20; i++) {
        socket.onmessage?.({ data: "{malformed private-secret" });
        for (const message of [null, [], { type: "future.event", payload: {} },
          { type: "terminal.output" }, { type: "terminal.output", payload: null },
          { type: "terminal.output", payload: { rootId: "r", terminalId: "t", data: 42 } },
          { type: "java.debug.state", payload: { rootId: "r", status: "paused", variables: [null] } },
          { type: "runConfig.changed", payload: { rootId: "r", configs: [{ name: "private-secret" }] } },
          { id, type: "terminal.output", ok: true, result: { content: "wrong" }, payload: { rootId: "r", terminalId: "t", data: "fake" } },
          { id, ok: false, error: null }, { id, ok: false, error: { code: 1, message: "private-secret" } }
        ]) socket.receive(message);
      }
      await Promise.resolve();
      expect(settled).toBe(false); expect(events).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(5);
      expect(warn.mock.calls).toEqual(Array.from({ length: 5 }, () => ["[core-client] Ignoring invalid server message"]));
      const event = { type: "terminal.output", payload: { rootId: "root-primary", terminalId: "t", data: "valid" } };
      socket.receive(event);
      socket.receive({ id, ok: true, rootId: "root-primary", result: { content: "valid response" } });
      await expect(pending).resolves.toEqual({ content: "valid response" });
      expect(events).toHaveBeenCalledOnce(); expect(events).toHaveBeenCalledWith(event);
      expect(client.isConnected()).toBe(true);
    } finally { client.disconnect(); warn.mockRestore(); }
  });

  it("matches out-of-order responses and delivers events while another request is pending", async () => {
    const client = new CoreClient();
    const connecting = client.connect("core", 7331);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await connecting;
    const events = vi.fn();
    client.onServerEvent = events;
    let slowSettled = false;
    const slow = client.request("filesystem.readFile", { path: "slow.txt" }).then((result) => { slowSettled = true; return result; });
    const slowId = JSON.parse(socket.sent.at(-1)!).id;
    const fast = client.request("filesystem.readFile", { path: "fast.txt" });
    const fastId = JSON.parse(socket.sent.at(-1)!).id;
    const failing = client.request("filesystem.readFile", { path: "missing.txt" });
    const errorId = JSON.parse(socket.sent.at(-1)!).id;
    const failure = expect(failing).rejects.toThrow("FILE_NOT_FOUND: missing");
    socket.receive({ id: errorId, ok: false, error: { code: "FILE_NOT_FOUND", message: "missing" } });
    socket.receive({ id: fastId, ok: true, rootId: "root-primary", result: { content: "fast" } });
    const event = { type: "terminal.output", payload: { rootId: "root-primary", terminalId: "terminal-a", data: "output" } };
    socket.receive(event);
    await expect(fast).resolves.toEqual({ content: "fast" });
    await failure;
    expect(events).toHaveBeenCalledOnce();
    expect(events).toHaveBeenCalledWith(event);
    expect(slowSettled).toBe(false);
    socket.receive({ id: slowId, ok: true, rootId: "root-primary", result: { content: "slow" } });
    await expect(slow).resolves.toEqual({ content: "slow" });
    client.disconnect();
  });

  it("rejects every concurrent pending request on disconnect and ignores late responses", async () => {
    const client = new CoreClient();
    const connecting = client.connect("core", 7331);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await connecting;
    const first = client.request("filesystem.readFile", { path: "a" });
    const second = client.request("filesystem.readFile", { path: "b" });
    const rejections = [expect(first).rejects.toThrow("Connection closed"), expect(second).rejects.toThrow("Connection closed")];
    socket.close();
    await Promise.all(rejections);
    for (const data of socket.sent.slice(-2)) socket.receive({ id: JSON.parse(data).id, ok: true, result: { content: "late" } });
  });

  it("detects a silent browser transport, rejects obsolete mutations, and notifies once", async () => {
    vi.useFakeTimers();
    const client = new CoreClient(30_000, { intervalMs: 100, timeoutMs: 50 });
    try {
      const disconnected = vi.fn(); client.onDisconnected = disconnected;
      const connecting = client.connect("core", 7331);
      const socket = FakeWebSocket.instances[0]!; socket.open(); await connecting;
      // Browser readyState remains OPEN and close itself can stall without an event.
      socket.send = (data) => { socket.sent.push(data); };
      socket.close = vi.fn();
      const mutation = client.request("filesystem.writeFile", { path: "a", content: "changed" });
      const rejection = expect(mutation).rejects.toThrow("liveness check timed out");
      await vi.advanceTimersByTimeAsync(149);
      expect(disconnected).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(client.isConnected()).toBe(false);
      expect(disconnected).toHaveBeenCalledOnce();
      await expect(client.request("tasks.list", {})).rejects.toThrow("Not connected");
      socket.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(disconnected).toHaveBeenCalledOnce();
      expect(socket.sent.filter((data) => JSON.parse(data).type === "protocol.keepAlive")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { client.disconnect(); vi.useRealTimers(); }
  });

  it("keeps healthy idle sessions alive and clears probe timers on shutdown/replacement", async () => {
    vi.useFakeTimers();
    const client = new CoreClient(30_000, { intervalMs: 100, timeoutMs: 50 });
    try {
      const disconnected = vi.fn(); client.onDisconnected = disconnected;
      let connecting = client.connect("core", 7331);
      const old = FakeWebSocket.instances[0]!; old.open(); await connecting;
      await vi.advanceTimersByTimeAsync(500);
      expect(old.sent.filter((data) => JSON.parse(data).type === "protocol.keepAlive")).toHaveLength(5);
      expect(disconnected).not.toHaveBeenCalled();
      old.send = (data) => { old.sent.push(data); };
      await vi.advanceTimersByTimeAsync(100); // one outstanding probe
      connecting = client.connect("core", 7331);
      FakeWebSocket.instances[1]!.open(); await connecting;
      await vi.advanceTimersByTimeAsync(100);
      expect(disconnected).not.toHaveBeenCalled();
      client.disconnect();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(disconnected).not.toHaveBeenCalled();
    } finally { client.disconnect(); vi.useRealTimers(); }
  });

  it("validates finite positive liveness thresholds", () => {
    for (const value of [0, -1, Infinity, NaN, 2_147_483_648]) expect(() => new CoreClient(100, { intervalMs: value })).toThrow("Liveness thresholds");
  });

  it("rejects a missing remembered root rather than falling back to the primary workspace", async () => {
    const client = new CoreClient(); client.setRoot("root-missing");
    const connecting = client.connect("core", 7331);
    const rejection = expect(connecting).rejects.toThrow("Previously selected workspace root is unavailable");
    const socket = FakeWebSocket.instances[0]!; socket.open();
    await rejection;
    expect(client.getRoot()).toBe("root-missing");
    expect(client.isConnected()).toBe(false);
    expect(socket.sent.map((data) => JSON.parse(data).type)).toEqual(["protocol.handshake", "workspace.roots"]);
  });

  it("settles a connection cancelled before the socket opens", async () => {
    const client = new CoreClient();
    const connecting = client.connect("core", 7331);
    const rejection = expect(connecting).rejects.toThrow("Connection replaced or closed");
    client.disconnect();
    await rejection;
  });

  it("does not let a replaced handshake clear or use the new connection", async () => {
    const client = new CoreClient();
    const firstConnect = client.connect("core", 7331);
    const rejection = expect(firstConnect).rejects.toThrow("Connection replaced or closed");
    const first = FakeWebSocket.instances[0]!;
    first.open();
    // The handshake response has arrived, but its continuation has not run.
    const secondConnect = client.connect("core", 7331);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    await rejection;
    await secondConnect;
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
    expect(second.sent.map((data) => JSON.parse(data).type)).toEqual(["protocol.handshake", "workspace.roots"]);
    const pending = client.request("tasks.list", {});
    const request = JSON.parse(second.sent.at(-1)!);
    second.receive({ id: request.id, ok: true, result: { tasks: [] } });
    await expect(pending).resolves.toEqual({ tasks: [] });
    client.disconnect();
  });

  it("keeps the new socket usable when an outstanding old handshake rejects", async () => {
    const client = new CoreClient();
    const firstConnect = client.connect("core", 7331);
    const rejection = expect(firstConnect).rejects.toThrow("Connection replaced or closed");
    const first = FakeWebSocket.instances[0]!;
    first.send = (data) => { first.sent.push(data); };
    first.open();
    const secondConnect = client.connect("core", 7331);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    await rejection;
    await secondConnect;
    expect(second.readyState).toBe(FakeWebSocket.OPEN);
    const pending = client.request("tasks.list", {});
    second.receive({ id: JSON.parse(second.sent.at(-1)!).id, ok: true, result: { tasks: [] } });
    await expect(pending).resolves.toEqual({ tasks: [] });
    client.disconnect();
  });

  it("times out a socket that never opens", async () => {
    vi.useFakeTimers();
    try {
      const client = new CoreClient(1_000);
      const connecting = client.connect("core", 7331);
      const rejection = expect(connecting).rejects.toThrow("Connection timed out");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
      expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED);
    } finally { vi.useRealTimers(); }
  });

  it("ignores malformed messages without throwing or losing a pending request", async () => {
    const client = new CoreClient();
    const connecting = client.connect("core", 7331);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await connecting;
    const pending = client.request("tasks.list", {});
    const request = JSON.parse(socket.sent.at(-1)!);
    for (const value of [null, 42, true, "text", [], { id: request.id, ok: false }]) {
      expect(() => socket.receive(value)).not.toThrow();
    }
    socket.receive({ id: request.id, ok: true, result: { tasks: [] } });
    await expect(pending).resolves.toEqual({ tasks: [] });
    client.disconnect();
  });

  it("adds the selected root identity to every scoped request", async () => {
    const client = new CoreClient(); const connecting = client.connect("core", 7331); const socket = FakeWebSocket.instances[0]!; socket.open(); await connecting;
    const pending = client.request("filesystem.readFile", { path: "README.md" });
    const request = JSON.parse(socket.sent[2]!) as { id: string; rootId?: string; payload: unknown };
    expect(request).toMatchObject({ rootId: "root-primary", payload: { path: "README.md" } });
    socket.receive({ id: request.id, ok: true, result: { path: "README.md", content: "", revision: { identity: "a", version: "b" } } });
    await pending;
  });

  it("rejects a response carrying another root's identity", async () => {
    const client = new CoreClient(); const connecting = client.connect("core", 7331); const socket = FakeWebSocket.instances[0]!; socket.open(); await connecting;
    client.setRoot("root-api"); const pending = client.request("git.status", {}); const request = JSON.parse(socket.sent.at(-1)!) as { id: string };
    socket.receive({ id: request.id, ok: true, rootId: "root-primary", result: { branch: "main", entries: [] } });
    await expect(pending).rejects.toThrow("Stale cross-root response");
  });

  it("reselects the same stable root after reconnect", async () => {
    const client = new CoreClient(); let connecting = client.connect("core", 7331); let socket = FakeWebSocket.instances[0]!; socket.open(); await connecting;
    client.setRoot("root-api"); socket.close();
    connecting = client.connect("core", 7331); socket = FakeWebSocket.instances[1]!; socket.open(); await connecting;
    expect(client.getRoot()).toBe("root-api");
    expect(socket.sent.map((item) => JSON.parse(item)).find((item) => item.type === "workspace.selectRoot").payload).toEqual({ rootId: "root-api", preserveTaskSelection: true });
    client.disconnect();
  });

  it("rejects the interrupted send, reconnects, and restores the durable AI snapshot", async () => {
    const client = new CoreClient();
    const disconnected = vi.fn();
    client.onDisconnected = disconnected;
    const connecting = client.connect("core", 7331);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    await connecting;

    const streaming = client.request("ai.send", { prompt: "long response" });
    first.close();
    await expect(streaming).rejects.toThrow("Connection closed");
    expect(disconnected).toHaveBeenCalledOnce();

    const reconnecting = client.connect("core", 7331);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    await reconnecting;
    const restoring = client.request("ai.get", {});
    const request = JSON.parse(second.sent[2]!) as { id: string };
    let restored = false;
    void restoring.then(() => { restored = true; });
    first.receive({ id: request.id, ok: true, result: { session: { status: "done", messages: [] } } });
    await Promise.resolve();
    expect(restored).toBe(false);
    second.receive({ id: request.id, ok: true, result: { session: { model: "model-a", reasoning: "low", status: "in_progress", messages: [{ id: "answer", role: "assistant", text: "still streaming", timestamp: "now" }] } } });

    await expect(restoring).resolves.toMatchObject({ session: { status: "in_progress", messages: [{ text: "still streaming" }] } });
  });

  it("rejects requests belonging to a connection that is replaced before its close event", async () => {
    const client = new CoreClient();
    const firstConnect = client.connect("core", 7331);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    await firstConnect;
    const interrupted = client.request("tasks.list", {});

    const secondConnect = client.connect("core", 7331);
    FakeWebSocket.instances[1]!.open();
    await secondConnect;

    await expect(interrupted).rejects.toThrow("Connection replaced");
  });

  it("settles task-switch loading after loss and completes a switch on the reconnected socket", async () => {
    const client = new CoreClient();
    const connecting = client.connect("core", 7331);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    await connecting;
    let loading = true;
    const interrupted = client.request("tasks.switch", { taskId: "task-a", includeIgnored: false })
      .finally(() => { loading = false; });

    first.close();
    await expect(interrupted).rejects.toThrow("Connection closed");
    expect(loading).toBe(false);

    const reconnecting = client.connect("core", 7331);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    await reconnecting;
    loading = true;
    const switched = client.request("tasks.switch", { taskId: "task-b", includeIgnored: false })
      .finally(() => { loading = false; });
    const request = JSON.parse(second.sent[2]!) as { id: string };
    second.receive({ id: request.id, ok: true, result: { workspace: "/task-b", projectName: "project", tree: [], options: {}, tasks: [], selectedTaskId: "task-b" } });

    await expect(switched).resolves.toMatchObject({ selectedTaskId: "task-b" });
    expect(loading).toBe(false);
  });

  it("times out a request when a sleep-like half-open socket never answers or closes", async () => {
    vi.useFakeTimers();
    const client = new CoreClient(1_000);
    const connecting = client.connect("core", 7331);
    FakeWebSocket.instances[0]!.open();
    await connecting;
    const switching = client.request("tasks.switch", { taskId: "task-b", includeIgnored: false });
    let loading = true;
    const settled = switching.finally(() => { loading = false; });
    const rejection = expect(settled).rejects.toThrow("Request tasks.switch timed out after 1000ms");

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(loading).toBe(false);
    vi.useRealTimers();
  });
});

describe("CoreClient protocol handshake", () => {
  beforeEach(() => { FakeWebSocket.instances = []; vi.stubGlobal("WebSocket", FakeWebSocket); });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an incompatible Core before allowing requests", async () => {
    const client = new CoreClient();
    const connecting = client.connect("core", 7331);
    const socket = FakeWebSocket.instances[0]!;
    socket.send = (data: string) => {
      socket.sent.push(data);
      const request = JSON.parse(data) as { id: string; type: string };
      if (request.type === "protocol.handshake") socket.receive({ id: request.id, ok: true, result: { compatible: false, compatibility: { minimum: 2, maximum: 2 }, message: "Update required" } });
    };
    socket.open();
    await expect(connecting).rejects.toThrow("Update required");
    await expect(client.request("tasks.list", {})).rejects.toThrow("Not connected");
  });
});

describe("CoalescedAsyncAction", () => {
  it("bounds a burst to one in-flight refresh and one latest follow-up", async () => {
    let release!: () => void;
    let calls = 0;
    const action = new CoalescedAsyncAction(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    });

    action.trigger();
    await Promise.resolve();
    for (let index = 0; index < 100; index += 1) action.trigger();
    expect(calls).toBe(1);
    release();
    await action.whenIdle();
    expect(calls).toBe(2);
  });
});
