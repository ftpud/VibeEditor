import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SearchResult } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const MAX_RESULTS = 500;

export class WorkspaceSearch {
  constructor(private readonly filesystem: WorkspaceFileSystem) {}

  async search(query: string, scope: string, matchCase: boolean): Promise<{ matches: SearchResult[]; truncated: boolean }> {
    if (!query || query.length > 200 || typeof matchCase !== "boolean") throw new CoreError("INVALID_REQUEST", "Search query must contain 1 to 200 characters");
    const root = this.filesystem.getWorkspace();
    const absoluteScope = scope ? await this.filesystem.resolveExisting(scope) : root;
    const info = await stat(absoluteScope);
    const files = info.isFile() ? [absoluteScope] : await this.collectFiles(absoluteScope);
    const matches: SearchResult[] = [];
    const needle = matchCase ? query : query.toLocaleLowerCase();
    for (const absoluteFile of files) {
      const relativePath = path.relative(root, absoluteFile).split(path.sep).join("/");
      let content: string;
      try { content = await this.filesystem.read(relativePath); } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]!;
        const haystack = matchCase ? line : line.toLocaleLowerCase();
        const column = haystack.indexOf(needle);
        if (column < 0) continue;
        matches.push({ path: relativePath, line: lineIndex + 1, column: column + 1, preview: line.trim().slice(0, 300) });
        if (matches.length >= MAX_RESULTS) return { matches, truncated: true };
      }
    }
    return { matches, truncated: false };
  }

  private async collectFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...await this.collectFiles(absolute));
      else if (entry.isFile()) files.push(absolute);
    }
    return files;
  }
}
