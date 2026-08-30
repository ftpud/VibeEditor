type GatewayConnection = { id: string; name: string; host: string; port: number; username: string };
type GatewayWorkspace = { id: string; connectionId: string; name: string; directory: string; remotePort: number };
type GatewayPortTunnel = { id: string; connectionId: string; port: number };
type GatewayState = { connections: GatewayConnection[]; workspaces: GatewayWorkspace[]; portTunnels: GatewayPortTunnel[] };
type GatewayRuntime = { status: "idle" | "working" | "server" | "client" | "error"; message: string };
type GatewayTunnelRuntime = { status: "idle" | "working" | "running" | "error"; message: string };
type GatewayConnectionRuntime = { status: "unknown" | "reconnecting" | "online" | "slow" | "offline"; message: string; latencyMs?: number };

interface Window {
  gateway: {
    get(): Promise<{ state: GatewayState; runtimes: Record<string, GatewayRuntime>; tunnelRuntimes: Record<string, GatewayTunnelRuntime>; connectionRuntimes: Record<string, GatewayConnectionRuntime> }>;
    refreshStatuses(connectionId?: string): Promise<void>;
    saveConnection(value: Partial<GatewayConnection> & { name: string; host: string; port: number; username: string; password: string }): Promise<GatewayState>;
    deleteConnection(id: string): Promise<GatewayState>;
    saveWorkspace(value: Partial<GatewayWorkspace> & { connectionId: string; name: string; directory: string; remotePort: number }): Promise<GatewayState>;
    deleteWorkspace(id: string): Promise<GatewayState>;
    savePortTunnel(value: Partial<GatewayPortTunnel> & { connectionId: string; port: number }): Promise<GatewayState>;
    deletePortTunnel(id: string): Promise<GatewayState>;
    startPortTunnel(id: string): Promise<void>;
    stopPortTunnel(id: string): Promise<void>;
    startServer(id: string): Promise<{ remotePort: number }>;
    stopServer(id: string): Promise<void>;
    startClient(id: string): Promise<void>;
    onStatus(listener: (id: string, status: GatewayRuntime) => void): () => void;
    onTunnelStatus(listener: (id: string, status: GatewayTunnelRuntime) => void): () => void;
    onConnectionStatus(listener: (id: string, status: GatewayConnectionRuntime) => void): () => void;
  };
}
