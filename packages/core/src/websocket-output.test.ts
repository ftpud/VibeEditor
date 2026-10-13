import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { configureWebSocketOutput, sendWebSocketData, sendWebSocketPong, websocketOutboundLimits } from "./websocket-output.js";

class Peer extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  peakBytes = 0;
  sent: string[] = [];
  callbacks: Array<(error?: Error) => void> = [];
  terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.bufferedAmount = 0; this.emit("close"); });
  constructor(readonly immediate = false) { super(); }
  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    this.bufferedAmount += Buffer.byteLength(data) + 10;
    this.peakBytes = Math.max(this.peakBytes, this.bufferedAmount);
    if (this.immediate) { this.bufferedAmount = 0; callback(); }
    else this.callbacks.push(callback);
  }
  pong(data: Buffer, _mask: boolean, callback: (error?: Error) => void): void { this.send(data.toString(), callback); }
  drain(error?: Error): void { this.bufferedAmount = 0; for (const callback of this.callbacks.splice(0)) callback(error); }
  socket(): WebSocket { return this as unknown as WebSocket; }
}
const hint = (type: string, rootId = "root-a", sequence?: number) => JSON.stringify({ type, payload: { rootId }, ...(sequence === undefined ? {} : { sequence }) });

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded WebSocket output", () => {
  it("validates configurable byte, key and timer limits", () => {
    for (const value of [0, -1, NaN, Infinity, 1.5]) expect(() => websocketOutboundLimits({ maxBufferedBytes: value })).toThrow();
    expect(() => websocketOutboundLimits({ maxBufferedBytes: 64 })).toThrow("control reserve");
    expect(() => websocketOutboundLimits({ maxCoalescedEvents: 0 })).toThrow();
    expect(() => websocketOutboundLimits({ maxCoalescedBytes: 0 })).toThrow();
    expect(() => websocketOutboundLimits({ drainIntervalMs: 30, maxCoalesceDelayMs: 20 })).toThrow();
  });

  it("bounds a non-draining peer's writes and does not delay a healthy peer", () => {
    const slow = new Peer(); const healthy = new Peer(true);
    configureWebSocketOutput(slow.socket(), { maxBufferedBytes: 512 });
    configureWebSocketOutput(healthy.socket(), { maxBufferedBytes: 512 });
    for (let index = 0; index < 100; index++) {
      const response = JSON.stringify({ id: String(index), ok: true, result: { content: "x".repeat(50) } });
      sendWebSocketData(slow.socket(), response);
      expect(sendWebSocketData(healthy.socket(), response)).toBe(true);
    }
    expect(slow.peakBytes).toBeLessThanOrEqual(512 - 64);
    expect(slow.terminate).toHaveBeenCalledOnce();
    expect(healthy.sent).toHaveLength(100);
    expect(healthy.sent.map((data) => JSON.parse(data).id)).toEqual(Array.from({ length: 100 }, (_, index) => String(index)));
    expect(healthy.terminate).not.toHaveBeenCalled();
  });

  it("charges unfinished send callbacks even if bufferedAmount temporarily reads zero", () => {
    const slow = new Peer(); configureWebSocketOutput(slow.socket(), { maxBufferedBytes: 512 });
    for (let index = 0; index < 100; index++) { slow.bufferedAmount = 0; sendWebSocketData(slow.socket(), "x".repeat(100)); }
    expect(slow.sent).toHaveLength(4);
    expect(slow.terminate).toHaveBeenCalledOnce();
    slow.drain(); // Late callbacks after abort must not revive the sender.
    expect(sendWebSocketData(slow.socket(), "late")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces only snapshot hints by type and root, then drains latest data", async () => {
    const peer = new Peer(true); configureWebSocketOutput(peer.socket(), { maxBufferedBytes: 512 });
    peer.bufferedAmount = 350;
    for (let index = 0; index < 10_000; index++) expect(sendWebSocketData(peer.socket(), hint("ai.changed", "root-a", index))).toBe(true);
    sendWebSocketData(peer.socket(), hint("ai.changed", "root-b"));
    sendWebSocketData(peer.socket(), hint("git.changed", "root-a"));
    expect(peer.sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(2);
    peer.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(25);
    expect(peer.sent.map((data) => JSON.parse(data))).toEqual([
      { type: "ai.changed", payload: { rootId: "root-a" }, sequence: 9999 },
      { type: "ai.changed", payload: { rootId: "root-b" } },
      { type: "git.changed", payload: { rootId: "root-a" } }
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(peer.terminate).not.toHaveBeenCalled();
  });

  it("does not hold heartbeat responses behind coalesced hints", () => {
    const peer = new Peer(); configureWebSocketOutput(peer.socket(), { maxBufferedBytes: 512 });
    peer.bufferedAmount = 350;
    sendWebSocketData(peer.socket(), hint("tasks.changed"));
    const response = JSON.stringify({ id: "probe", ok: true, result: {} });
    expect(sendWebSocketData(peer.socket(), response)).toBe(true);
    expect(peer.sent).toEqual([response]);
    peer.terminate();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps coalesced bytes and keys and cannot postpone congestion timeout with duplicates", async () => {
    for (const limits of [{ maxCoalescedEvents: 1 }, { maxCoalescedBytes: 100 }]) {
      const peer = new Peer(); configureWebSocketOutput(peer.socket(), { maxBufferedBytes: 512, ...limits });
      peer.bufferedAmount = 350;
      expect(sendWebSocketData(peer.socket(), hint("git.changed", "a"))).toBe(true);
      expect(sendWebSocketData(peer.socket(), hint("git.changed", "b"))).toBe(false);
      expect(peer.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
    const peer = new Peer(); configureWebSocketOutput(peer.socket(), { maxBufferedBytes: 512, drainIntervalMs: 10, maxCoalesceDelayMs: 100 });
    peer.bufferedAmount = 350;
    sendWebSocketData(peer.socket(), hint("git.changed"));
    await vi.advanceTimersByTimeAsync(50);
    sendWebSocketData(peer.socket(), hint("git.changed"));
    await vi.advanceTimersByTimeAsync(50);
    expect(peer.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never coalesces required payloads or correlated responses", () => {
    for (const type of ["terminal.output", "terminal.exit", "java.output", "workflow.document", "runConfig.changed", "configuration.changed", "processes.changed", "commit-message.changed"]) {
      const peer = new Peer(); configureWebSocketOutput(peer.socket(), { maxBufferedBytes: 512 });
      peer.bufferedAmount = 440;
      expect(sendWebSocketData(peer.socket(), JSON.stringify({ type, payload: { rootId: "root-a", data: "stream fragment" } }))).toBe(false);
      expect(peer.sent).toEqual([]);
      expect(peer.terminate).toHaveBeenCalledOnce();
    }
    const peer = new Peer(); configureWebSocketOutput(peer.socket(), { maxBufferedBytes: 512 }); peer.bufferedAmount = 440;
    expect(sendWebSocketData(peer.socket(), JSON.stringify({ id: "request", type: "ai.changed", ok: true, result: {} }))).toBe(false);
    expect(peer.terminate).toHaveBeenCalledOnce();
  });

  it("bounds native pong replies and preserves a healthy peer's ping payload", () => {
    const slow = new Peer(); const healthy = new Peer(true);
    configureWebSocketOutput(slow.socket(), { maxBufferedBytes: 512 });
    configureWebSocketOutput(healthy.socket(), { maxBufferedBytes: 512 });
    for (let index = 0; index < 100; index++) {
      sendWebSocketPong(slow.socket(), Buffer.from("p".repeat(100)));
      expect(sendWebSocketPong(healthy.socket(), Buffer.from(String(index)))).toBe(true);
    }
    expect(slow.peakBytes).toBeLessThanOrEqual(512 - 64);
    expect(slow.terminate).toHaveBeenCalledOnce();
    expect(healthy.sent).toEqual(Array.from({ length: 100 }, (_, index) => String(index)));
  });

  it("handles synchronous and async send errors and closes exactly once", () => {
    const thrown = new Peer(); configureWebSocketOutput(thrown.socket());
    thrown.send = () => { throw new Error("send race"); };
    expect(sendWebSocketData(thrown.socket(), "response")).toBe(false);
    expect(thrown.terminate).toHaveBeenCalledOnce();
    const async = new Peer(); configureWebSocketOutput(async.socket());
    expect(sendWebSocketData(async.socket(), "response")).toBe(true);
    expect(sendWebSocketData(async.socket(), "terminal chunk")).toBe(true);
    async.drain(new Error("asynchronous socket error"));
    expect(async.terminate).toHaveBeenCalledOnce();
    expect(sendWebSocketData(async.socket(), "later response")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases queued state and timers on explicit disposal or peer close", () => {
    for (const close of [true, false]) {
      const peer = new Peer(); const dispose = configureWebSocketOutput(peer.socket(), { maxBufferedBytes: 512 });
      peer.bufferedAmount = 350;
      sendWebSocketData(peer.socket(), hint("ai.changed"));
      if (close) peer.terminate(); else dispose();
      expect(vi.getTimerCount()).toBe(0);
      peer.bufferedAmount = 0;
      expect(sendWebSocketData(peer.socket(), "late")).toBe(false);
      expect(peer.sent).toEqual([]);
    }
  });
});
