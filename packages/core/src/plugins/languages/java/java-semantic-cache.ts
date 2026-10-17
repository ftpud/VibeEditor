import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import type { JavaSemanticToken } from "@remote-ide/protocol";

export function javaLanguageStateDirectory(workspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")): string {
  return path.join(stateDirectory, "java-language", digest(path.resolve(workspace)));
}

/** One snapshot per visited source file. A generation prevents late requests restoring pre-build results. */
export class JavaSemanticCache {
  private readonly directory: string;
  constructor(workspace: string, stateDirectory?: string) { this.directory = path.join(javaLanguageStateDirectory(workspace, stateDirectory), "tokens-v1"); }

  async generation(): Promise<string> {
    try { return await readFile(path.join(this.directory, "generation"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "initial"; throw error; }
  }

  async get(filePath: string, content: string): Promise<{ generation: string; tokens?: JavaSemanticToken[] }> {
    const generation = await this.generation();
    try {
      const entry = JSON.parse(await readFile(this.file(filePath), "utf8"));
      if (entry.path === filePath && entry.generation === generation && entry.contentHash === digest(content) && validTokens(entry.tokens)) return { generation, tokens: entry.tokens };
    } catch { /* A missing or damaged cache must not break Java editing. */ }
    return { generation };
  }

  async put(filePath: string, content: string, tokens: JavaSemanticToken[], generation: string): Promise<void> {
    if (generation !== await this.generation()) return;
    await this.atomicWrite(this.file(filePath), JSON.stringify({ path: filePath, contentHash: digest(content), generation, tokens }));
  }

  async invalidate(): Promise<void> {
    await this.atomicWrite(path.join(this.directory, "generation"), crypto.randomUUID());
  }

  async files(): Promise<string[]> {
    let files: string[];
    try { files = await readdir(this.directory); } catch { return []; }
    const paths = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
      try { const entry = JSON.parse(await readFile(path.join(this.directory, file), "utf8")); return typeof entry.path === "string" ? entry.path : undefined; } catch { return undefined; }
    }));
    return paths.filter((file): file is string => file !== undefined);
  }

  private file(filePath: string): string { return path.join(this.directory, `${digest(filePath)}.json`); }
  private async atomicWrite(file: string, content: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, content, "utf8"); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
}

function digest(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function validTokens(value: unknown): value is JavaSemanticToken[] {
  return Array.isArray(value) && value.length <= 200_000 && value.every((token) => token && typeof token.type === "string" && Array.isArray(token.modifiers) && token.modifiers.every((item: unknown) => typeof item === "string") && [token.startLine, token.startColumn, token.endLine, token.endColumn].every((item) => Number.isSafeInteger(item) && item > 0));
}
