import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { FileRevision, FileTreeNode, FilesystemDeletePreview, FilesystemDeleteResult, FilesystemSnapshotEntry, FilesystemTransferKind, FilesystemTransferPreflight, FilesystemTransferRequest, FilesystemTransferResult } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

const execFileAsync = promisify(execFile);

export const MAX_FILE_SIZE = 2 * 1024 * 1024;
const TRASH_DIRECTORY = ".vibe-trash";

export class WorkspaceFileSystem {
  private workspace?: string;

  async open(workspacePath: string, includeIgnored = false): Promise<FileTreeNode[]> {
    if (!path.isAbsolute(workspacePath)) {
      throw new CoreError("WORKSPACE_NOT_FOUND", "Workspace path must be absolute");
    }
    try {
      const info = await stat(workspacePath);
      if (!info.isDirectory()) throw new Error("not a directory");
      this.workspace = await realpath(workspacePath);
      return await this.listTree(includeIgnored);
    } catch (error) {
      this.workspace = undefined;
      if (error instanceof CoreError) throw error;
      throw new CoreError("WORKSPACE_NOT_FOUND", `Workspace does not exist or is not a directory: ${workspacePath}`);
    }
  }

  getWorkspace(): string {
    if (!this.workspace) throw new CoreError("WORKSPACE_NOT_OPEN", "Open a workspace first");
    return this.workspace;
  }

  async listTree(includeIgnored = false): Promise<FileTreeNode[]> {
    const root = this.getWorkspace();
    if (!includeIgnored) {
      const tracked = await listGitPaths(root);
      if (tracked) {
        const directories = await listGitDirectories(root);
        return buildTreeFromPaths([...tracked, ...directories], directories);
      }
    }
    return this.walkDirectory(root, "");
  }

  /**
   * Resolves only watcher-affected paths.  This deliberately does not walk the
   * workspace: a watcher burst must never turn into a repository-sized transfer.
   */
  async snapshot(relativePaths: string[]): Promise<FilesystemSnapshotEntry[]> {
    if (relativePaths.length > 256) throw new CoreError("INVALID_REQUEST", "Snapshot is limited to 256 paths");
    return Promise.all([...new Set(relativePaths)].map(async (relativePath) => {
      const target = this.validateRelative(relativePath);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) await this.resolveExisting(relativePath);
        return { path: relativePath, type: info.isDirectory() ? "directory" : "file" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: relativePath };
        throw error;
      }
    }));
  }

  async read(relativePath: string): Promise<{ content: string; revision: FileRevision }> {
    const target = await this.resolveExisting(relativePath);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new CoreError("READ_FAILED", "Path is not a file");
      if (info.size > MAX_FILE_SIZE) throw new CoreError("FILE_TOO_LARGE", `File exceeds ${MAX_FILE_SIZE} byte limit`);
      const buffer = await readFile(target);
      if (buffer.includes(0)) throw new CoreError("BINARY_FILE", "Binary files cannot be opened");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return { content, revision: this.revision(info, buffer) };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("FILE_NOT_FOUND", `File not found: ${relativePath}`);
      if (error instanceof TypeError) throw new CoreError("BINARY_FILE", "File is not valid UTF-8 text");
      throw new CoreError("READ_FAILED", `Could not read file: ${relativePath}`);
    }
  }

  async write(relativePath: string, content: string, expectedRevision?: FileRevision, force = false, create = false): Promise<{ bytesWritten: number; revision: FileRevision }> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_SIZE) throw new CoreError("FILE_TOO_LARGE", `Content exceeds ${MAX_FILE_SIZE} byte limit`);
    if (create) {
      if (expectedRevision || force) throw new CoreError("INVALID_REQUEST", "A new file cannot have an expected revision or force flag");
      const target = await this.resolveNew(relativePath);
      try {
        await writeFile(target, content, { encoding: "utf8", flag: "wx" });
        const info = await stat(target); return { bytesWritten: bytes, revision: this.revision(info, Buffer.from(content, "utf8")) };
      } catch (error) { throw new CoreError("WRITE_FAILED", `Could not create file: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const target = await this.resolveExisting(relativePath);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new CoreError("WRITE_FAILED", "Path is not a file");
      const current = await readFile(target);
      const revision = this.revision(info, current);
      if (expectedRevision && !force && (expectedRevision.identity !== revision.identity || expectedRevision.version !== revision.version)) {
        throw new CoreError("FILE_CHANGED", `File changed outside the editor: ${relativePath}`);
      }
      await access(target, constants.W_OK);
      await writeFile(target, content, "utf8");
      const updated = await stat(target);
      return { bytesWritten: bytes, revision: this.revision(updated, Buffer.from(content, "utf8")) };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("FILE_NOT_FOUND", `File not found: ${relativePath}`);
      throw new CoreError("WRITE_FAILED", `Could not write file: ${relativePath}`);
    }
  }

  private revision(info: Awaited<ReturnType<typeof stat>>, content: Buffer): FileRevision {
    return { identity: `${info.dev}:${info.ino}`, version: createHash("sha256").update(content).digest("hex") };
  }

  async createFile(relativePath: string): Promise<void> {
    const target = await this.resolveNew(relativePath);
    try {
      await writeFile(target, "", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      throw new CoreError("WRITE_FAILED", `Could not create file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createDirectory(relativePath: string): Promise<void> {
    const target = await this.resolveNew(relativePath);
    try {
      await mkdir(target);
    } catch (error) {
      throw new CoreError("WRITE_FAILED", `Could not create directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async rename(relativePath: string, newRelativePath: string): Promise<void> {
    const source = await this.resolveMutationTarget(relativePath);
    const destination = await this.resolveNew(newRelativePath);
    try {
      await access(destination);
      throw new CoreError("WRITE_FAILED", `A file or directory already exists at: ${newRelativePath}`);
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CoreError("WRITE_FAILED", `Could not rename: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await rename(source, destination);
    } catch (error) {
      throw new CoreError("WRITE_FAILED", `Could not rename: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async transferPreflight(kind: FilesystemTransferKind, requests: FilesystemTransferRequest[], overwritePaths: string[] = [], openFiles: string[] = [], dirtyFiles: string[] = []): Promise<FilesystemTransferPreflight> {
    if ((kind !== "copy" && kind !== "move") || !Array.isArray(requests) || requests.length === 0 || requests.length > 100) throw new CoreError("INVALID_REQUEST", "A copy or move requires 1 to 100 items");
    const normalized = requests.map((item) => ({ source: item.source.replaceAll("\\", "/"), destination: item.destination.replaceAll("\\", "/") }));
    const overwrite = new Set(overwritePaths);
    const selected = new Set(normalized.map(({ source }) => source));
    const skipped: { source: string; reason: string }[] = [];
    const items: FilesystemTransferPreflight["items"] = [];
    const destinations = new Set<string>();
    for (const request of normalized) {
      if (!request.source || !request.destination || request.source === request.destination) { skipped.push({ source: request.source, reason: "Source and destination must be different" }); continue; }
      const ancestor = [...selected].find((candidate) => candidate !== request.source && request.source.startsWith(`${candidate}/`));
      if (ancestor) { skipped.push({ source: request.source, reason: `Already included by selected directory ${ancestor}` }); continue; }
      if (destinations.has(request.destination)) { skipped.push({ source: request.source, reason: `Another item uses destination ${request.destination}` }); continue; }
      const source = await this.resolveMutationTarget(request.source);
      const info = await lstat(source);
      if (info.isDirectory() && request.destination.startsWith(`${request.source}/`)) { skipped.push({ source: request.source, reason: "A directory cannot be copied or moved inside itself" }); continue; }
      const destination = this.validateRelative(request.destination);
      const parentName = path.posix.dirname(request.destination);
      const parent = parentName === "." ? this.getWorkspace() : await this.resolveExisting(parentName);
      let collision = false;
      try { await lstat(destination); collision = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const caseOnlyRename = kind === "move" && request.source.toLocaleLowerCase() === request.destination.toLocaleLowerCase() && request.source !== request.destination;
      if (caseOnlyRename) collision = false;
      const affected = (candidate: string) => candidate === request.source || info.isDirectory() && candidate.startsWith(`${request.source}/`);
      items.push({ ...request, type: info.isDirectory() ? "directory" : "file", collision, overwrite: collision && overwrite.has(request.destination), caseOnlyRename, crossDevice: kind === "move" && info.dev !== (await stat(parent)).dev, openFiles: openFiles.filter(affected), dirtyFiles: dirtyFiles.filter(affected) });
      destinations.add(request.destination);
    }
    const allOpen = [...new Set(items.flatMap((item) => item.openFiles))]; const allDirty = [...new Set(items.flatMap((item) => item.dirtyFiles))];
    return { kind, items, skipped, collisions: items.filter((item) => item.collision).length, overwrites: items.filter((item) => item.overwrite).length, caseOnlyRenames: items.filter((item) => item.caseOnlyRename).length, crossDeviceMoves: items.filter((item) => item.crossDevice).length, openFiles: allOpen, dirtyFiles: allDirty, confirmationRequired: items.some((item) => item.collision || item.caseOnlyRename || item.crossDevice) || skipped.length > 0 || allOpen.length > 0 || allDirty.length > 0 };
  }

  async transferApply(kind: FilesystemTransferKind, requests: FilesystemTransferRequest[], overwritePaths: string[] = [], openFiles: string[] = [], dirtyFiles: string[] = [], confirmed = false): Promise<FilesystemTransferResult> {
    const preview = await this.transferPreflight(kind, requests, overwritePaths, openFiles, dirtyFiles);
    if (preview.dirtyFiles.length) throw new CoreError("WRITE_FAILED", `Save or discard changes before ${kind === "move" ? "moving" : "overwriting"}: ${preview.dirtyFiles.join(", ")}`);
    if (preview.items.some((item) => item.collision && !item.overwrite)) throw new CoreError("WRITE_FAILED", "Destination collisions require explicit overwrite selection");
    if (preview.confirmationRequired && !confirmed) throw new CoreError("INVALID_REQUEST", "Confirm the current transfer preflight before applying it");
    const completed: FilesystemTransferRequest[] = []; const failures: FilesystemTransferResult["failures"] = preview.skipped.map((item) => ({ source: item.source, destination: requests.find((request) => request.source === item.source)?.destination ?? "", message: item.reason }));
    for (const item of preview.items) {
      const temporaryName = `.vibe-transfer-${randomUUID()}`; const destination = this.validateRelative(item.destination); const parent = path.dirname(destination); const temporary = path.join(parent, temporaryName); const backup = `${temporary}.backup`;
      try {
        const source = await this.resolveMutationTarget(item.source);
        if (item.caseOnlyRename) {
          await rename(source, temporary);
          try { await rename(temporary, destination); } catch (error) { await rename(temporary, source).catch(() => undefined); throw error; }
          completed.push({ source: item.source, destination: item.destination });
          continue;
        }
        await cp(source, temporary, { recursive: item.type === "directory", errorOnExist: true, force: false });
        if (item.collision) await rename(destination, backup);
        try { await rename(temporary, destination); } catch (error) { if (item.collision) await rename(backup, destination).catch(() => undefined); throw error; }
        if (item.collision) await rm(backup, { recursive: true, force: true });
        if (kind === "move") await rm(source, { recursive: true });
        completed.push({ source: item.source, destination: item.destination });
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        failures.push({ source: item.source, destination: item.destination, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { completed, failures };
  }

  async previewDelete(relativePath: string): Promise<FilesystemDeletePreview> {
    const target = await this.resolveMutationTarget(relativePath);
    const info = await lstat(target);
    const children: string[] = [];
    if (info.isDirectory()) await this.collectChildren(target, relativePath, children);
    return { path: relativePath, type: info.isDirectory() ? "directory" : "file", children: children.slice(0, 100), childCount: children.length, recoverable: true };
  }

  async delete(relativePath: string, permanent = false): Promise<FilesystemDeleteResult> {
    const target = await this.resolveMutationTarget(relativePath);
    if (permanent) {
      try { await rm(target, { recursive: true }); }
      catch (error) { throw new CoreError("WRITE_FAILED", `Could not permanently delete ${relativePath}: ${error instanceof Error ? error.message : String(error)}`); }
      return { path: relativePath, permanentlyDeleted: true };
    }
    const recoveryId = randomUUID();
    const trashRoot = path.join(this.getWorkspace(), TRASH_DIRECTORY);
    try {
      await mkdir(trashRoot, { recursive: true });
      await rename(target, path.join(trashRoot, recoveryId));
      await writeFile(path.join(trashRoot, `${recoveryId}.json`), JSON.stringify({ path: relativePath }), { encoding: "utf8", flag: "wx" });
      return { path: relativePath, recoveryId, permanentlyDeleted: false };
    } catch (error) {
      throw new CoreError("WRITE_FAILED", `Could not move ${relativePath} to workspace trash: ${error instanceof Error ? error.message : String(error)}. Retry with permanent delete only if recovery is not required.`);
    }
  }

  async restore(recoveryId: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(recoveryId)) throw new CoreError("INVALID_REQUEST", "Invalid recovery ID");
    const trashRoot = path.join(this.getWorkspace(), TRASH_DIRECTORY);
    try {
      const metadataPath = path.join(trashRoot, `${recoveryId}.json`);
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { path?: unknown };
      if (typeof metadata.path !== "string") throw new Error("invalid recovery metadata");
      const destination = await this.resolveNew(metadata.path);
      try { await access(destination); throw new CoreError("WRITE_FAILED", `Cannot restore because a path already exists at ${metadata.path}`); }
      catch (error) { if (error instanceof CoreError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(path.join(trashRoot, recoveryId), destination);
      await rm(metadataPath);
      return metadata.path;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("WRITE_FAILED", `Could not restore deleted path: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private validateRelative(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new CoreError("PATH_OUTSIDE_WORKSPACE", "Path must be relative to the workspace");
    }
    if (relativePath.split(/[\\/]/).includes(TRASH_DIRECTORY)) throw new CoreError("PATH_OUTSIDE_WORKSPACE", "The workspace trash is reserved");
    const root = this.getWorkspace();
    const resolved = path.resolve(root, relativePath);
    if (resolved === root || !resolved.startsWith(root + path.sep)) {
      throw new CoreError("PATH_OUTSIDE_WORKSPACE", "Path escapes the workspace");
    }
    return resolved;
  }

  async resolveExisting(relativePath: string): Promise<string> {
    const candidate = this.validateRelative(relativePath);
    try {
      const resolved = await realpath(candidate);
      const root = this.getWorkspace();
      if (!resolved.startsWith(root + path.sep)) {
        throw new CoreError("PATH_OUTSIDE_WORKSPACE", "Symbolic link points outside the workspace");
      }
      return resolved;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("FILE_NOT_FOUND", `File not found: ${relativePath}`);
      throw new CoreError("READ_FAILED", `Could not resolve path: ${relativePath}`);
    }
  }

  private async resolveMutationTarget(relativePath: string): Promise<string> {
    const candidate = this.validateRelative(relativePath);
    try {
      await lstat(candidate);
      const resolved = await realpath(candidate);
      const root = this.getWorkspace();
      if (!resolved.startsWith(root + path.sep)) throw new CoreError("PATH_OUTSIDE_WORKSPACE", "Symbolic link points outside the workspace");
      return candidate;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("FILE_NOT_FOUND", `File not found: ${relativePath}`);
      throw new CoreError("READ_FAILED", `Could not resolve path: ${relativePath}`);
    }
  }

  private async resolveNew(relativePath: string): Promise<string> {
    const candidate = this.validateRelative(relativePath);
    const parent = path.dirname(candidate);
    try {
      const resolvedParent = await realpath(parent);
      const root = this.getWorkspace();
      if (resolvedParent !== root && !resolvedParent.startsWith(root + path.sep)) throw new CoreError("PATH_OUTSIDE_WORKSPACE", "Path escapes the workspace");
      const info = await stat(resolvedParent);
      if (!info.isDirectory()) throw new CoreError("WRITE_FAILED", "Parent path is not a directory");
      return candidate;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("FILE_NOT_FOUND", `Parent directory not found: ${relativePath}`);
      throw new CoreError("WRITE_FAILED", `Could not resolve parent directory: ${relativePath}`);
    }
  }

  private async walkDirectory(absoluteDir: string, relativeDir: string): Promise<FileTreeNode[]> {
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (!relativeDir && entry.name === TRASH_DIRECTORY) continue;
      const relative = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
      const absolute = path.join(absoluteDir, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        try {
          const resolved = await realpath(absolute);
          const root = this.getWorkspace();
          if (!resolved.startsWith(root + path.sep)) continue;
        } catch { continue; }
      }
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, path: relative, type: "directory", children: await this.walkDirectory(absolute, relative) });
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: relative, type: "file" });
      }
    }
    return nodes;
  }

  private async collectChildren(absolute: string, relative: string, output: string[]): Promise<void> {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const childRelative = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
      output.push(childRelative);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await this.collectChildren(path.join(absolute, entry.name), childRelative, output);
    }
  }
}

async function listGitPaths(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    return stdout.split("\0").filter((entry) => entry.length > 0);
  } catch {
    return undefined;
  }
}

async function listGitDirectories(root: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "--directory", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    return new Set(stdout.split("\0").filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)));
  } catch {
    return new Set();
  }
}

function buildTreeFromPaths(paths: string[], directoryPaths = new Set<string>()): FileTreeNode[] {
  const rootNodes: FileTreeNode[] = [];
  const directories = new Map<string, FileTreeNode[]>([["", rootNodes]]);
  const seen = new Set<string>();
  for (const entry of paths) {
    if (entry === TRASH_DIRECTORY || entry.startsWith(`${TRASH_DIRECTORY}/`)) continue;
    const segments = entry.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    let relative = "";
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      const parent = directories.get(relative)!;
      relative = relative ? `${relative}/${name}` : name;
      if (seen.has(relative)) continue;
      seen.add(relative);
      if (index === segments.length - 1 && !directoryPaths.has(relative)) {
        parent.push({ name, path: relative, type: "file" });
      } else {
        const children: FileTreeNode[] = [];
        parent.push({ name, path: relative, type: "directory", children });
        directories.set(relative, children);
      }
    }
  }
  sortTree(rootNodes);
  return rootNodes;
}

function sortTree(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
  for (const node of nodes) if (node.children) sortTree(node.children);
}
