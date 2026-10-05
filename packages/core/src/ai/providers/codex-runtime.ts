import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const bundledRequire = createRequire(import.meta.url);
let runtimeRequire = bundledRequire;
const execute = promisify(execFile);
type RunNpm = (args: string[]) => Promise<string>;
function parseVersion(text: string): string {
  const response: unknown = JSON.parse(text);
  const version = Array.isArray(response) && response.length === 1 ? response[0] : response;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid npm version response");
  return version;
}
const runNpm: RunNpm = async (args) => {
  const { stdout } = await execute(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "15000" }
  });
  return stdout;
};

export function resolveCodexRuntime(module: string): string { return runtimeRequire.resolve(module); }

/** Publish only complete installations, so failed updates never replace the cached runtime. */
export async function updateCodexRuntime(
  directory = process.env.REMOTE_IDE_CODEX_RUNTIME_DIR ?? path.join(os.homedir(), ".remote-ide", "codex-runtime"),
  npm: RunNpm = runNpm
): Promise<void> {
  runtimeRequire = bundledRequire;
  let current: { directory: string; adapter: string; codex: string } | undefined;
  const load = (directory: string) => {
    const require = createRequire(path.join(directory, "package.json"));
    require.resolve("@agentclientprotocol/codex-acp");
    require.resolve("@openai/codex/bin/codex.js");
    return require;
  };
  try {
    current = JSON.parse(await readFile(path.join(directory, "current.json"), "utf8"));
    if (current) runtimeRequire = load(current.directory);
  } catch { current = undefined; }
  if (process.env.REMOTE_IDE_CODEX_AUTO_UPDATE === "0") return;
  try {
    console.log("[core] checking for Codex ACP and Codex runtime updates");
    const [adapter, codex] = await Promise.all([
      npm(["view", "@agentclientprotocol/codex-acp@latest", "version", "--json"]).then(parseVersion),
      npm(["view", "@openai/codex@latest", "version", "--json"]).then(parseVersion)
    ]);
    if (current?.adapter === adapter && current.codex === codex) {
      console.log(`[core] Codex ACP ${adapter}, Codex ${codex} are current`);
      return;
    }
    await mkdir(directory, { recursive: true });
    const candidate = await mkdtemp(path.join(directory, "installation-"));
    await writeFile(path.join(candidate, "package.json"), JSON.stringify({ private: true }));
    await npm(["install", "--prefix", candidate, "--no-audit", "--no-fund", "--package-lock=false", `@agentclientprotocol/codex-acp@${adapter}`, `@openai/codex@${codex}`]);
    const require = load(candidate);
    const temporary = path.join(candidate, "current.json");
    await writeFile(temporary, JSON.stringify({ directory: candidate, adapter, codex }));
    await rename(temporary, path.join(directory, "current.json"));
    runtimeRequire = require;
    console.log(`[core] using updated Codex ACP ${adapter}, Codex ${codex}`);
  } catch (error) {
    console.warn(`[core] Codex update failed; using ${current ? "cached" : "bundled"} runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
}
