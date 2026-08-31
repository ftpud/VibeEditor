import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { protocolCompatibility } from "@remote-ide/protocol";
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
    const request = JSON.parse(second.sent[1]!) as { id: string };
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
    const request = JSON.parse(second.sent[1]!) as { id: string };
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
