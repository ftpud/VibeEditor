const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("desktop", {
  setDirtyState(dirty: boolean): void { ipcRenderer.send("editor:dirty-state", dirty); },
  openEditorWindow(options: { host: string; port: string; type: "file" | "useful"; path: string; scope?: "global" | "local" }): void { ipcRenderer.send("editor:open-window", options); },
  readClipboard(): Promise<string> { return ipcRenderer.invoke("desktop:clipboard-read"); },
  writeClipboard(text: string): Promise<void> { return ipcRenderer.invoke("desktop:clipboard-write", text); },
  openExternal(url: string): Promise<void> { return ipcRenderer.invoke("desktop:open-external", url); },
  chooseUpload(): Promise<{ id: string; name: string; size: number } | undefined> { return ipcRenderer.invoke("project-transfer:choose-upload"); },
  chooseDownload(name: string): Promise<{ id: string; name: string } | undefined> { return ipcRenderer.invoke("project-transfer:choose-download", name); },
  startProjectTransfer(options: { localId: string; token: string; host: string; port: number; direction: "upload" | "download"; size: number }): Promise<{ operationId: string }> { return ipcRenderer.invoke("project-transfer:start", options); },
  cancelProjectTransfer(operationId: string): Promise<boolean> { return ipcRenderer.invoke("project-transfer:cancel", operationId); },
  onProjectTransferProgress(listener: (progress: { operationId: string; bytes: number; total: number; done?: boolean; error?: string }) => void): () => void { const wrapped = (_event: unknown, progress: { operationId: string; bytes: number; total: number; done?: boolean; error?: string }) => listener(progress); ipcRenderer.on("project-transfer:progress", wrapped); return () => ipcRenderer.removeListener("project-transfer:progress", wrapped); },
  loadSettings(): Record<string, string> { return ipcRenderer.sendSync("desktop:settings-load") as Record<string, string>; },
  writeSetting(key: string, value: string | null): void { ipcRenderer.send("desktop:settings-write", key, value); }
});
