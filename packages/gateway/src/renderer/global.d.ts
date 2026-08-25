type GatewayConnection = { id: string; name: string; host: string; port: number; username: string };
type GatewayWorkspace = { id: string; connectionId: string; name: string; directory: string; remotePort: number };
type GatewayState = { connections: GatewayConnection[]; workspaces: GatewayWorkspace[] };
type GatewayRuntime = { status: "idle" | "working" | "server" | "client" | "error"; message: string };

interface Window {
  gateway: {
    get(): Promise<{ state: GatewayState; runtimes: Record<string, GatewayRuntime> }>;
    refreshStatuses(connectionId?: string): Promise<void>;
    saveConnection(value: Partial<GatewayConnection> & { name: string; host: string; port: number; username: string; password: string }): Promise<GatewayState>;
    deleteConnection(id: string): Promise<GatewayState>;
    saveWorkspace(value: Partial<GatewayWorkspace> & { connectionId: string; name: string; directory: string; remotePort: number }): Promise<GatewayState>;
    deleteWorkspace(id: string): Promise<GatewayState>;
    startServer(id: string): Promise<{ remotePort: number }>;
    stopServer(id: string): Promise<void>;
    startClient(id: string): Promise<void>;
    onStatus(listener: (id: string, status: GatewayRuntime) => void): () => void;
  };
}
