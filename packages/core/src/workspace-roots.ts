import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceRoot } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

type StoredRoots = { version: 1; roots: WorkspaceRoot[] };

export class WorkspaceRootRegistry {
  private roots: WorkspaceRoot[] = [];
  private constructor(private readonly primaryPath: string, private readonly stateFile: string) {}

  static async open(primaryPath: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR): Promise<WorkspaceRootRegistry> {
    const primary = await validateDirectory(primaryPath);
    const key = createHash("sha256").update(primary).digest("hex").slice(0, 20);
    const directory = stateDirectory ? path.resolve(stateDirectory) : path.join(os.homedir(), ".remote-ide", "workspace-groups");
    const registry = new WorkspaceRootRegistry(primary, path.join(directory, `roots-${key}.json`));
    await registry.load();
    return registry;
  }

  list(): WorkspaceRoot[] { return this.roots.map((root) => ({ ...root })); }
  primary(): WorkspaceRoot { return this.roots.find((root) => root.primary)!; }
  get(id: string): WorkspaceRoot {
    const root = this.roots.find((item) => item.id === id);
    if (!root) throw new CoreError("WORKSPACE_NOT_FOUND", `Unknown workspace root: ${id}`);
    return { ...root };
  }
  async add(inputPath: string, inputAlias: string): Promise<WorkspaceRoot> {
    const resolved = await validateDirectory(inputPath);
    const alias = normalizeAlias(inputAlias);
    if (this.roots.some((root) => root.path === resolved)) throw new CoreError("INVALID_REQUEST", "That remote directory is already registered");
    if (this.roots.some((root) => root.alias.toLocaleLowerCase() === alias.toLocaleLowerCase())) throw new CoreError("INVALID_REQUEST", "That root alias is already registered");
    const root = { id: stableId(resolved), alias, path: resolved, primary: false };
    this.roots.push(root); await this.save(); return { ...root };
  }
  async remove(id: string): Promise<void> {
    const root = this.get(id);
    if (root.primary) throw new CoreError("INVALID_REQUEST", "The primary root cannot be removed");
    this.roots = this.roots.filter((item) => item.id !== id);
    await this.save();
  }
  private async load(): Promise<void> {
    const primary: WorkspaceRoot = { id: stableId(this.primaryPath), alias: path.basename(this.primaryPath), path: this.primaryPath, primary: true };
    try {
      const stored = JSON.parse(await readFile(this.stateFile, "utf8")) as StoredRoots;
      if (stored.version !== 1 || !Array.isArray(stored.roots)) throw new Error("invalid root registry");
      const loaded: WorkspaceRoot[] = [primary];
      for (const item of stored.roots) {
        if (item.primary || item.id !== stableId(item.path)) continue;
        try { loaded.push({ id: item.id, alias: normalizeAlias(item.alias), path: await validateDirectory(item.path), primary: false }); } catch { /* unavailable roots remain unregistered */ }
      }
      this.roots = deduplicate(loaded);
    } catch { this.roots = [primary]; }
  }
  private async save(): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify({ version: 1, roots: this.roots } satisfies StoredRoots, null, 2), { mode: 0o600 });
  }
}

function stableId(value: string): string { return `root_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`; }
function normalizeAlias(value: string): string {
  const alias = value.trim();
  if (!alias || alias === "." || alias === ".." || /[\\/\0]/.test(alias)) throw new CoreError("INVALID_REQUEST", "Root alias must be a non-empty name without path separators");
  return alias;
}
async function validateDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new CoreError("INVALID_REQUEST", "Workspace root must be an absolute remote path");
  let resolved: string;
  try { resolved = await realpath(value); if (!(await stat(resolved)).isDirectory()) throw new Error("not directory"); }
  catch { throw new CoreError("WORKSPACE_NOT_FOUND", `Remote workspace directory is unavailable: ${value}`); }
  return resolved;
}
function deduplicate(roots: WorkspaceRoot[]): WorkspaceRoot[] {
  const aliases = new Set<string>(), paths = new Set<string>();
  return roots.filter((root) => { const alias = root.alias.toLocaleLowerCase(); if (aliases.has(alias) || paths.has(root.path)) return false; aliases.add(alias); paths.add(root.path); return true; });
}
