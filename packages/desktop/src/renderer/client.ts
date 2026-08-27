import type { ProtocolOperations, Request, RequestType, Response, ServerEvent } from "@remote-ide/protocol";

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class CoreClient {
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  onDisconnected?: (message: string) => void;
  onServerEvent?: (event: ServerEvent) => void;

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}:${port}`);
      this.socket = socket;
      let opened = false;
      socket.onopen = () => { if (this.socket === socket) { opened = true; resolve(); } };
      socket.onerror = () => { if (!opened && this.socket === socket) reject(new Error("Could not connect to the backend")); };
      socket.onmessage = (event) => { if (this.socket === socket) this.handleMessage(String(event.data)); };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        for (const item of this.pending.values()) item.reject(new Error("Connection closed"));
        this.pending.clear();
        if (opened) this.onDisconnected?.("Backend connection was closed");
        else reject(new Error("Could not connect to the backend"));
      };
    });
  }

  request<T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]): Promise<ProtocolOperations[T]["result"]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected"));
    const id = crypto.randomUUID();
    const request = { id, type, payload } as Request<T>;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try { this.socket!.send(JSON.stringify(request)); }
      catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Could not send request"));
      }
    });
  }

  disconnect(): void { const socket = this.socket; this.socket = undefined; socket?.close(); }

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
