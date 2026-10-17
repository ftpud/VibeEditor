import { parse as parseEnv } from "dotenv";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { FileRevision } from "@remote-ide/protocol";
import { CoreError } from "../../../errors.js";
import type { WorkspaceFileSystem } from "../../../filesystem.js";
import { defaultRunConfigurations, npmConfigurationPath, parseNpmConfiguration, validatePackageJsonPath, validateNpmRunConfiguration, type NpmProjectOptions, type NpmRunConfiguration, type PackageManager } from "./npm-settings.js";
import type { LanguageDescriptor, LanguageExtra, LanguageProjectNode, LanguageService, LanguageServiceEvents } from "../../../language/service.js";

/**
 * Minimal second built-in language: Node projects described by `package.json`.
 * A package.json becomes a project through "Add as npm project", which writes
 * `.settings/npm.json` with named run configurations over package scripts.
 * It advertises no debug, LSP, workspace symbols or source roots, so it
 * exercises the contract's "unsupported" paths.
 */
export const NODE_DESCRIPTOR: LanguageDescriptor = {
  id: "node", name: "Node.js", extensions: ["js", "mjs", "cjs", "ts", "mts", "cts"], projectMarkers: ["package.json"],
  capabilities: { projectTree: true, build: true, run: true, debug: false, lsp: false, workspaceSymbols: false, configuration: true, runConfigurations: true, sourceRoots: false }
};

const unsupported = (what: string) => new CoreError("INVALID_REQUEST", `Node.js does not support ${what}`);
const DEFAULT_PACKAGE_JSON = "package.json";
type Manifest = { scripts?: Record<string, string>; name?: string };
type Settings = { options: NpmProjectOptions; content: string; revision: FileRevision };

const slug = (value: string) => value.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "run";
const stringify = (options: NpmProjectOptions) => JSON.stringify(options, null, 2) + "\n";

export class NodeLanguageService implements LanguageService {
  readonly descriptor = NODE_DESCRIPTOR;
  private process?: ChildProcess;

  constructor(private readonly workspace: string, private readonly events: LanguageServiceEvents, private readonly filesystem: WorkspaceFileSystem, private readonly npm?: string) {}

  private async manifest(packageJsonPath = DEFAULT_PACKAGE_JSON): Promise<Manifest | undefined> {
    try { return JSON.parse((await this.filesystem.read(packageJsonPath)).content); } catch { return undefined; }
  }
  private async settings(): Promise<Settings | undefined> {
    let file: { content: string; revision: FileRevision };
    try { file = await this.filesystem.read(npmConfigurationPath); }
    catch (error) { if (error instanceof CoreError && error.code === "FILE_NOT_FOUND") return undefined; throw error; }
    return { options: parseNpmConfiguration(file.content), content: file.content, revision: file.revision };
  }
  private async requireSettings(): Promise<Settings> {
    const settings = await this.settings();
    if (!settings) throw new CoreError("INVALID_REQUEST", "Add package.json as an npm project first");
    return settings;
  }
  private async write(options: NpmProjectOptions, revision?: FileRevision): Promise<Settings> {
    const content = stringify(parseNpmConfiguration(stringify(options)) );
    try { await this.filesystem.resolveExisting(path.posix.dirname(npmConfigurationPath)); }
    catch (error) { if (error instanceof CoreError && error.code === "FILE_NOT_FOUND") await this.filesystem.createDirectory(path.posix.dirname(npmConfigurationPath)); else throw error; }
    const written = await this.filesystem.write(npmConfigurationPath, content, revision, false, !revision);
    return { options: parseNpmConfiguration(content), content, revision: written.revision };
  }
  private async packageManager(packageJsonPath: string): Promise<PackageManager> {
    const directory = path.posix.dirname(packageJsonPath);
    const exists = async (name: string) => { try { await this.filesystem.resolveExisting(path.posix.join(directory, name)); return true; } catch { return false; } };
    if (await exists("pnpm-lock.yaml")) return "pnpm";
    if (await exists("yarn.lock")) return "yarn";
    return "npm";
  }

  async detect(): Promise<boolean> { return (await this.settings().catch(() => undefined)) !== undefined || (await this.manifest()) !== undefined; }

  /** `extra.packageJsonPath` adds a package.json as an npm project; reloading keeps existing run configurations. */
  async load(input?: LanguageExtra): Promise<LanguageExtra> {
    const packageJsonPath = validatePackageJsonPath(input?.packageJsonPath ?? DEFAULT_PACKAGE_JSON);
    const manifest = await this.manifest(packageJsonPath);
    if (!manifest) throw new CoreError("INVALID_REQUEST", `${packageJsonPath} is missing or is not valid JSON`);
    const existing = await this.settings();
    if (existing) await this.write({ ...existing.options, packageJsonPath }, existing.revision);
    else {
      const runConfigurations = defaultRunConfigurations(Object.keys(manifest.scripts ?? {}));
      await this.write({ type: "npm", packageJsonPath, packageManager: await this.packageManager(packageJsonPath), runConfigurations, ...(runConfigurations[0] ? { selectedRunConfigurationId: runConfigurations[0].id } : {}) });
    }
    return { options: await this.options(), tree: await this.projectTree() };
  }

  async options(): Promise<LanguageExtra> {
    const settings = await this.settings();
    const packageJsonPath = settings?.options.packageJsonPath ?? DEFAULT_PACKAGE_JSON;
    const manifest = await this.manifest(packageJsonPath);
    if (!manifest && !settings) return { configured: false, scripts: [], runConfigurations: [] };
    if (!manifest) throw new CoreError("INVALID_REQUEST", `No ${packageJsonPath} in this workspace`);
    return {
      configured: settings !== undefined, packageJsonPath, name: manifest.name ?? path.basename(this.workspace), scripts: Object.keys(manifest.scripts ?? {}),
      packageManager: settings?.options.packageManager ?? await this.packageManager(packageJsonPath),
      ...(settings?.options.executable ? { executable: settings.options.executable } : {}),
      runConfigurations: settings?.options.runConfigurations ?? [],
      ...(settings?.options.selectedRunConfigurationId ? { selectedRunConfigurationId: settings.options.selectedRunConfigurationId } : {})
    };
  }

  async projectTree(): Promise<LanguageProjectNode[]> {
    const settings = await this.settings();
    const packageJsonPath = settings?.options.packageJsonPath ?? DEFAULT_PACKAGE_JSON;
    const manifest = await this.manifest(packageJsonPath);
    if (!manifest) return [];
    const scripts = Object.keys(manifest.scripts ?? {});
    return [{ name: "package.json", path: packageJsonPath, type: "file", ...(scripts.length ? { children: scripts.map((script) => ({ name: script, path: packageJsonPath, type: "script", extra: { script } })) } : {}) }];
  }
  async addSourceRoot(): Promise<void> { throw unsupported("source roots"); }
  async workspaceSymbols(): Promise<{ symbols: [] }> { throw unsupported("workspace symbols"); }
  async checkTools() {
    const settings = await this.settings();
    return [await this.checkExecutable(this.executable(settings?.options))];
  }
  private executable(options?: NpmProjectOptions): string {
    if (this.npm) return this.npm;
    const command = options?.executable ?? options?.packageManager ?? "npm";
    return process.platform === "win32" && !options?.executable ? `${command}.cmd` : command;
  }
  private checkExecutable(executable: string): Promise<{ tool: string; executable: string; ok: boolean; message: string }> {
    const tool = path.basename(executable).replace(/\.cmd$/, "");
    return new Promise((resolve) => {
      const child = spawn(executable, ["--version"], { cwd: this.workspace });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
      child.on("error", (error) => resolve({ tool, executable, ok: false, message: error.message }));
      child.on("close", (code) => resolve({ tool, executable, ok: code === 0, message: code === 0 ? out.trim() : `${tool} exited with ${code}` }));
    });
  }

  async readConfiguration() {
    const settings = await this.settings();
    if (settings) return { path: npmConfigurationPath, content: settings.content, revision: settings.revision };
    const packageJsonPath = DEFAULT_PACKAGE_JSON;
    const manifest = await this.manifest(packageJsonPath);
    const runConfigurations = defaultRunConfigurations(Object.keys(manifest?.scripts ?? {}));
    const template = stringify({ type: "npm", packageJsonPath, packageManager: await this.packageManager(packageJsonPath), runConfigurations, ...(runConfigurations[0] ? { selectedRunConfigurationId: runConfigurations[0].id } : {}) });
    return { path: npmConfigurationPath, content: template, template };
  }
  async saveConfiguration(content: string, expectedRevision?: unknown) {
    const options = parseNpmConfiguration(content);
    if (!await this.manifest(options.packageJsonPath)) throw new CoreError("INVALID_REQUEST", `${options.packageJsonPath} is missing or is not valid JSON`);
    const saved = await this.write(options, expectedRevision as FileRevision | undefined);
    return { content: saved.content, revision: saved.revision, options: await this.options() };
  }
  async check() { return []; }

  async listRunTargets() { return Object.keys((await this.manifest((await this.settings())?.options.packageJsonPath))?.scripts ?? {}).map((script) => ({ id: script, name: `npm run ${script}` })); }

  private async update(change: (options: NpmProjectOptions) => NpmProjectOptions): Promise<LanguageExtra> {
    const settings = await this.requireSettings();
    await this.write(change(settings.options), settings.revision);
    return this.options();
  }
  async addRunConfiguration(name: string, target: string): Promise<LanguageExtra> {
    const settings = await this.requireSettings();
    const scripts = (await this.manifest(settings.options.packageJsonPath))?.scripts ?? {};
    if (!scripts[target]) throw new CoreError("INVALID_REQUEST", `${settings.options.packageJsonPath} has no '${target}' script`);
    const taken = new Set(settings.options.runConfigurations.map((item) => item.id));
    let id = slug(name); for (let n = 2; taken.has(id); n++) id = `${slug(name)}-${n}`;
    const created = validateNpmRunConfiguration({ id, name, script: target });
    return this.update((options) => ({ ...options, runConfigurations: [...options.runConfigurations, created], selectedRunConfigurationId: options.selectedRunConfigurationId ?? id }));
  }
  async selectRunConfiguration(id: string): Promise<LanguageExtra> {
    return this.update((options) => {
      if (!options.runConfigurations.some((item) => item.id === id)) throw new CoreError("INVALID_REQUEST", `Unknown run configuration '${id}'`);
      return { ...options, selectedRunConfigurationId: id };
    });
  }
  async removeRunConfiguration(id: string): Promise<LanguageExtra> {
    return this.update((options) => {
      if (!options.runConfigurations.some((item) => item.id === id)) throw new CoreError("INVALID_REQUEST", `Unknown run configuration '${id}'`);
      const runConfigurations = options.runConfigurations.filter((item) => item.id !== id);
      const { selectedRunConfigurationId, ...rest } = options;
      const selected = selectedRunConfigurationId === id ? runConfigurations[0]?.id : selectedRunConfigurationId;
      return { ...rest, runConfigurations, ...(selected ? { selectedRunConfigurationId: selected } : {}) };
    });
  }

  async build(): Promise<void> {
    const settings = await this.settings();
    await this.launch(settings?.options, { id: "build", name: "build", script: "build" }, true);
  }
  async run(): Promise<void> {
    const settings = await this.settings();
    const selected = settings?.options.runConfigurations.find((item) => item.id === settings.options.selectedRunConfigurationId);
    // Without a selected configuration, keep the plain `start` script behaviour.
    // Servers outlive any request: resolve once the process has started and report its end through the exit event.
    await this.launch(settings?.options, selected ?? { id: "start", name: "start", script: "start" }, false);
  }

  private async launch(options: NpmProjectOptions | undefined, config: NpmRunConfiguration, untilExit: boolean): Promise<void> {
    const packageJsonPath = options?.packageJsonPath ?? DEFAULT_PACKAGE_JSON;
    const scripts = (await this.manifest(packageJsonPath))?.scripts ?? {};
    if (!scripts[config.script]) throw new CoreError("INVALID_REQUEST", `${packageJsonPath} has no '${config.script}' script`);
    if (this.process) throw new CoreError("INVALID_REQUEST", "A Node.js process is already running");
    const directory = path.posix.normalize(config.workingDirectory ?? path.posix.dirname(packageJsonPath));
    const cwd = directory === "." ? this.filesystem.getWorkspace() : await this.filesystem.resolveExisting(directory);
    const fileEnvironment = config.environmentFile ? parseEnv((await this.filesystem.read(config.environmentFile)).content) : {};
    const manager = options?.packageManager ?? "npm";
    const args = ["run", config.script, ...(config.arguments?.length ? (manager === "npm" ? ["--", ...config.arguments] : config.arguments) : [])];
    const env: NodeJS.ProcessEnv = { ...process.env, ...fileEnvironment, ...config.environment };
    if (config.nodeOptions?.length) env.NODE_OPTIONS = [env.NODE_OPTIONS, ...config.nodeOptions].filter(Boolean).join(" ");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.executable(options), args, { cwd, env, detached: process.platform !== "win32" });
      this.process = child;
      child.stdout.on("data", (chunk: Buffer) => this.events.output(chunk.toString(), "stdout"));
      child.stderr.on("data", (chunk: Buffer) => this.events.output(chunk.toString(), "stderr"));
      child.on("error", (error) => { this.process = undefined; reject(error); });
      child.on("spawn", () => { if (!untilExit) resolve(); });
      child.on("close", (code, signal) => { this.process = undefined; this.events.exit(code, signal); resolve(); });
    });
  }
  /** npm starts the script as a child, so the whole process tree is signalled, not just npm. */
  stop(): void {
    const child = this.process;
    if (!child?.pid) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => child.kill());
    else try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
  }

  async setBreakpoints(): Promise<never> { throw unsupported("debugging"); }
  async startDebug(): Promise<never> { throw unsupported("debugging"); }
  async debugVariables(): Promise<never> { throw unsupported("debugging"); }
  debugCommand(): never { throw unsupported("debugging"); }
  async applyChanges(): Promise<never> { throw unsupported("debugging"); }
  languageServer() { return undefined; }
  validateExtra(kind: "breakpoint" | "runConfiguration" | "load", extra: unknown): LanguageExtra {
    const record = (extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}) as LanguageExtra;
    if (kind === "load" && record.packageJsonPath !== undefined) validatePackageJsonPath(record.packageJsonPath);
    if (kind === "runConfiguration") validateNpmRunConfiguration(record);
    return record;
  }
  async dispose(): Promise<void> { this.stop(); this.process = undefined; }
}
