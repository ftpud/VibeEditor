import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescedAsyncAction, CoreClient } from "./client";

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
  send(data: string): void { if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket closed"); this.sent.push(data); }
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
    const request = JSON.parse(second.sent[0]!) as { id: string };
    let restored = false;
    void restoring.then(() => { restored = true; });
    first.receive({ id: request.id, ok: true, result: { session: { status: "done", messages: [] } } });
    await Promise.resolve();
    expect(restored).toBe(false);
    second.receive({ id: request.id, ok: true, result: { session: { model: "model-a", reasoning: "low", status: "in_progress", messages: [{ id: "answer", role: "assistant", text: "still streaming", timestamp: "now" }] } } });

    await expect(restoring).resolves.toMatchObject({ session: { status: "in_progress", messages: [{ text: "still streaming" }] } });
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
