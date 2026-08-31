type GatewayConnection = { id: string; name: string; host: string; port: number; username: string; authenticationMethod: "password" | "privateKey" | "agent"; privateKeyPath?: string; hostKeyFingerprint?: string };
type GatewayWorkspace = { id: string; connectionId: string; name: string; directory: string; remotePort: number };
type GatewayPortTunnel = { id: string; connectionId: string; port: number };
type GatewayState = { connections: GatewayConnection[]; workspaces: GatewayWorkspace[]; portTunnels: GatewayPortTunnel[] };
type GatewayRuntime = { status: "idle" | "working" | "server" | "client" | "error"; message: string; logs?: string[]; retryable?: boolean; repairable?: boolean };
type GatewayTunnelRuntime = { status: "idle" | "working" | "running" | "error"; message: string };
type GatewayConnectionRuntime = { status: "unknown" | "reconnecting" | "online" | "slow" | "offline"; message: string; latencyMs?: number };
type GatewayRepositorySettings = { repository: string; branch: string; autoUpdate: boolean };

interface Window {
  gateway: {
    get(): Promise<{ state: GatewayState; repository: GatewayRepositorySettings; runtimes: Record<string, GatewayRuntime>; tunnelRuntimes: Record<string, GatewayTunnelRuntime>; connectionRuntimes: Record<string, GatewayConnectionRuntime> }>;
    saveRepository(value: GatewayRepositorySettings): Promise<GatewayRepositorySettings>;
    refreshStatuses(connectionId?: string): Promise<void>;
    pickPrivateKey(): Promise<string | undefined>;
    testConnection(value: { id?: string; host: string; port: number; username: string; authenticationMethod: "password" | "privateKey" | "agent"; password?: string; privateKeyPath?: string; passphrase?: string; hostKeyFingerprint?: string }): Promise<{ message: string; hostKeyFingerprint?: string }>;
    saveConnection(value: Partial<GatewayConnection> & { name: string; host: string; port: number; username: string; authenticationMethod: "password" | "privateKey" | "agent"; password?: string; passphrase?: string }): Promise<GatewayState>;
    deleteConnection(id: string): Promise<GatewayState>;
    discoverWorkspaceDirectories(connectionId: string): Promise<string[]>;
    saveWorkspace(value: Partial<GatewayWorkspace> & { connectionId: string; name: string; directory: string; remotePort: number }): Promise<GatewayState>;
    deleteWorkspace(id: string): Promise<GatewayState>;
    savePortTunnel(value: Partial<GatewayPortTunnel> & { connectionId: string; port: number }): Promise<GatewayState>;
    deletePortTunnel(id: string): Promise<GatewayState>;
    startPortTunnel(id: string): Promise<void>;
    stopPortTunnel(id: string): Promise<void>;
    startServer(id: string): Promise<{ remotePort: number }>;
    repairServer(id: string): Promise<{ remotePort: number }>;
    cancelProvisioning(id: string): Promise<void>;
    stopServer(id: string): Promise<void>;
    startClient(id: string): Promise<void>;
    onStatus(listener: (id: string, status: GatewayRuntime) => void): () => void;
    onTunnelStatus(listener: (id: string, status: GatewayTunnelRuntime) => void): () => void;
    onConnectionStatus(listener: (id: string, status: GatewayConnectionRuntime) => void): () => void;
  };
}
