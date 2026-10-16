import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { electronExecutable } from "./electron-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
const config = target === "desktop"
  ? { packageRoot: path.join(root, "packages/desktop"), productName: "Vibe Editor", bundleId: "com.vibe-editor.desktop" }
  : target === "gateway"
    ? { packageRoot: path.join(root, "packages/gateway"), productName: "Vibe Gateway", bundleId: "com.vibe-editor.gateway" }
    : undefined;
if (!config) throw new Error("Expected desktop or gateway");
const executable = await electronExecutable(config);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
env.VIBE_NODE_EXECUTABLE ??= process.execPath;
if (target === "gateway") {
  env.VIBE_DESKTOP_ICON = path.join(root, "packages/desktop/assets/app-icon.png");
  env.VIBE_DESKTOP_EXECUTABLE = await electronExecutable({
    packageRoot: path.join(root, "packages/desktop"),
    productName: "Vibe Editor",
    bundleId: "com.vibe-editor.desktop",
  });
}
const child = spawn(executable, [config.packageRoot, ...process.argv.slice(3)], {
  cwd: config.packageRoot,
  stdio: "inherit",
  env,
  shell: false,
});
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal ? 143 : 0); });
child.on("error", error => { console.error(`[startup] ${error.message}`); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
