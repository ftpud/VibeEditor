import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ToolInstallation } from "@remote-ide/protocol";
import { serializedStateMutation } from "./root-mutation.js";

export type ToolId = string;
/** Fetches `url` into `file`, reporting downloaded bytes; returns the SHA-256 of what was written. */
export type Download = (url: string, file: string, progress: (received: number, total?: number) => void) => Promise<string>;
export type ToolSpec = {
  id: ToolId; name: string; description: string; version: string; requires?: ToolId[];
  /** Archive URL and expected SHA-256 for this Core host. */
  source(): Promise<{ url: string; sha256: string; format: "tar.gz" | "zip" }>;
  /** Archive members sit below one top-level directory. */
  stripRoot?: boolean;
  /** Relative path proving the installation is complete. */
  entry(): string;
};

const defaultDownload: Download = async (url, file, progress) => {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get("content-length")) || undefined;
  const hash = createHash("sha256");
  let received = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); received += chunk.length; progress(received, total); callback(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), meter, createWriteStream(file));
  return hash.digest("hex");
};
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));
  });
}
const extract = async (archive: string, format: "tar.gz" | "zip", target: string, stripRoot: boolean) => {
  if (format === "tar.gz") return run("tar", ["-xzf", archive, "-C", target, ...(stripRoot ? ["--strip-components=1"] : [])]);
  const unpacked = `${target}.zip`;
  await mkdir(unpacked, { recursive: true });
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", archive, unpacked]);
  const entries = await readdir(unpacked, { withFileTypes: true });
  const source = stripRoot && entries.length === 1 && entries[0]!.isDirectory() ? path.join(unpacked, entries[0]!.name) : unpacked;
  await rm(target, { recursive: true, force: true });
  await rename(source, target);
  await rm(unpacked, { recursive: true, force: true });
};
const registered: ToolSpec[] = [];
/** Plugins contribute the tools they need on the Core host; later registrations of the same id are ignored. */
export function registerTools(specs: readonly ToolSpec[]): void { for (const spec of specs) if (!registered.some((known) => known.id === spec.id)) registered.push(spec); }
type Current = { directory: string; version: string };

/**
 * Optional tools downloaded on demand into `~/.remote-ide/tools/<tool>/` on the
 * Core host. A download is verified and unpacked into a fresh directory and
 * published only when complete, so a failed attempt never replaces a working one.
 */
export class ToolInstallations {
  private readonly operations = new Map<ToolId, { status: "installing" | "removing"; done: Promise<void>; progress?: number }>();
  private readonly errors = new Map<ToolId, string>();
  constructor(private readonly root: () => string = () => process.env.REMOTE_IDE_TOOLS_DIR ?? path.join(os.homedir(), ".remote-ide", "tools"), private readonly download: Download = defaultDownload, private readonly fixedTools?: readonly ToolSpec[]) {}
  private get tools(): readonly ToolSpec[] { return this.fixedTools ?? registered; }

  private spec(id: string): ToolSpec {
    const spec = this.tools.find((tool) => tool.id === id);
    if (!spec) throw new Error(`Unknown tool '${id}'`);
    return spec;
  }
  private async current(spec: ToolSpec): Promise<Current | undefined> {
    const directory = path.join(this.root(), spec.id);
    try {
      const current = JSON.parse(await readFile(path.join(directory, "current.json"), "utf8")) as Current;
      if (typeof current.directory !== "string" || path.dirname(path.resolve(current.directory)) !== path.resolve(directory)) return undefined;
      await access(path.join(current.directory, spec.entry()));
      return current;
    } catch { return undefined; }
  }

  /** Installed directory of a tool, or undefined. */
  async directory(id: ToolId): Promise<string | undefined> { return (await this.current(this.spec(id)))?.directory; }
  /** Absolute path of a tool's entry file, or undefined when it is not installed. */
  async executable(id: ToolId): Promise<string | undefined> { const directory = await this.directory(id); return directory ? path.join(directory, this.spec(id).entry()) : undefined; }

  async list(): Promise<ToolInstallation[]> {
    return Promise.all(this.tools.map(async (spec) => {
      const current = await this.current(spec);
      const operation = this.operations.get(spec.id);
      const error = this.errors.get(spec.id);
      return {
        id: spec.id, name: spec.name, description: spec.description, availableVersion: spec.version,
        status: operation?.status ?? (current ? "installed" : "not_installed"),
        ...(spec.requires ? { requires: spec.requires } : {}),
        ...(current ? { version: current.version, location: current.directory } : {}),
        ...(operation?.progress !== undefined ? { progress: operation.progress } : {}),
        ...(error ? { error } : {})
      };
    }));
  }

  /** Installs (or updates to) this Core's pinned version, with missing prerequisites first. Conflicts throw synchronously. */
  install(id: string): Promise<void> {
    const spec = this.spec(id);
    return this.run(spec, "installing", async (directory) => {
      for (const required of spec.requires ?? []) if (!await this.current(this.spec(required))) await this.fetch(this.spec(required), path.join(this.root(), required), spec.id);
      const current = await this.current(spec);
      if (current?.version === spec.version) return;
      await this.fetch(spec, directory, spec.id);
      // Keep the previous installation: a running language server may still use it.
      const keep = new Set([path.basename((await this.current(spec))!.directory), ...(current ? [path.basename(current.directory)] : [])]);
      await Promise.all((await readdir(directory)).filter((name) => name.startsWith("installation-") && !keep.has(name)).map((name) => rm(path.join(directory, name), { recursive: true, force: true })));
    });
  }

  uninstall(id: string): Promise<void> {
    return this.run(this.spec(id), "removing", async (directory) => {
      await rm(path.join(directory, "current.json"), { force: true });
      const names = await readdir(directory).catch(() => [] as string[]);
      await Promise.all(names.filter((name) => name.startsWith("installation-")).map((name) => rm(path.join(directory, name), { recursive: true, force: true })));
    });
  }

  private async fetch(spec: ToolSpec, directory: string, reporter: ToolId): Promise<void> {
    await mkdir(directory, { recursive: true });
    const candidate = await mkdtemp(path.join(directory, "installation-"));
    try {
      const source = await spec.source();
      const archive = path.join(candidate, `download.${source.format}`);
      console.log(`[core] downloading ${spec.name} ${spec.version}`);
      const digest = await this.download(source.url, archive, (received, total) => { const operation = this.operations.get(reporter); if (operation && total) operation.progress = Math.min(99, Math.floor(received / total * 100)); });
      if (digest !== source.sha256) throw new Error(`checksum mismatch: expected ${source.sha256}, received ${digest}`);
      const target = path.join(candidate, "files");
      await mkdir(target, { recursive: true });
      await extract(archive, source.format, target, !!spec.stripRoot);
      await rm(archive, { force: true });
      // Publish the unpacked tree itself, so the published directory contains no download leftovers.
      const published = `${candidate}-ready`;
      await rename(target, published);
      await rm(candidate, { recursive: true, force: true });
      await access(path.join(published, spec.entry()));
      const marker = path.join(directory, `current.${path.basename(published)}.json`);
      await writeFile(marker, JSON.stringify({ directory: path.resolve(published), version: spec.version }));
      await rename(marker, path.join(directory, "current.json"));
      console.log(`[core] ${spec.name} ${spec.version} is installed`);
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      await rm(`${candidate}-ready`, { recursive: true, force: true });
      throw new Error(`Could not install ${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private run(spec: ToolSpec, status: "installing" | "removing", operation: (directory: string) => Promise<void>): Promise<void> {
    const active = this.operations.get(spec.id);
    if (active) { if (active.status === status) return active.done; throw new Error("Another change is already running for this tool"); }
    const directory = path.join(this.root(), spec.id);
    this.errors.delete(spec.id);
    const done = serializedStateMutation(path.join(directory, "installation"), () => operation(directory))
      .catch((error: unknown) => { this.errors.set(spec.id, error instanceof Error ? error.message : String(error)); throw error; })
      .finally(() => { this.operations.delete(spec.id); });
    this.operations.set(spec.id, { status, done });
    return done;
  }
}

export const toolInstallations = new ToolInstallations();
