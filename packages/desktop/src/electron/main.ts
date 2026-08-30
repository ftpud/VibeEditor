import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsStore } from "./settings-store.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const appIcon = path.join(directory, "../assets/app-icon.png");
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

process.title = "Vibe Editor";
app.name = "Vibe Editor";
app.setName("Vibe Editor");
app.setAppUserModelId("com.vibe-editor.desktop");
app.commandLine.appendSwitch("class", "VibeEditor");

const settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
ipcMain.on("desktop:settings-load", (event) => { event.returnValue = settings.all(); });
ipcMain.on("desktop:settings-write", (_event, key: unknown, value: unknown) => settings.set(key, value));
app.on("before-quit", () => settings.flush());

ipcMain.on("editor:dirty-state", (_event, dirty: boolean) => { hasDirtyTabs = dirty; });
ipcMain.handle("desktop:clipboard-read", () => clipboard.readText());
ipcMain.handle("desktop:clipboard-write", (_event, text: unknown) => { if (typeof text === "string" && text.length <= 2_000_000) clipboard.writeText(text); });
ipcMain.handle("desktop:open-external", async (_event, value: unknown) => {
  if (typeof value !== "string" || value.length > 4096) return;
  const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") return;
  await shell.openExternal(url.toString());
});
ipcMain.on("editor:open-window", (_event, options: unknown) => {
  if (!options || typeof options !== "object") return;
  const value = options as Record<string, unknown>;
  if (typeof value.host !== "string" || typeof value.port !== "string" || (value.type !== "file" && value.type !== "useful") || typeof value.path !== "string" || value.path.length > 1000) return;
  createWindow({ detached: "1", host: value.host, port: value.port, type: value.type, path: value.path, ...(value.scope === "global" || value.scope === "local" ? { scope: value.scope } : {}) });
});

function createWindow(extraQuery: Record<string, string> = {}): void {
  const window = new BrowserWindow({
    title: extraQuery.detached === "1" ? (extraQuery.path?.split("/").pop() ?? "Vibe Editor") : "Vibe Editor",
    icon: appIcon,
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#181818",
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
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
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const query = { ...Object.fromEntries(
    Object.entries(launchConfig).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  ), ...extraQuery };
  const load = devUrl
    ? (() => {
        const url = new URL(devUrl);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        return window.loadURL(url.toString());
      })()
    : window.loadFile(path.join(directory, "../dist-renderer/index.html"), { query });
  void load.catch((error: unknown) => console.error("[desktop] page load failed", error));
}

app.whenReady().then(() => {
  app.setName("Vibe Editor"); process.title = "Vibe Editor";
  if (process.platform === "darwin") app.dock.setIcon(nativeImage.createFromPath(appIcon));
  createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
