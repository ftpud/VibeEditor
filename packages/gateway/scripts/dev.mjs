import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";
import { electronExecutable } from "../../../scripts/electron-runtime.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootBin = path.resolve(packageRoot, "../../node_modules/.bin");
const executable = (name) => path.join(rootBin, process.platform === "win32" ? `${name}.cmd` : name);
const compile = spawnSync(executable("tsc"), ["-p", "tsconfig.electron.json"], { cwd: packageRoot, stdio: "inherit" });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const vite = spawn(executable("vite"), [], { cwd: packageRoot, stdio: "inherit" });
await waitOn({ resources: ["tcp:5174"], timeout: 30_000 });
const electronRuntime = await electronExecutable({ packageRoot, productName: "Vibe Gateway", bundleId: "com.vibe-editor.gateway" });
const desktopRuntime = await electronExecutable({
  packageRoot: path.resolve(packageRoot, "../desktop"),
  productName: "Vibe Editor",
  bundleId: "com.vibe-editor.desktop",
});
const electron = spawn(electronRuntime, [packageRoot], {
  cwd: packageRoot,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "http://localhost:5174",
    VIBE_DESKTOP_EXECUTABLE: desktopRuntime,
    VIBE_DESKTOP_ICON: path.resolve(packageRoot, "../desktop/assets/app-icon.png"),
  },
  stdio: "inherit",
  shell: false,
});
const stop = (code = 0) => { vite.kill(); electron.kill(); setTimeout(() => process.exit(code), 100); };
vite.on("exit", (code) => stop(code ?? 0)); electron.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop()); process.on("SIGTERM", () => stop());
