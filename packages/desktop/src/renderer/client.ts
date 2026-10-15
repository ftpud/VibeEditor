import { isServerEvent, protocolCompatibility, type ProtocolOperations, type Request, type RequestType, type Response, type ServerEvent } from "@remote-ide/protocol";

type Pending = { socket: WebSocket; rootId?: string; timer: ReturnType<typeof setTimeout>; resolve(value: unknown): void; reject(error: Error): void };

export type LivenessOptions = { intervalMs?: number; timeoutMs?: number };

export class CoreClient {
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  onConnectionProgress?: (message: string) => void;
  onDisconnected?: (message: string) => void;
  onServerEvent?: (event: ServerEvent) => void;
  private rootId?: string;
  private invalidMessageDiagnostics = 0;
  private cancelConnect?: (error: Error) => void;

  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  constructor(private readonly requestTimeoutMs = 30_000, liveness: LivenessOptions = {}) {
    this.heartbeatIntervalMs = liveness.intervalMs ?? 10_000;
    this.heartbeatTimeoutMs = liveness.timeoutMs ?? 10_000;
    for (const value of [this.heartbeatIntervalMs, this.heartbeatTimeoutMs]) {
      if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error("Liveness thresholds must be positive finite milliseconds");
    }
  }
  isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  private stopHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private startHeartbeat(socket: WebSocket, lost: () => void): void {
    const schedule = () => {
      if (this.socket !== socket) return;
      this.heartbeatTimer = setTimeout(() => {
        this.heartbeatTimer = undefined;
        if (this.socket !== socket) return;
        // Browsers cannot send WebSocket ping frames. Keep one application probe in flight.
        void this.request("protocol.keepAlive", {}, { timeoutMs: this.heartbeatTimeoutMs })
          .then(schedule, () => { if (this.socket === socket) lost(); });
      }, this.heartbeatIntervalMs);
    };
    schedule();
  }
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
      this.onConnectionProgress?.(`Opening connection to ${host}:${port}…`);
      const socket = new WebSocket(`ws://${host}:${port}`);
      this.disconnect();
      this.socket = socket;
      let opened = false;
      let negotiated = false;
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
        if (this.socket === socket) { this.socket = undefined; this.stopHeartbeat(); }
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
          this.onConnectionProgress?.("Checking Desktop and Core compatibility…");
          const token = typeof window !== "undefined" && window.desktop?.connectionToken ? await window.desktop.connectionToken(host, port) : undefined;
          ensureCurrent();
          const result = await this.request("protocol.handshake", { compatibility: protocolCompatibility, clientVersion: "0.1.0", ...(token ? { token } : {}) });
          ensureCurrent();
          if (!result.compatible) throw new Error(result.message ?? "Desktop and Core protocol versions are incompatible");
          this.onConnectionProgress?.("Finding workspace roots…");
          const roots = await this.request("workspace.roots", {});
          ensureCurrent();
          if (this.rootId && !roots.roots.some((root) => root.id === this.rootId)) throw new Error(`Previously selected workspace root is unavailable: ${this.rootId}`);
          const desired = this.rootId ?? roots.selectedRootId;
          this.rootId = desired;
          if (desired !== roots.selectedRootId) await this.request("workspace.selectRoot", { rootId: desired, preserveTaskSelection: true });
          ensureCurrent();
          negotiated = true;
          finish();
          this.startHeartbeat(socket, () => lost("Backend liveness check timed out"));
        })().catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error("Could not negotiate a compatible protocol"));
        });
      };
      socket.onerror = () => { if (!opened && this.socket === socket) fail(new Error("Could not connect to the backend")); };
      socket.onmessage = (event) => { if (this.socket === socket) this.handleMessage(String(event.data)); };
      const lost = (message: string) => {
        if (this.socket !== socket) return;
        // Detach before close: browser close may never complete on a silently lost transport.
        this.socket = undefined;
        this.stopHeartbeat();
        this.rejectPendingFor(socket, new Error(message));
        finish(new Error(opened ? message : "Could not connect to the backend"));
        socket.close();
        if (negotiated) this.onDisconnected?.(message);
      };
      socket.onclose = () => lost("Connection closed");
    });
  }

  request<T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"], options?: { timeoutMs?: number }): Promise<ProtocolOperations[T]["result"]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected"));
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const id = crypto.randomUUID();
    const socket = this.socket;
    const unscoped = type === "protocol.handshake" || type === "protocol.keepAlive" || type === "workspace.roots" || type === "workspace.addRoot";
    if (!unscoped && !this.rootId) return Promise.reject(new Error(`No workspace root selected for ${type}`));
    const request = { id, type, payload, ...(!unscoped ? { rootId: this.rootId } : {}) } as Request<T>;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item || item.socket !== socket) return;
        this.pending.delete(id);
        reject(new Error(`Request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
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
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    this.cancelConnect?.(new Error("Connection replaced or closed"));
    if (socket) this.rejectPendingFor(socket, new Error("Connection replaced or closed"));
    socket?.close();
  }

  private invalidMessage(): void {
    // A lifetime cap prevents a noisy peer/reconnect cycle from flooding diagnostics.
    if (this.invalidMessageDiagnostics >= 5) return;
    this.invalidMessageDiagnostics++;
    console.warn("[core-client] Ignoring invalid server message");
  }

  private handleMessage(data: string): void {
    let message: unknown;
    try { message = JSON.parse(data); } catch { this.invalidMessage(); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) { this.invalidMessage(); return; }
    if ("type" in message) {
      if (isServerEvent(message)) this.onServerEvent?.(message);
      else this.invalidMessage();
      return;
    }
    const envelope = message as Record<string, unknown>;
    if (typeof envelope.id !== "string" || typeof envelope.ok !== "boolean") { this.invalidMessage(); return; }
    if (!envelope.ok) {
      const error = envelope.error;
      if (!error || typeof error !== "object" || Array.isArray(error) || !("code" in error) || typeof error.code !== "string" || !("message" in error) || typeof error.message !== "string") { this.invalidMessage(); return; }
    }
    const response = message as Response;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok && pending.rootId && response.rootId && response.rootId !== pending.rootId) pending.reject(new Error(`Stale cross-root response: expected ${pending.rootId}, received ${response.rootId}`));
    else if (response.ok) pending.resolve(response.result);
    else pending.reject(Object.assign(new Error(`${response.error.code}: ${response.error.message}`), { code: response.error.code }));
  }
}

/** Runs at most one refresh at a time and retains one latest follow-up. */
export class CoalescedAsyncAction {
  private running = false;
  private queued = false;
  private disposed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly action: (canApply: () => boolean) => Promise<void>) {}

  dispose(): void { this.disposed = true; this.queued = false; }

  trigger(): void {
    if (this.disposed) return;
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
        try { await this.action(() => !this.disposed); } catch { /* refresh failures are retried by a later event or reconnect */ }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
