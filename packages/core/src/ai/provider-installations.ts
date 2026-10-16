import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AiProviderInstallation } from "@remote-ide/acp";
import { serializedStateMutation } from "../root-mutation.js";

/** An npm package whose `bin` file is the provider's ACP agent, started with Core's Node. */
export type InstallationSpec = { package: string; bin: string; /** Core-host override (environment) that replaces the managed installation. */ override?: () => string | undefined };
export type InstallationState = Pick<AiProviderInstallation, "status" | "source" | "version" | "latestVersion" | "location" | "error" | "package">;
export type Npm = { install(directory: string, specifier: string): Promise<void>; latest(name: string): Promise<string> };

const exec = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmEnvironment = (timeout: string) => ({ ...process.env, npm_config_fetch_retries: "1", npm_config_fetch_timeout: timeout, npm_config_update_notifier: "false" });
const defaultNpm: Npm = {
  async install(directory, specifier) {
    await exec(npmCommand, ["install", "--prefix", directory, "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", specifier], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, env: npmEnvironment("30000") });
  },
  async latest(name) {
    const { stdout } = await exec(npmCommand, ["view", `${name}@latest`, "version", "--json"], { timeout: 30_000, maxBuffer: 1024 * 1024, env: npmEnvironment("15000") });
    const version: unknown = JSON.parse(stdout);
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("Invalid npm version response");
    return version;
  }
};
const LATEST_CACHE_MS = 10 * 60_000;
type Current = { directory: string; specifier: string; version?: string };

/**
 * Provider agents live outside the application bundle, under
 * `~/.remote-ide/provider-runtimes/<provider>/` on the Core host. Installs and
 * updates download into a fresh directory and publish it only when complete, so
 * a failed update never replaces a working installation.
 */
export class ProviderInstallations {
  private readonly operations = new Map<string, { status: "installing" | "removing"; done: Promise<void> }>();
  private readonly errors = new Map<string, string>();
  private readonly latestVersions = new Map<string, { at: number; version?: string; pending?: Promise<string | undefined> }>();
  constructor(private readonly root: () => string = () => process.env.REMOTE_IDE_PROVIDER_RUNTIME_DIR ?? path.join(os.homedir(), ".remote-ide", "provider-runtimes"), private readonly npm: Npm = defaultNpm) {}

  private directory(provider: string): string {
    if (!/^[a-z0-9-]+$/.test(provider)) throw new Error("Invalid provider identifier");
    return path.join(this.root(), provider);
  }
  private async current(provider: string, spec: InstallationSpec): Promise<(Current & { entry: string }) | undefined> {
    const directory = this.directory(provider);
    try {
      const current = JSON.parse(await readFile(path.join(directory, "current.json"), "utf8")) as Current;
      if (typeof current.directory !== "string" || path.dirname(path.resolve(current.directory)) !== path.resolve(directory)) return undefined;
      const entry = path.join(current.directory, "node_modules", spec.package, spec.bin);
      await access(entry);
      return { ...current, entry, version: current.version ?? await installedVersion(current.directory, spec.package) };
    } catch { return undefined; }
  }

  /** The installed agent entry point, or undefined when the provider is not installed. */
  async entry(provider: string, spec: InstallationSpec): Promise<string | undefined> { return (await this.current(provider, spec))?.entry; }

  async state(provider: string, spec: InstallationSpec, checkLatest = false): Promise<InstallationState> {
    const override = spec.override?.();
    if (override) return { status: "installed", source: "external", location: override, package: spec.package };
    const current = await this.current(provider, spec);
    const operation = this.operations.get(provider);
    const latestVersion = checkLatest ? await this.latest(spec.package) : this.latestVersions.get(spec.package)?.version;
    const error = this.errors.get(provider);
    return {
      status: operation?.status ?? (current ? "installed" : "not_installed"), package: spec.package,
      ...(current ? { source: "managed" as const, version: current.version, location: current.directory } : {}),
      ...(latestVersion ? { latestVersion } : {}), ...(error ? { error } : {})
    };
  }

  /** Starts an install or update to the latest published version; resolves when it finishes. Conflicts throw synchronously. */
  install(provider: string, spec: InstallationSpec): Promise<void> {
    return this.run(provider, spec, "installing", async (directory) => {
      const previous = await this.current(provider, spec);
      const version = await this.npm.latest(spec.package).catch(() => undefined);
      if (version) this.latestVersions.set(spec.package, { at: Date.now(), version });
      if (previous && version && previous.version === version) return;
      const specifier = `${spec.package}@${version ?? "latest"}`;
      await mkdir(directory, { recursive: true });
      const candidate = await mkdtemp(path.join(directory, "installation-"));
      try {
        console.log(`[core] installing ${specifier} for ${provider}`);
        await writeFile(path.join(candidate, "package.json"), '{"private":true}');
        await this.npm.install(candidate, specifier);
        await access(path.join(candidate, "node_modules", spec.package, spec.bin));
        const installed = await installedVersion(candidate, spec.package);
        const marker = path.join(candidate, "current.json");
        await writeFile(marker, JSON.stringify({ directory: path.resolve(candidate), specifier, ...(installed ? { version: installed } : {}) }));
        await rename(marker, path.join(directory, "current.json"));
        console.log(`[core] ${provider} ${installed ?? ""} is installed`);
      } catch (error) {
        await rm(candidate, { recursive: true, force: true });
        throw new Error(`Could not install ${spec.package}: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Keep the previous installation: agents started from it may still be running.
      const keep = new Set([path.basename(candidate), ...(previous ? [path.basename(previous.directory)] : [])]);
      await Promise.all((await readdir(directory)).filter((name) => name.startsWith("installation-") && !keep.has(name)).map((name) => rm(path.join(directory, name), { recursive: true, force: true })));
    });
  }

  uninstall(provider: string, spec: InstallationSpec): Promise<void> {
    return this.run(provider, spec, "removing", async (directory) => {
      // Unpublish first so no new agent starts from a partially removed installation.
      await rm(path.join(directory, "current.json"), { force: true });
      const names = await readdir(directory).catch(() => [] as string[]);
      await Promise.all(names.filter((name) => name.startsWith("installation-")).map((name) => rm(path.join(directory, name), { recursive: true, force: true })));
    });
  }

  private run(provider: string, spec: InstallationSpec, status: "installing" | "removing", operation: (directory: string) => Promise<void>): Promise<void> {
    if (spec.override?.()) throw new Error("This provider is configured by a Core-host override and cannot be managed from Vibe Editor");
    const active = this.operations.get(provider);
    if (active) { if (active.status === status) return active.done; throw new Error("Another installation change is already running for this provider"); }
    const directory = this.directory(provider);
    this.errors.delete(provider);
    const done = serializedStateMutation(path.join(directory, "installation"), () => operation(directory))
      .catch((error: unknown) => { this.errors.set(provider, error instanceof Error ? error.message : String(error)); throw error; })
      .finally(() => { this.operations.delete(provider); });
    this.operations.set(provider, { status, done });
    return done;
  }

  private async latest(name: string): Promise<string | undefined> {
    const cached = this.latestVersions.get(name);
    if (cached?.pending) return cached.pending;
    if (cached && Date.now() - cached.at < LATEST_CACHE_MS) return cached.version;
    const pending = this.npm.latest(name).catch(() => cached?.version);
    this.latestVersions.set(name, { at: cached?.at ?? 0, version: cached?.version, pending });
    const version = await pending;
    this.latestVersions.set(name, { at: Date.now(), version });
    return version;
  }
}

async function installedVersion(directory: string, name: string): Promise<string | undefined> {
  try { return (JSON.parse(await readFile(path.join(directory, "node_modules", name, "package.json"), "utf8")) as { version?: string }).version; }
  catch { return undefined; }
}

export const providerInstallations = new ProviderInstallations();
