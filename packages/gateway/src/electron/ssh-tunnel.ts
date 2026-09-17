import { createServer, type Server, type Socket } from "node:net";
import type { Client, ClientChannel } from "ssh2";

export type SshTunnelStatus = "connecting" | "running" | "reconnecting";

export type SshTunnelOptions = {
  localPort: number;
  remotePort: number;
  connect: () => Promise<Client>;
  reconnectDelayMs?: number;
  onStatus?: (status: SshTunnelStatus, localPort: number, error?: Error) => void;
};

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Owns the local listening socket separately from the SSH transport. This lets
 * clients keep using the same local port while a transport lost during sleep is
 * replaced in the background.
 */
export class SshTunnel {
  private readonly reconnectDelayMs: number;
  private server?: Server;
  private ssh?: Client;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private attempt = 0;
  private boundPort = 0;

  constructor(private readonly options: SshTunnelOptions) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  }

  get localPort(): number { return this.boundPort; }

  async start(): Promise<number> {
    this.stopped = false;
    this.options.onStatus?.("connecting", this.options.localPort);
    await this.connectTransport(true);

    const server = createServer((socket) => this.forward(socket));
    this.server = server;
    server.on("error", (error) => {
      // A persistent listener prevents later network errors from escaping to
      // Electron as an uncaught exception. Listen failures are handled below.
      if (!this.stopped) this.options.onStatus?.("reconnecting", this.boundPort || this.options.localPort, error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.options.localPort, "127.0.0.1");
      });
    } catch (error) {
      this.stop();
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      this.stop();
      throw new Error("Could not allocate local tunnel port");
    }
    this.boundPort = address.port;
    this.options.onStatus?.("running", this.boundPort);
    return this.boundPort;
  }

  /** Force a fresh transport, for example after the OS reports resume. */
  reconnect(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    const previous = this.ssh;
    this.ssh = undefined;
    this.attempt += 1;
    previous?.end();
    this.options.onStatus?.("reconnecting", this.boundPort || this.options.localPort);
    void this.connectTransport(false);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.attempt += 1;
    this.clearReconnectTimer();
    const server = this.server;
    const ssh = this.ssh;
    this.server = undefined;
    this.ssh = undefined;
    server?.close();
    ssh?.end();
  }

  private async connectTransport(initial: boolean): Promise<void> {
    const attempt = ++this.attempt;
    try {
      const ssh = await this.options.connect();
      if (this.stopped || attempt !== this.attempt) { ssh.end(); return; }

      const failed = (reason?: unknown) => this.transportFailed(ssh, reason);
      ssh.on("error", failed);
      ssh.once("close", failed);
      this.ssh = ssh;
      if (this.boundPort) this.options.onStatus?.("running", this.boundPort);
    } catch (error) {
      if (this.stopped || attempt !== this.attempt) return;
      if (initial) throw error;
      this.options.onStatus?.("reconnecting", this.boundPort || this.options.localPort, asError(error));
      this.scheduleReconnect();
    }
  }

  private transportFailed(ssh: Client, reason?: unknown): void {
    if (this.stopped || this.ssh !== ssh) return;
    this.ssh = undefined;
    ssh.end();
    this.options.onStatus?.("reconnecting", this.boundPort || this.options.localPort, reason === undefined ? undefined : asError(reason));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectTransport(false);
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private forward(socket: Socket): void {
    const ssh = this.ssh;
    if (!ssh) { socket.destroy(); return; }
    socket.on("error", () => socket.destroy());
    ssh.forwardOut("127.0.0.1", socket.remotePort ?? 0, "127.0.0.1", this.options.remotePort, (error, stream) => {
      if (error) { socket.destroy(); return; }
      this.pipe(socket, stream);
    });
  }

  private pipe(socket: Socket, stream: ClientChannel): void {
    const closeSocket = () => socket.destroy();
    const closeStream = () => stream.destroy();
    socket.on("error", closeStream);
    stream.on("error", closeSocket);
    socket.pipe(stream).pipe(socket);
  }
}
