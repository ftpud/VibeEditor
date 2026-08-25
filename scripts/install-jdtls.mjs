import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import path from "node:path";

const version = "1.61.0-202608051627";
const checksum = "02478201484f60a27fe5438899e98cc7bf56aaf380a856d1409eab14d228e153";
const root = path.resolve(".tools/jdtls");
const marker = path.join(root, `.installed-${version}`);
await installRuntime();
try { await readFile(marker); console.log(`JDT LS ${version} is already installed.`); process.exit(0); } catch { /* Install below. */ }

const archive = path.resolve(`.tools/jdt-language-server-${version}.tar.gz`);
await mkdir(path.dirname(archive), { recursive: true });
const response = await fetch(`https://download.eclipse.org/jdtls/snapshots/jdt-language-server-${version}.tar.gz`);
if (!response.ok || !response.body) throw new Error(`JDT LS download failed: HTTP ${response.status}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
if (actual !== checksum) throw new Error(`JDT LS checksum mismatch: expected ${checksum}, received ${actual}`);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await new Promise((resolve, reject) => {
  const child = spawn("tar", ["-xzf", archive, "-C", root], { stdio: "inherit" });
  child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)));
});
await rm(archive, { force: true });
await writeFile(marker, `${version}\n`, "utf8");
console.log(`Installed JDT LS ${version} in ${root}`);

async function installRuntime() {
  const runtimeRoot = path.resolve(".tools/jre21");
  const runtimeMarker = path.join(runtimeRoot, ".installed-21.0.8+9");
  try { await readFile(runtimeMarker); return; } catch { /* Install below. */ }
  await mkdir(path.resolve(".tools"), { recursive: true });
  const osName = { darwin: "mac", linux: "linux", win32: "windows" }[process.platform];
  const architecture = { arm64: "aarch64", x64: "x64" }[process.arch];
  if (!osName || !architecture) throw new Error(`No bundled JRE is available for ${process.platform}/${process.arch}`);
  const extension = osName === "windows" ? "zip" : "tar.gz";
  const fileName = `OpenJDK21U-jre_${architecture}_${osName}_hotspot_21.0.8_9.${extension}`;
  const releaseBase = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9";
  const checksumResponse = await fetch(`${releaseBase}/${fileName}.sha256.txt`);
  if (!checksumResponse.ok) throw new Error(`Temurin checksum download failed: HTTP ${checksumResponse.status}`);
  const expectedChecksum = (await checksumResponse.text()).trim().split(/\s+/)[0];
  const runtimeArchive = path.resolve(`.tools/temurin-21.0.8+9.${extension}`);
  const response = await fetch(`${releaseBase}/${fileName}`);
  if (!response.ok || !response.body) throw new Error(`Temurin download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(runtimeArchive));
  const actual = createHash("sha256").update(await readFile(runtimeArchive)).digest("hex");
  if (actual !== expectedChecksum) throw new Error(`Temurin checksum mismatch: expected ${expectedChecksum}, received ${actual}`);
  await rm(runtimeRoot, { recursive: true, force: true });
  if (osName === "windows") {
    const extractRoot = path.resolve(".tools/.jre21-extract");
    await rm(extractRoot, { recursive: true, force: true });
    await mkdir(extractRoot, { recursive: true });
    const command = "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force";
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command, runtimeArchive, extractRoot]);
    const entries = await readdir(extractRoot, { withFileTypes: true });
    const source = entries.length === 1 && entries[0]?.isDirectory() ? path.join(extractRoot, entries[0].name) : extractRoot;
    await rename(source, runtimeRoot);
    if (source !== extractRoot) await rm(extractRoot, { recursive: true, force: true });
  } else {
    await mkdir(runtimeRoot, { recursive: true });
    await run("tar", ["-xzf", runtimeArchive, "-C", runtimeRoot, "--strip-components=1"]);
  }
  await rm(runtimeArchive, { force: true });
  await writeFile(runtimeMarker, "21.0.8+9\n", "utf8");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
