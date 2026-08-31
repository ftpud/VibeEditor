import { protocolCompatibility, type ProtocolOperations, type Request, type RequestType, type Response, type ServerEvent } from "@remote-ide/protocol";

type Pending = { socket: WebSocket; timer: ReturnType<typeof setTimeout>; resolve(value: unknown): void; reject(error: Error): void };

export class CoreClient {
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  onDisconnected?: (message: string) => void;
  onServerEvent?: (event: ServerEvent) => void;

  constructor(private readonly requestTimeoutMs = 30_000) {}

  private rejectPendingFor(socket: WebSocket, error: Error): void {
    for (const [id, item] of this.pending) {
      if (item.socket !== socket) continue;
      clearTimeout(item.timer);
      this.pending.delete(id);
      item.reject(error);
    }
  }

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const previous = this.socket;
      const socket = new WebSocket(`ws://${host}:${port}`);
      this.socket = socket;
      if (previous) {
        this.rejectPendingFor(previous, new Error("Connection replaced while request was pending"));
        previous.close();
      }
      let opened = false;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        opened = true;
        this.request("protocol.handshake", { compatibility: protocolCompatibility, clientVersion: "0.1.0" }).then((result) => {
          if (!result.compatible) throw new Error(result.message ?? "Desktop and Core protocol versions are incompatible");
          resolve();
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Could not negotiate a compatible protocol";
          this.socket = undefined;
          socket.close();
          reject(new Error(message));
        });
      };
      socket.onerror = () => { if (!opened && this.socket === socket) reject(new Error("Could not connect to the backend")); };
      socket.onmessage = (event) => { if (this.socket === socket) this.handleMessage(String(event.data)); };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.rejectPendingFor(socket, new Error("Connection closed"));
        if (opened) this.onDisconnected?.("Backend connection was closed");
        else reject(new Error("Could not connect to the backend"));
      };
    });
  }

  request<T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]): Promise<ProtocolOperations[T]["result"]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected"));
    const id = crypto.randomUUID();
    const socket = this.socket;
    const request = { id, type, payload } as Request<T>;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item || item.socket !== socket) return;
        this.pending.delete(id);
        reject(new Error(`Request ${type} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { socket, timer, resolve: resolve as (value: unknown) => void, reject });
      try { socket.send(JSON.stringify(request)); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Could not send request"));
      }
    });
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) this.rejectPendingFor(socket, new Error("Connection closed"));
    socket?.close();
  }

  private handleMessage(data: string): void {
    let message: Response | ServerEvent;
    try { message = JSON.parse(data) as Response | ServerEvent; } catch { return; }
    if ("type" in message) {
      this.onServerEvent?.(message);
      return;
    }
    const response = message;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
  }
}

/** Runs at most one refresh at a time and retains one latest follow-up. */
export class CoalescedAsyncAction {
  private running = false;
  private queued = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly action: () => Promise<void>) {}

  trigger(): void {
    this.queued = true;
    if (!this.running) void this.drain();
  }

  whenIdle(): Promise<void> {
    if (!this.running && !this.queued) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queued) {
        this.queued = false;
        try { await this.action(); } catch { /* refresh failures are retried by a later event or reconnect */ }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
