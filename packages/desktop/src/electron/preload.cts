const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("desktop", {
  setDirtyState(dirty: boolean): void { ipcRenderer.send("editor:dirty-state", dirty); },
  openEditorWindow(options: { host: string; port: string; type: "file" | "useful"; path: string; scope?: "global" | "local" }): void { ipcRenderer.send("editor:open-window", options); },
  readClipboard(): Promise<string> { return ipcRenderer.invoke("desktop:clipboard-read"); },
  writeClipboard(text: string): Promise<void> { return ipcRenderer.invoke("desktop:clipboard-write", text); },
  openExternal(url: string): Promise<void> { return ipcRenderer.invoke("desktop:open-external", url); },
  loadSettings(): Record<string, string> { return ipcRenderer.sendSync("desktop:settings-load") as Record<string, string>; },
  writeSetting(key: string, value: string | null): void { ipcRenderer.send("desktop:settings-write", key, value); }
});
