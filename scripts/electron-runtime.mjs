import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
};

export async function electronExecutable({ packageRoot, productName, bundleId }) {
  const electronDist = path.resolve(packageRoot, "../../node_modules/electron/dist");
  if (process.platform === "win32") return path.join(electronDist, "electron.exe");
  if (process.platform !== "darwin") return path.join(electronDist, "electron");

  const electronRoot = path.resolve(packageRoot, "../../node_modules/electron/dist/Electron.app");
  const runtimeRoot = path.join(packageRoot, ".electron-runtime");
  const bundle = path.join(runtimeRoot, `${productName}.app`);
  const icon = path.join(packageRoot, "assets/app-icon.png");
  const markerFile = path.join(runtimeRoot, ".runtime-version");
  const electronPackage = JSON.parse(await readFile(path.resolve(packageRoot, "../../node_modules/electron/package.json"), "utf8"));
  const iconInfo = await stat(icon);
  const marker = `${electronPackage.version}:${Math.floor(iconInfo.mtimeMs)}`;
  let currentMarker = "";
  try { currentMarker = (await readFile(markerFile, "utf8")).trim(); } catch { /* First launch creates the branded runtime. */ }
  if (currentMarker !== marker) {
    await rm(runtimeRoot, { recursive: true, force: true });
    await mkdir(runtimeRoot, { recursive: true });
    run("/bin/cp", ["-cR", electronRoot, bundle]);
    const plist = path.join(bundle, "Contents/Info.plist");
    for (const [key, value] of [["CFBundleDisplayName", productName], ["CFBundleName", productName], ["CFBundleIdentifier", bundleId]]) run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
    await writeFile(markerFile, `${marker}\n`, "utf8");
  }
  return path.join(bundle, "Contents/MacOS/Electron");
}
