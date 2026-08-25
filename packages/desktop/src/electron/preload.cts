const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("desktop", {
  setDirtyState(dirty: boolean): void { ipcRenderer.send("editor:dirty-state", dirty); },
  openEditorWindow(options: { host: string; port: string; type: "file" | "useful"; path: string; scope?: "global" | "local" }): void { ipcRenderer.send("editor:open-window", options); }
});
