import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FileRevision, SearchMatchContext, SearchReplaceApplyResult, SearchReplacePreview, SearchResult } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 500; const MAX_PREVIEW_FILES = 100; const CONTEXT_LINES = 2; const MAX_PREVIEW_LENGTH = 300; const MAX_CONTEXT_LINE_LENGTH = 200;
type Filters = { include?: string; exclude?: string };
type Replacement = { files: { path: string; revision: FileRevision; content: string }[] };

export class WorkspaceSearch {
  private readonly replacements = new Map<string, Replacement>();
  constructor(private readonly filesystem: WorkspaceFileSystem) {}

  async search(query: string, scope: string, matchCase: boolean, filters: Filters = {}): Promise<{ matches: SearchResult[]; truncated: boolean }> {
    this.validate(query, matchCase, filters);
    const root = this.filesystem.getWorkspace(); const absoluteScope = scope ? await this.filesystem.resolveExisting(scope) : root; const info = await stat(absoluteScope);
    const files = await this.filesForScope(root, absoluteScope, info.isFile(), filters); const matches: SearchResult[] = []; const needle = matchCase ? query : query.toLocaleLowerCase();
    for (const relativePath of files) {
      let content: string; try { content = (await this.filesystem.read(relativePath)).content; } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]!; const haystack = matchCase ? line : line.toLocaleLowerCase(); let column = haystack.indexOf(needle);
        while (column >= 0) { const preview = line.trim(); matches.push({ path: relativePath, line: lineIndex + 1, column: column + 1, preview: preview.slice(0, MAX_PREVIEW_LENGTH), previewTruncated: preview.length > MAX_PREVIEW_LENGTH, context: this.contextFor(lines, lineIndex) }); if (matches.length >= MAX_RESULTS) return { matches, truncated: true }; column = haystack.indexOf(needle, column + needle.length); }
      }
    }
    return { matches, truncated: false };
  }

  async previewReplace(query: string, replacement: string, scope: string, matchCase: boolean, filters: Filters = {}): Promise<SearchReplacePreview> {
    if (typeof replacement !== "string" || replacement.length > 10_000) throw new CoreError("INVALID_REQUEST", "Replacement must contain at most 10000 characters");
    const result = await this.search(query, scope, matchCase, filters); const grouped = new Map<string, SearchResult[]>(); for (const match of result.matches) grouped.set(match.path, [...(grouped.get(match.path) ?? []), match]);
    const files: SearchReplacePreview["files"] = []; const stored: Replacement["files"] = [];
    for (const [filePath, matches] of [...grouped].slice(0, MAX_PREVIEW_FILES)) {
      const file = await this.filesystem.read(filePath); const lines = file.content.split(/\r?\n/); const occurrences = matches.map((match) => { const before = lines[match.line - 1] ?? ""; const start = match.column - 1; const after = `${before.slice(0, start)}${replacement}${before.slice(start + query.length)}`; return { line: match.line, column: match.column, before: before.slice(0, MAX_PREVIEW_LENGTH), after: after.slice(0, MAX_PREVIEW_LENGTH) }; });
      const content = matchCase ? file.content.split(query).join(replacement) : replaceInsensitive(file.content, query.toLocaleLowerCase(), query.length, replacement); files.push({ path: filePath, revision: file.revision, occurrences }); stored.push({ path: filePath, revision: file.revision, content });
    }
    const id = randomUUID(); this.replacements.set(id, { files: stored }); return { id, files, truncated: result.truncated || grouped.size > MAX_PREVIEW_FILES };
  }

  async applyReplace(previewId: string, confirmed: boolean): Promise<SearchReplaceApplyResult> {
    if (!confirmed) throw new CoreError("INVALID_REQUEST", "Batch replacement requires explicit confirmation"); const preview = this.replacements.get(previewId); this.replacements.delete(previewId); if (!preview) throw new CoreError("INVALID_REQUEST", "Replacement preview is unavailable; create a new preview");
    const applied: SearchReplaceApplyResult["applied"] = []; const failures: SearchReplaceApplyResult["failures"] = [];
    for (const file of preview.files) try { const written = await this.filesystem.write(file.path, file.content, file.revision); applied.push({ path: file.path, revision: written.revision }); } catch (error) { const message = error instanceof Error ? error.message : "Could not replace file"; failures.push({ path: file.path, code: message.split(":", 1)[0] ?? "WRITE_FAILED", message }); }
    return { applied, failures };
  }

  private validate(query: string, matchCase: boolean, filters: Filters): void { if (!query || query.length > 200 || typeof matchCase !== "boolean") throw new CoreError("INVALID_REQUEST", "Search query must contain 1 to 200 characters"); for (const value of [filters.include, filters.exclude]) if (value !== undefined && (typeof value !== "string" || value.length > 200)) throw new CoreError("INVALID_REQUEST", "Search glob must contain at most 200 characters"); }
  private async filesForScope(root: string, scope: string, isFile: boolean, filters: Filters): Promise<string[]> { const scopePath = path.relative(root, scope).split(path.sep).join("/"); const visible = await gitVisiblePaths(root); if (visible) return [...visible].filter((relative) => (isFile ? relative === scopePath : !scopePath || relative.startsWith(`${scopePath}/`)) && matchesFilters(relative, filters)); const all = isFile ? [scope] : await this.collectFiles(scope); return all.map((absolute) => path.relative(root, absolute).split(path.sep).join("/")).filter((relative) => matchesFilters(relative, filters)); }
  private contextFor(lines: string[], lineIndex: number): SearchMatchContext { const line = (index: number) => ({ line: index + 1, text: lines[index]!.slice(0, MAX_CONTEXT_LINE_LENGTH), truncated: lines[index]!.length > MAX_CONTEXT_LINE_LENGTH }); const beforeStart = Math.max(0, lineIndex - CONTEXT_LINES); const afterEnd = Math.min(lines.length, lineIndex + CONTEXT_LINES + 1); return { before: Array.from({ length: lineIndex - beforeStart }, (_, offset) => line(beforeStart + offset)), after: Array.from({ length: afterEnd - lineIndex - 1 }, (_, offset) => line(lineIndex + offset + 1)), truncatedBefore: beforeStart > 0, truncatedAfter: afterEnd < lines.length }; }
  private async collectFiles(directory: string): Promise<string[]> { const files: string[] = []; for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name === ".git" || entry.name === ".vibe-trash") continue; const absolute = path.join(directory, entry.name); if (entry.isSymbolicLink()) continue; if (entry.isDirectory()) files.push(...await this.collectFiles(absolute)); else if (entry.isFile()) files.push(absolute); } return files; }
}
function replaceInsensitive(content: string, needle: string, length: number, replacement: string): string { const lower = content.toLocaleLowerCase(); let output = ""; let cursor = 0; let found = lower.indexOf(needle); while (found >= 0) { output += content.slice(cursor, found) + replacement; cursor = found + length; found = lower.indexOf(needle, cursor); } return output + content.slice(cursor); }
function matchesFilters(filePath: string, filters: Filters): boolean { const patterns = (value?: string) => value?.split(",").map((item) => item.trim()).filter(Boolean) ?? []; const include = patterns(filters.include); const exclude = patterns(filters.exclude); return (!include.length || include.some((pattern) => glob(pattern, filePath))) && !exclude.some((pattern) => glob(pattern, filePath)); }
function glob(pattern: string, value: string): boolean { let source = ""; for (let index = 0; index < pattern.length; index += 1) { const character = pattern[index]!; if (character === "*") { if (pattern[index + 1] === "*") { index += 1; if (pattern[index + 1] === "/") { index += 1; source += "(?:.*/)?"; } else source += ".*"; } else source += "[^/]*"; } else if (character === "?") source += "[^/]"; else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&"); } return new RegExp(`^${source}$`).test(value); }
async function gitVisiblePaths(root: string): Promise<Set<string> | undefined> { try { const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return new Set(stdout.split("\0").filter(Boolean)); } catch { return undefined; } }
