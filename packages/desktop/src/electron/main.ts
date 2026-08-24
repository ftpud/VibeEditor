import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
let hasDirtyTabs = false;
let allowClose = false;

function launchOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const launchConfig = {
  host: launchOption("host"),
  port: launchOption("port")
};

ipcMain.on("editor:dirty-state", (_event, dirty: boolean) => { hasDirtyTabs = dirty; });

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#181818",
    webPreferences: {
      preload: path.join(directory, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  window.removeMenu();
  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[desktop] failed to load ${url}: ${code} ${description}`);
  });
  window.on("close", (event) => {
    if (!hasDirtyTabs || allowClose) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: ["Cancel", "Close without saving"],
      defaultId: 0,
      cancelId: 0,
      title: "Unsaved changes",
      message: "There are unsaved files.",
      detail: "Closing now will discard those changes."
    });
    if (choice === 1) { allowClose = true; window.close(); }
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL ?? (app.isPackaged ? undefined : "http://localhost:5173");
  const query = Object.fromEntries(
    Object.entries(launchConfig).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const load = devUrl
    ? (() => {
        const url = new URL(devUrl);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        return window.loadURL(url.toString());
      })()
    : window.loadFile(path.join(directory, "../dist-renderer/index.html"), { query });
  void load.catch((error: unknown) => console.error("[desktop] page load failed", error));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
