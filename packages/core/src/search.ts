import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SearchMatchContext, SearchResult } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const MAX_RESULTS = 500;
const CONTEXT_LINES = 2;
const MAX_PREVIEW_LENGTH = 300;
const MAX_CONTEXT_LINE_LENGTH = 200;

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
      try { content = (await this.filesystem.read(relativePath)).content; } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]!;
        const haystack = matchCase ? line : line.toLocaleLowerCase();
        let column = haystack.indexOf(needle);
        while (column >= 0) {
          const preview = line.trim();
          matches.push({
            path: relativePath,
            line: lineIndex + 1,
            column: column + 1,
            preview: preview.slice(0, MAX_PREVIEW_LENGTH),
            previewTruncated: preview.length > MAX_PREVIEW_LENGTH,
            context: this.contextFor(lines, lineIndex)
          });
          if (matches.length >= MAX_RESULTS) return { matches, truncated: true };
          column = haystack.indexOf(needle, column + needle.length);
        }
      }
    }
    return { matches, truncated: false };
  }

  private contextFor(lines: string[], lineIndex: number): SearchMatchContext {
    const line = (index: number) => ({ line: index + 1, text: lines[index]!.slice(0, MAX_CONTEXT_LINE_LENGTH), truncated: lines[index]!.length > MAX_CONTEXT_LINE_LENGTH });
    const beforeStart = Math.max(0, lineIndex - CONTEXT_LINES);
    const afterEnd = Math.min(lines.length, lineIndex + CONTEXT_LINES + 1);
    return {
      before: Array.from({ length: lineIndex - beforeStart }, (_, offset) => line(beforeStart + offset)),
      after: Array.from({ length: afterEnd - lineIndex - 1 }, (_, offset) => line(lineIndex + offset + 1)),
      truncatedBefore: beforeStart > 0,
      truncatedAfter: afterEnd < lines.length
    };
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
