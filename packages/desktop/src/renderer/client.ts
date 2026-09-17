import { protocolCompatibility, type ProtocolOperations, type Request, type RequestType, type Response, type ServerEvent } from "@remote-ide/protocol";

type Pending = { socket: WebSocket; rootId?: string; timer: ReturnType<typeof setTimeout>; resolve(value: unknown): void; reject(error: Error): void };

export class CoreClient {
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  onDisconnected?: (message: string) => void;
  onServerEvent?: (event: ServerEvent) => void;
  private rootId?: string;
  private cancelConnect?: (error: Error) => void;

  constructor(private readonly requestTimeoutMs = 30_000) {}
  setRoot(rootId: string): void { this.rootId = rootId; }
  getRoot(): string | undefined { return this.rootId; }

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
      const socket = new WebSocket(`ws://${host}:${port}`);
      this.disconnect();
      this.socket = socket;
      let opened = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelConnect === cancel) this.cancelConnect = undefined;
        if (error) reject(error);
        else resolve();
      };
      const cancel = (error: Error) => finish(error);
      const fail = (error: Error) => {
        if (this.socket === socket) this.socket = undefined;
        this.rejectPendingFor(socket, error);
        finish(error);
        socket.close();
      };
      const timer = setTimeout(() => fail(new Error(`Connection timed out after ${this.requestTimeoutMs}ms`)), this.requestTimeoutMs);
      this.cancelConnect = cancel;
      const ensureCurrent = () => {
        if (this.socket !== socket) throw new Error("Connection replaced or closed");
      };
      socket.onopen = () => {
        if (this.socket !== socket) return;
        opened = true;
        void (async () => {
          const result = await this.request("protocol.handshake", { compatibility: protocolCompatibility, clientVersion: "0.1.0" });
          ensureCurrent();
          if (!result.compatible) throw new Error(result.message ?? "Desktop and Core protocol versions are incompatible");
          const roots = await this.request("workspace.roots", {});
          ensureCurrent();
          const desired = this.rootId && roots.roots.some((root) => root.id === this.rootId) ? this.rootId : roots.selectedRootId;
          this.rootId = desired;
          if (desired !== roots.selectedRootId) await this.request("workspace.selectRoot", { rootId: desired });
          ensureCurrent();
          finish();
        })().catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error("Could not negotiate a compatible protocol"));
        });
      };
      socket.onerror = () => { if (!opened && this.socket === socket) fail(new Error("Could not connect to the backend")); };
      socket.onmessage = (event) => { if (this.socket === socket) this.handleMessage(String(event.data)); };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.rejectPendingFor(socket, new Error("Connection closed"));
        finish(new Error(opened ? "Connection closed" : "Could not connect to the backend"));
        if (opened) this.onDisconnected?.("Backend connection was closed");
      };
    });
  }

  request<T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]): Promise<ProtocolOperations[T]["result"]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected"));
    const id = crypto.randomUUID();
    const socket = this.socket;
    const unscoped = type === "protocol.handshake" || type === "workspace.roots" || type === "workspace.addRoot";
    if (!unscoped && !this.rootId) return Promise.reject(new Error(`No workspace root selected for ${type}`));
    const request = { id, type, payload, ...(!unscoped ? { rootId: this.rootId } : {}) } as Request<T>;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item || item.socket !== socket) return;
        this.pending.delete(id);
        reject(new Error(`Request ${type} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { socket, rootId: unscoped ? undefined : this.rootId, timer, resolve: resolve as (value: unknown) => void, reject });
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
    this.cancelConnect?.(new Error("Connection replaced or closed"));
    if (socket) this.rejectPendingFor(socket, new Error("Connection replaced or closed"));
    socket?.close();
  }

  private handleMessage(data: string): void {
    let message: Response | ServerEvent;
    try { message = JSON.parse(data) as Response | ServerEvent; } catch { return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if ("type" in message) {
      this.onServerEvent?.(message);
      return;
    }
    const response = message;
    if (typeof response.id !== "string" || typeof response.ok !== "boolean") return;
    if (!response.ok && (!response.error || typeof response.error.code !== "string" || typeof response.error.message !== "string")) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok && pending.rootId && response.rootId && response.rootId !== pending.rootId) pending.reject(new Error(`Stale cross-root response: expected ${pending.rootId}, received ${response.rootId}`));
    else if (response.ok) pending.resolve(response.result);
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
