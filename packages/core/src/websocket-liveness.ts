import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export type WebSocketLivenessOptions = { intervalMs?: number; timeoutMs?: number };

export function websocketLivenessThresholds(options: WebSocketLivenessOptions) {
  const intervalMs = options.intervalMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  for (const value of [intervalMs, timeoutMs]) {
    if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error("Liveness thresholds must be positive timer milliseconds");
  }
  return { intervalMs, timeoutMs };
}

/** Browsers automatically pong server pings, even though their JS API cannot send pings. */
export function monitorWebSocket(socket: WebSocket, options: WebSocketLivenessOptions = {}): () => void {
  const { intervalMs, timeoutMs } = websocketLivenessThresholds(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expected: string | undefined;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    socket.off("pong", pong);
    socket.off("close", dispose);
  };
  const lost = () => { dispose(); socket.terminate(); };
  const schedule = () => { timer = setTimeout(probe, intervalMs); };
  const pong = (data: Buffer) => {
    if (disposed || expected === undefined || data.toString() !== expected) return;
    expected = undefined;
    clearTimeout(timer);
    schedule();
  };
  const probe = () => {
    if (disposed) return;
    if (socket.readyState !== WebSocket.OPEN) { dispose(); return; }
    expected = randomUUID();
    timer = setTimeout(lost, timeoutMs);
    try { socket.ping(expected, false, (error?: Error) => { if (error && !disposed) lost(); }); }
    catch { lost(); }
  };
  socket.on("pong", pong);
  socket.once("close", dispose);
  schedule();
  return dispose;
}
