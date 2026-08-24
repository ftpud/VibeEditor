import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  setDirtyState(dirty: boolean): void { ipcRenderer.send("editor:dirty-state", dirty); }
});
