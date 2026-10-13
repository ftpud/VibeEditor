import { WebSocket } from "ws";

export type WebSocketOutboundOptions = {
  maxBufferedBytes?: number;
  maxCoalescedBytes?: number;
  maxCoalescedEvents?: number;
  drainIntervalMs?: number;
  maxCoalesceDelayMs?: number;
};

// One outstanding server heartbeat uses 38 bytes. Leave room for control traffic.
const CONTROL_RESERVE_BYTES = 64;
const REPLACEABLE = new Set(["git.changed", "taskGit.changed", "java.semantic.changed", "ai.changed", "tasks.changed", "timers.changed"]);
const outputs = new WeakMap<WebSocket, WebSocketOutput>();

export function websocketOutboundLimits(options: WebSocketOutboundOptions = {}) {
  const limits = {
    maxBufferedBytes: options.maxBufferedBytes ?? 16 * 1024 * 1024,
    maxCoalescedBytes: options.maxCoalescedBytes ?? 64 * 1024,
    maxCoalescedEvents: options.maxCoalescedEvents ?? 64,
    drainIntervalMs: options.drainIntervalMs ?? 25,
    maxCoalesceDelayMs: options.maxCoalesceDelayMs ?? 2_000
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  if (limits.maxBufferedBytes <= CONTROL_RESERVE_BYTES) throw new Error("maxBufferedBytes must exceed the 64-byte control reserve");
  if (limits.drainIntervalMs > limits.maxCoalesceDelayMs || limits.maxCoalesceDelayMs > 2_147_483_647) throw new Error("Invalid outbound drain/deadline timer range");
  return limits;
}

/** Install once per session; each peer owns its own budget, hints and timers. */
export function configureWebSocketOutput(socket: WebSocket, options: WebSocketOutboundOptions = {}): () => void {
  if (outputs.has(socket)) throw new Error("WebSocket output is already configured");
  const output = new WebSocketOutput(socket, websocketOutboundLimits(options));
  outputs.set(socket, output);
  return () => { output.dispose(); if (socket.readyState === WebSocket.OPEN) socket.terminate(); };
}

function outputFor(socket: WebSocket): WebSocketOutput {
  let output = outputs.get(socket);
  if (!output) { output = new WebSocketOutput(socket, websocketOutboundLimits()); outputs.set(socket, output); }
  return output;
}

/** True means accepted or retained as a replaceable hint, not delivery acknowledgement. */
export function sendWebSocketData(socket: WebSocket, data: string): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  return outputFor(socket).send(data);
}

/** Native clients can ping a slow connection; their pong replies share the budget. */
export function sendWebSocketPong(socket: WebSocket, data: Buffer): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  return outputFor(socket).pong(data);
}

class WebSocketOutput {
  private readonly pending = new Map<string, { data: string; bytes: number }>();
  private pendingBytes = 0;
  private inFlightBytes = 0;
  private disposed = false;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private readonly capacity: number;
  private readonly highWater: number;

  constructor(private readonly socket: WebSocket, private readonly limits: ReturnType<typeof websocketOutboundLimits>) {
    this.capacity = limits.maxBufferedBytes - CONTROL_RESERVE_BYTES;
    this.highWater = Math.floor(this.capacity * 0.75);
    socket.once("close", this.dispose);
  }

  private charged(): number { return Math.max(this.socket.bufferedAmount, this.inFlightBytes); }
  private frameBytes(data: string): number { return Buffer.byteLength(data, "utf8") + 10; }

  send(data: string): boolean {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) return false;
    const bytes = this.frameBytes(data);
    if (this.charged() > this.limits.maxBufferedBytes) return this.fail("WebSocket buffer already exceeds byte limit");
    if (bytes > this.capacity) return this.fail("Outbound message exceeds byte limit");
    if (this.charged() >= this.highWater || this.pending.size) {
      const key = this.replacementKey(data);
      if (key !== undefined) return this.retain(key, data);
    }
    return this.transmit(data, bytes);
  }

  pong(data: Buffer): boolean {
    if (this.disposed || this.socket.readyState !== WebSocket.OPEN) return false;
    return this.write(data.length + 10, (complete) => this.socket.pong(data, false, complete));
  }

  private replacementKey(data: string): string | undefined {
    // Only inspect Core-generated hints under pressure; never replace payload-bearing events.
    try {
      const event = JSON.parse(data) as { id?: unknown; type?: string; payload?: { rootId?: string } };
      if (!event || event.id !== undefined || !event.type || !REPLACEABLE.has(event.type)) return undefined;
      return `${event.type}\0${event.payload?.rootId ?? ""}`;
    } catch { return undefined; }
  }

  private retain(key: string, data: string): boolean {
    const previous = this.pending.get(key);
    const bytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(data, "utf8");
    const total = this.pendingBytes - (previous?.bytes ?? 0) + bytes;
    if ((!previous && this.pending.size >= this.limits.maxCoalescedEvents) || total > this.limits.maxCoalescedBytes) return this.fail("Outbound invalidation budget exceeded");
    this.pending.set(key, { data, bytes });
    this.pendingBytes = total;
    // Duplicates cannot extend a congested burst's lifetime indefinitely.
    this.deadlineTimer ??= setTimeout(() => this.fail("Outbound invalidations could not drain"), this.limits.maxCoalesceDelayMs);
    this.scheduleDrain();
    return true;
  }

  private scheduleDrain(): void {
    if (this.disposed || !this.pending.size || this.drainTimer) return;
    this.drainTimer = setTimeout(() => { this.drainTimer = undefined; this.drain(); }, this.limits.drainIntervalMs);
  }

  private drain(): void {
    if (this.disposed) return;
    if (this.socket.readyState !== WebSocket.OPEN) { this.dispose(); return; }
    for (const [key, item] of this.pending) {
      const bytes = this.frameBytes(item.data);
      if (this.charged() >= this.highWater || this.charged() + bytes > this.capacity) break;
      this.pending.delete(key); this.pendingBytes -= item.bytes;
      if (!this.transmit(item.data, bytes)) return;
    }
    if (!this.pending.size) {
      clearTimeout(this.deadlineTimer); this.deadlineTimer = undefined;
      clearTimeout(this.drainTimer); this.drainTimer = undefined;
    }
    else this.scheduleDrain();
  }

  private transmit(data: string, bytes: number): boolean {
    return this.write(bytes, (complete) => this.socket.send(data, complete));
  }

  private write(bytes: number, send: (complete: (error?: Error) => void) => void): boolean {
    if (this.charged() + bytes > this.capacity) return this.fail("Outbound buffered byte limit exceeded");
    this.inFlightBytes += bytes;
    let completed = false;
    const complete = (error?: Error) => {
      if (completed || this.disposed) return;
      completed = true;
      this.inFlightBytes -= bytes;
      if (error) this.fail("WebSocket send failed");
      else this.scheduleDrain();
    };
    try { send(complete); }
    catch { complete(new Error("WebSocket send threw")); }
    return !this.disposed;
  }

  private fail(reason: string): false {
    if (!this.disposed) {
      this.dispose();
      console.warn(`[core] disconnecting peer: ${reason}`);
      this.socket.terminate();
    }
    return false;
  }

  readonly dispose = (): void => {
    this.disposed = true;
    clearTimeout(this.drainTimer); clearTimeout(this.deadlineTimer);
    this.drainTimer = undefined; this.deadlineTimer = undefined;
    this.pending.clear(); this.pendingBytes = 0; this.inFlightBytes = 0;
    this.socket.off("close", this.dispose);
  };
}
