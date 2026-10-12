import { EventEmitter, once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { monitorWebSocket, websocketLivenessThresholds } from "./websocket-liveness.js";

afterEach(() => vi.useRealTimers());

function peer() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { readyState: WebSocket.OPEN, ping: vi.fn(), terminate: vi.fn(() => emitter.emit("close")) });
}

it("rejects invalid thresholds before creating a monitor", () => {
  for (const value of [0, -1, NaN, Infinity, 2_147_483_648]) {
    expect(() => websocketLivenessThresholds({ intervalMs: value })).toThrow("Liveness thresholds");
    expect(() => websocketLivenessThresholds({ timeoutMs: value })).toThrow("Liveness thresholds");
  }
});

it("terminates a silent peer at the deadline and cleans up its timers/listeners", async () => {
  vi.useFakeTimers();
  const socket = peer(); monitorWebSocket(socket as unknown as WebSocket, { intervalMs: 100, timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(100);
  expect(socket.ping).toHaveBeenCalledOnce();
  socket.emit("pong", Buffer.from("unrelated"));
  await vi.advanceTimersByTimeAsync(49);
  expect(socket.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(socket.terminate).toHaveBeenCalledOnce();
  expect(socket.listenerCount("pong")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps healthy idle peers alive and stops monitoring on shutdown", async () => {
  vi.useFakeTimers();
  const socket = peer();
  socket.ping.mockImplementation((data: string) => socket.emit("pong", Buffer.from(data)));
  const dispose = monitorWebSocket(socket as unknown as WebSocket, { intervalMs: 100, timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(500);
  expect(socket.ping).toHaveBeenCalledTimes(5);
  expect(socket.terminate).not.toHaveBeenCalled();
  dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(socket.listenerCount("pong")).toBe(0);
});

it("cleans a pending pong deadline on close and handles ping failure", async () => {
  vi.useFakeTimers();
  const socket = peer(); monitorWebSocket(socket as unknown as WebSocket, { intervalMs: 100, timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(100);
  socket.emit("close");
  expect(vi.getTimerCount()).toBe(0);
  const failed = peer(); failed.ping.mockImplementation(() => { throw new Error("closed"); });
  monitorWebSocket(failed as unknown as WebSocket, { intervalMs: 100, timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(100);
  expect(failed.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.runIf(typeof globalThis.WebSocket === "function")("accepts automatic pongs from the native browser-compatible WebSocket API", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  let dispose: (() => void) | undefined;
  let pongs = 0;
  server.on("connection", (socket) => {
    socket.on("pong", () => { pongs += 1; });
    dispose = monitorWebSocket(socket, { intervalMs: 20, timeoutMs: 100 });
  });
  const browser = new globalThis.WebSocket(`ws://127.0.0.1:${address.port}`);
  try {
    expect("ping" in browser).toBe(false);
    await vi.waitFor(() => expect(pongs).toBeGreaterThanOrEqual(3));
    expect(browser.readyState).toBe(globalThis.WebSocket.OPEN);
  } finally {
    dispose?.(); browser.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
