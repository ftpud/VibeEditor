import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { quoteWorkspaceShellArgument as shell } from "./workspace-path.js";

export type CoreBundle = { target: string; commit: string; release: string; archive: string; sha256: string };
/** Gateway argument that runs the bundled Editor on Gateway's own Electron runtime. */
export const EDITOR_FLAG = "--vibe-editor";
/** `desktopApp` is the Editor's Electron app directory (package.json, dist-electron, dist-renderer, node_modules), relative to `bundle/`. */
export type BundleManifest = { schema: 1; channel: "early-access"; version: string; commit: string; desktopApp: string; cores: Record<string, CoreBundle> };
export async function loadBundle(resources: string): Promise<BundleManifest> {
  const manifest = JSON.parse(await readFile(path.join(resources, "bundle/manifest.json"), "utf8")) as BundleManifest;
  if (manifest.schema !== 1 || manifest.channel !== "early-access" || !/^[0-9a-f]{40,64}$/.test(manifest.commit)) throw new Error("Invalid Early Access bundle manifest");
  if (!manifest.desktopApp || path.isAbsolute(manifest.desktopApp) || manifest.desktopApp.split(/[\\/]/).includes("..")) throw new Error("Invalid bundled Desktop application");
  const targets = Object.keys(manifest.cores ?? {});
  if (!targets.length || targets.some(target => !["linux-x64", "linux-arm64", "darwin-arm64"].includes(target))) throw new Error("Invalid bundled Core targets");
  for (const target of targets) {
    const core = manifest.cores[target];
    if (!core || core.target !== target || core.commit !== manifest.commit || core.archive !== `core-${target}.tar.gz` || !/^[a-f0-9]{64}$/.test(core.sha256) || !new RegExp(`^${manifest.commit}-node[0-9]+-bundle-[a-zA-Z0-9-]+$`).test(core.release)) throw new Error(`Invalid bundled Core: ${target}`);
  }
  return manifest;
}
export function coreTarget(os: string, architecture: string): string {
  const platform = { Linux: "linux", Darwin: "darwin", linux: "linux", darwin: "darwin" }[os];
  const arch = { x86_64: "x64", aarch64: "arm64", arm64: "arm64", x64: "x64" }[architecture];
  const target = `${platform}-${arch}`;
  if (!["linux-x64", "linux-arm64", "darwin-arm64"].includes(target)) throw new Error(`Bundled Core does not support ${os}/${architecture}`);
  return target;
}
export async function verifiedCoreArchive(resources: string, core: CoreBundle): Promise<string> {
  const archive = path.join(resources, "bundle/cores", core.archive);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== core.sha256) throw new Error(`Bundled Core checksum failed: ${core.target}`);
  return archive;
}
export function bundledEnvironment(release: string): string {
  if (!/^[0-9a-f]{40,64}-node[0-9]+-bundle-[a-zA-Z0-9-]+$/.test(release)) throw new Error("Invalid bundled release identity");
  return `export PATH="$HOME/.vibe-deploy/releases/${release}/bin:$PATH"`;
}

/** Upload to a private directory, verify before extraction, then atomically install. */
export function installBundleCommand(core: CoreBundle, upload: string): string {
  if (!/^[0-9a-f]{40,64}-node[0-9]+-bundle-[a-zA-Z0-9-]+$/.test(core.release) || !/^[0-9a-f]{64}$/.test(core.sha256) || !/^\.vibe-upload-[a-zA-Z0-9-]+$/.test(upload)) throw new Error("Invalid bundled deployment parameters");
  return `set -eu
umask 077
archive="$HOME/${upload}/core.tar.gz"
base="$HOME/.vibe-deploy/releases"
mkdir -p "$base"
staging="$base/.bundle-$$-$RANDOM"
promotion=""
provision_lock="$HOME/.vibe-deploy/provision.lock"
lock_owned=0
trap 'rm -rf "$staging" "$HOME/${upload}"; if [ -n "$promotion" ]; then rmdir "$promotion" 2>/dev/null || true; fi; if [ "$lock_owned" = 1 ]; then rm -rf "$provision_lock"; fi' EXIT
if ! mkdir "$provision_lock" 2>/dev/null; then echo 'Gateway provisioning or storage maintenance is in progress; retry when it finishes' >&2; exit 1; fi
lock_owned=1
printf '%s\\n' "$$|$(hostname)|${upload}" > "$provision_lock/owner"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$archive"); else actual=$(shasum -a 256 "$archive"); fi
[ "\${actual%% *}" = ${shell(core.sha256)} ] || { echo 'Uploaded Core checksum failed' >&2; exit 1; }
# An existing immutable release is reused only when its archive identity matches.
if [ -d "$base/${core.release}" ]; then
  [ "$(cat "$base/${core.release}/.bundle-sha256" 2>/dev/null)" = ${shell(core.sha256)} ] || { echo 'Release identity collision; remove the damaged inactive release before retrying' >&2; exit 1; }
else
  mkdir "$staging"
  tar -xzf "$archive" -C "$staging"
  (cd "$staging"; bin/node --input-type=module -e ${shell("import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); require('node-pty'); await import('./packages/core/dist/server.js');")})
  printf '%s' ${shell(core.sha256)} > "$staging/.bundle-sha256"
  # mkdir acts as a promotion lock; never nest a staging directory in a competing release.
  lock="$base/.${core.release}.promote"
  mkdir "$lock" || { echo 'Another bundle installation is promoting this release; retry' >&2; exit 1; }
  promotion="$lock"
  if [ -e "$base/${core.release}" ]; then echo 'Release changed during installation; retry' >&2; exit 1; fi
  mv "$staging" "$base/${core.release}"
  rmdir "$lock"
  promotion=""
fi
echo VIBE_RESULT:${core.commit}:0:${core.release}`;
}

const preparing = new Map<string, Promise<string>>();
export function prepareBundledCore(resources: string, cache: string, core: CoreBundle, extract: (archive: string, destination: string) => Promise<void>): Promise<string> {
  const key = path.join(cache, core.release, core.target);
  const existing = preparing.get(key);
  if (existing) return existing;
  const pending = extractBundledCore(resources, cache, core, extract).finally(() => { preparing.delete(key); });
  preparing.set(key, pending);
  return pending;
}
async function extractBundledCore(resources: string, cache: string, core: CoreBundle, extract: (archive: string, destination: string) => Promise<void>): Promise<string> {
  const archive = await verifiedCoreArchive(resources, core);
  const destination = path.join(cache, core.release, core.target);
  try {
    await access(path.join(destination, "bin/node"));
    await access(path.join(destination, "packages/core/dist/index.js"));
    if ((await readFile(path.join(destination, ".bundle-sha256"), "utf8")) === core.sha256) return destination;
  } catch { /* Extract below. */ }
  const staging = `${destination}.${randomUUID()}.tmp`;
  await mkdir(staging, { recursive: true });
  try {
    await extract(archive, staging);
    await writeFile(path.join(staging, ".bundle-sha256"), core.sha256);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return destination;
}
