import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileTreeNode } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

export const MAX_FILE_SIZE = 2 * 1024 * 1024;

export class WorkspaceFileSystem {
  private workspace?: string;

  async open(workspacePath: string): Promise<FileTreeNode[]> {
    if (!path.isAbsolute(workspacePath)) {
      throw new CoreError("WORKSPACE_NOT_FOUND", "Workspace path must be absolute");
    }
    try {
      const info = await stat(workspacePath);
      if (!info.isDirectory()) throw new Error("not a directory");
      this.workspace = await realpath(workspacePath);
      return await this.listTree();
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

  async listTree(): Promise<FileTreeNode[]> {
    const root = this.getWorkspace();
    return this.walkDirectory(root, "");
  }

  async read(relativePath: string): Promise<string> {
    const target = await this.resolveExisting(relativePath);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new CoreError("READ_FAILED", "Path is not a file");
      if (info.size > MAX_FILE_SIZE) throw new CoreError("FILE_TOO_LARGE", `File exceeds ${MAX_FILE_SIZE} byte limit`);
      const buffer = await readFile(target);
      if (buffer.includes(0)) throw new CoreError("BINARY_FILE", "Binary files cannot be opened");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return content;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("FILE_NOT_FOUND", `File not found: ${relativePath}`);
      if (error instanceof TypeError) throw new CoreError("BINARY_FILE", "File is not valid UTF-8 text");
      throw new CoreError("READ_FAILED", `Could not read file: ${relativePath}`);
    }
  }

  async write(relativePath: string, content: string): Promise<number> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_SIZE) throw new CoreError("FILE_TOO_LARGE", `Content exceeds ${MAX_FILE_SIZE} byte limit`);
    const target = await this.resolveExisting(relativePath);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new CoreError("WRITE_FAILED", "Path is not a file");
      await access(target, constants.W_OK);
      await writeFile(target, content, "utf8");
      return bytes;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("FILE_NOT_FOUND", `File not found: ${relativePath}`);
      throw new CoreError("WRITE_FAILED", `Could not write file: ${relativePath}`);
    }
  }

  private validateRelative(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new CoreError("PATH_OUTSIDE_WORKSPACE", "Path must be relative to the workspace");
    }
    const root = this.getWorkspace();
    const resolved = path.resolve(root, relativePath);
    if (resolved === root || !resolved.startsWith(root + path.sep)) {
      throw new CoreError("PATH_OUTSIDE_WORKSPACE", "Path escapes the workspace");
    }
    return resolved;
  }

  private async resolveExisting(relativePath: string): Promise<string> {
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

  private async walkDirectory(absoluteDir: string, relativeDir: string): Promise<FileTreeNode[]> {
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
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
}
