import type { ProtocolOperations, Request, RequestType, Response } from "@remote-ide/protocol";

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class CoreClient {
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  onDisconnected?: (message: string) => void;

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}:${port}`);
      this.socket = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("Could not connect to the backend"));
      socket.onmessage = (event) => this.handleMessage(String(event.data));
      socket.onclose = () => {
        for (const item of this.pending.values()) item.reject(new Error("Connection closed"));
        this.pending.clear();
        this.onDisconnected?.("Backend connection was closed");
      };
    });
  }

  request<T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]): Promise<ProtocolOperations[T]["result"]> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected"));
    const id = crypto.randomUUID();
    const request = { id, type, payload } as Request<T>;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket!.send(JSON.stringify(request));
    });
  }

  disconnect(): void { this.socket?.close(); this.socket = undefined; }

  private handleMessage(data: string): void {
    let response: Response;
    try { response = JSON.parse(data) as Response; } catch { return; }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
  }
}
