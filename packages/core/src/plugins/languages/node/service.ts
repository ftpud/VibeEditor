import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CoreError } from "../../../errors.js";
import type { LanguageDescriptor, LanguageExtra, LanguageProjectNode, LanguageService, LanguageServiceEvents } from "../../../language/service.js";

/**
 * Minimal second built-in language: Node projects described by `package.json`.
 * It supports project tree, tool check, build and run through npm scripts, and
 * deliberately advertises no debug, LSP or configuration capability, so it
 * exercises the contract's "unsupported" paths.
 */
export const NODE_DESCRIPTOR: LanguageDescriptor = {
  id: "node", name: "Node.js", extensions: ["js", "mjs", "cjs", "ts", "mts", "cts"], projectMarkers: ["package.json"],
  capabilities: { projectTree: true, build: true, run: true, debug: false, lsp: false, workspaceSymbols: false, configuration: false }
};

const unsupported = (what: string) => new CoreError("INVALID_REQUEST", `Node.js does not support ${what}`);

export class NodeLanguageService implements LanguageService {
  readonly descriptor = NODE_DESCRIPTOR;
  private process?: ChildProcess;

  constructor(private readonly workspace: string, private readonly events: LanguageServiceEvents, private readonly npm = process.platform === "win32" ? "npm.cmd" : "npm") {}

  private async manifest(): Promise<{ scripts?: Record<string, string>; name?: string } | undefined> {
    try { return JSON.parse(await readFile(path.join(this.workspace, "package.json"), "utf8")); } catch { return undefined; }
  }

  async detect(): Promise<boolean> { return (await this.manifest()) !== undefined; }
  async load(): Promise<LanguageExtra> { return this.options(); }
  async options(): Promise<LanguageExtra> {
    const manifest = await this.manifest();
    if (!manifest) throw new CoreError("INVALID_REQUEST", "No package.json in this workspace");
    return { name: manifest.name ?? path.basename(this.workspace), scripts: Object.keys(manifest.scripts ?? {}) };
  }
  async projectTree(): Promise<LanguageProjectNode[]> { return (await this.detect()) ? [{ name: "package.json", path: "package.json", type: "file" }] : []; }
  async addSourceRoot(): Promise<void> { throw unsupported("source roots"); }
  async workspaceSymbols(): Promise<{ symbols: [] }> { throw unsupported("workspace symbols"); }
  async checkTools() { return [await this.checkNpm()]; }
  private checkNpm(): Promise<{ tool: string; executable: string; ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.npm, ["--version"], { cwd: this.workspace });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
      child.on("error", (error) => resolve({ tool: "npm", executable: this.npm, ok: false, message: error.message }));
      child.on("close", (code) => resolve({ tool: "npm", executable: this.npm, ok: code === 0, message: code === 0 ? out.trim() : `npm exited with ${code}` }));
    });
  }
  async readConfiguration(): Promise<never> { throw unsupported("configuration"); }
  async saveConfiguration(): Promise<never> { throw unsupported("configuration"); }
  async check() { return []; }

  async listRunTargets() { return Object.keys((await this.manifest())?.scripts ?? {}).map((script) => ({ id: script, name: `npm run ${script}` })); }
  async addRunConfiguration(): Promise<never> { throw unsupported("run configurations"); }
  async selectRunConfiguration(): Promise<never> { throw unsupported("run configurations"); }
  async build(): Promise<void> { await this.script("build"); }
  async run(): Promise<void> { await this.script("start"); }

  private async script(name: string): Promise<void> {
    const scripts = (await this.manifest())?.scripts ?? {};
    if (!scripts[name]) throw new CoreError("INVALID_REQUEST", `package.json has no '${name}' script`);
    if (this.process) throw new CoreError("INVALID_REQUEST", "A Node.js process is already running");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.npm, ["run", name], { cwd: this.workspace });
      this.process = child;
      child.stdout.on("data", (chunk: Buffer) => this.events.output(chunk.toString(), "stdout"));
      child.stderr.on("data", (chunk: Buffer) => this.events.output(chunk.toString(), "stderr"));
      child.on("error", (error) => { this.process = undefined; reject(error); });
      child.on("close", (code, signal) => { this.process = undefined; this.events.exit(code, signal); resolve(); });
    });
  }
  stop(): void { this.process?.kill(); }

  async setBreakpoints(): Promise<never> { throw unsupported("debugging"); }
  async startDebug(): Promise<never> { throw unsupported("debugging"); }
  async debugVariables(): Promise<never> { throw unsupported("debugging"); }
  debugCommand(): never { throw unsupported("debugging"); }
  async applyChanges(): Promise<never> { throw unsupported("debugging"); }
  languageServer() { return undefined; }
  validateExtra(_kind: "breakpoint" | "runConfiguration" | "load", extra: unknown): LanguageExtra { return (extra && typeof extra === "object" ? extra : {}) as LanguageExtra; }
  async dispose(): Promise<void> { this.process?.kill(); this.process = undefined; }
}
