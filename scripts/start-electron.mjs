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
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });
