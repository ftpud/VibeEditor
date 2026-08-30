const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("gateway", {
  get: () => ipcRenderer.invoke("gateway:get"),
  saveRepository: (value: unknown) => ipcRenderer.invoke("gateway:saveRepository", value),
  refreshStatuses: (connectionId?: string) => ipcRenderer.invoke("gateway:refreshStatuses", connectionId),
  pickPrivateKey: () => ipcRenderer.invoke("gateway:pickPrivateKey"),
  testConnection: (value: unknown) => ipcRenderer.invoke("gateway:testConnection", value),
  saveConnection: (value: unknown) => ipcRenderer.invoke("gateway:saveConnection", value),
  deleteConnection: (id: string) => ipcRenderer.invoke("gateway:deleteConnection", id),
  discoverWorkspaceDirectories: (connectionId: string) => ipcRenderer.invoke("gateway:discoverWorkspaceDirectories", connectionId),
  saveWorkspace: (value: unknown) => ipcRenderer.invoke("gateway:saveWorkspace", value),
  deleteWorkspace: (id: string) => ipcRenderer.invoke("gateway:deleteWorkspace", id),
  savePortTunnel: (value: unknown) => ipcRenderer.invoke("gateway:savePortTunnel", value),
  deletePortTunnel: (id: string) => ipcRenderer.invoke("gateway:deletePortTunnel", id),
  startPortTunnel: (id: string) => ipcRenderer.invoke("gateway:startPortTunnel", id),
  stopPortTunnel: (id: string) => ipcRenderer.invoke("gateway:stopPortTunnel", id),
  startServer: (id: string) => ipcRenderer.invoke("gateway:startServer", id),
  stopServer: (id: string) => ipcRenderer.invoke("gateway:stopServer", id),
  startClient: (id: string) => ipcRenderer.invoke("gateway:startClient", id),
  onStatus: (listener: (id: string, status: unknown) => void) => { const handler = (_event: unknown, id: string, status: unknown) => listener(id, status); ipcRenderer.on("gateway:status", handler); return () => ipcRenderer.removeListener("gateway:status", handler); },
  onTunnelStatus: (listener: (id: string, status: unknown) => void) => { const handler = (_event: unknown, id: string, status: unknown) => listener(id, status); ipcRenderer.on("gateway:tunnelStatus", handler); return () => ipcRenderer.removeListener("gateway:tunnelStatus", handler); },
  onConnectionStatus: (listener: (id: string, status: unknown) => void) => { const handler = (_event: unknown, id: string, status: unknown) => listener(id, status); ipcRenderer.on("gateway:connectionStatus", handler); return () => ipcRenderer.removeListener("gateway:connectionStatus", handler); }
});
