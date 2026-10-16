import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { macApplicationIcon } from "./bundle/icon.mjs";

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
};

export async function electronExecutable({ packageRoot, productName, bundleId }) {
  const electronPackageRoot = path.resolve(packageRoot, "../../node_modules/electron");
  const electronDist = path.resolve(packageRoot, "../../node_modules/electron/dist");
  const binary = path.join(electronDist, process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
  try { await access(binary); } catch {
    console.log("[startup] Installing the Electron runtime for this platform…");
    const env = { ...process.env }; delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
    const result = spawnSync(process.execPath, [path.join(electronPackageRoot, "install.js")], { stdio: "inherit", env });
    if (result.status !== 0) throw new Error(`Electron installation failed: ${result.error?.message ?? result.status}`);
    await access(binary);
  }
  if (process.platform !== "darwin") return binary;

  const electronRoot = path.resolve(packageRoot, "../../node_modules/electron/dist/Electron.app");
  const runtimeRoot = path.join(packageRoot, ".electron-runtime");
  const bundle = path.join(runtimeRoot, `${productName}.app`);
  const icon = path.join(packageRoot, "assets/app-icon.png");
  const markerFile = path.join(runtimeRoot, ".runtime-version");
  const electronPackage = JSON.parse(await readFile(path.resolve(packageRoot, "../../node_modules/electron/package.json"), "utf8"));
  const iconInfo = await stat(icon);
  const marker = `${electronPackage.version}:${Math.floor(iconInfo.mtimeMs)}:native-icon-v1`;
  let currentMarker = "";
  try { currentMarker = (await readFile(markerFile, "utf8")).trim(); } catch { /* First launch creates the branded runtime. */ }
  const executable = path.join(bundle, "Contents/MacOS/Electron");
  const available = await access(executable).then(() => true, () => false);
  if (currentMarker !== marker || !available) {
    await rm(runtimeRoot, { recursive: true, force: true });
    await mkdir(runtimeRoot, { recursive: true });
    run("/bin/cp", ["-cR", electronRoot, bundle]);
    const plist = path.join(bundle, "Contents/Info.plist");
    for (const [key, value] of [["CFBundleDisplayName", productName], ["CFBundleName", productName], ["CFBundleIdentifier", bundleId]]) run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
    const nativeIcon = await macApplicationIcon(icon, runtimeRoot);
    await copyFile(nativeIcon, path.join(bundle, "Contents/Resources/electron.icns"));
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
    await writeFile(markerFile, `${marker}\n`, "utf8");
  }
  return executable;
}
