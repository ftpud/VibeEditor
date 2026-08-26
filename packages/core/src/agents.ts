import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { AgentFile, AgentFileScope, AiAgent } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

export const AGENT_TEMPLATE = `---
name: New Agent
description: Describe when this agent should be used.
mcpServers:
  - vibe-editor
---

You are a specialized agent. Describe your role, workflow, and constraints here.
`;

export class AgentsStore {
  private readonly root: string;
  private readonly localDirectory: string;

  constructor(private readonly rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.root = path.join(stateDirectory, "agents");
    this.localDirectory = path.join(this.root, "local", key);
  }

  async list(workspace: string): Promise<AgentFile[]> {
    const collect = async (scope: AgentFileScope) => {
      try {
        const directory = this.directory(scope, workspace);
        const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /\.md$/i.test(entry.name));
        return await Promise.all(entries.map(async (entry) => ({ scope, name: entry.name, agent: parseAgent(entry.name, await readFile(path.join(directory, entry.name), "utf8")) })));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new CoreError("READ_FAILED", `Could not list agents: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    return [...await collect("global"), ...await collect("local"), ...await collect("workspace")].sort((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope) || a.name.localeCompare(b.name));
  }

  async read(scope: AgentFileScope, name: string, workspace: string): Promise<string> {
    try { return await readFile(this.target(scope, name, workspace), "utf8"); }
    catch (error) { throw new CoreError("READ_FAILED", `Could not read agent: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async create(scope: Exclude<AgentFileScope, "workspace">, name: string, workspace: string): Promise<void> {
    const target = this.target(scope, normalizeName(name), workspace);
    await mkdir(path.dirname(target), { recursive: true });
    try { await writeFile(target, AGENT_TEMPLATE, { encoding: "utf8", flag: "wx" }); }
    catch (error) { throw new CoreError("WRITE_FAILED", `Could not create agent: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async write(scope: AgentFileScope, name: string, content: string, workspace: string): Promise<void> {
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new CoreError("FILE_TOO_LARGE", "Agent file exceeds 2 MB");
    try { await writeFile(this.target(scope, name, workspace), content, "utf8"); }
    catch (error) { throw new CoreError("WRITE_FAILED", `Could not write agent: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async rename(scope: Exclude<AgentFileScope, "workspace">, name: string, newName: string, workspace: string): Promise<string> {
    const normalized = normalizeName(newName);
    try {
      const destination = this.target(scope, normalized, workspace);
      try { await access(destination); throw new CoreError("WRITE_FAILED", `Agent already exists: ${normalized}`); }
      catch (error) { if (error instanceof CoreError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(this.target(scope, name, workspace), destination);
      return normalized;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("WRITE_FAILED", `Could not rename agent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async delete(scope: Exclude<AgentFileScope, "workspace">, name: string, workspace: string): Promise<void> {
    try { await rm(this.target(scope, name, workspace)); }
    catch (error) { throw new CoreError("WRITE_FAILED", `Could not delete agent: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private directory(scope: AgentFileScope, workspace: string): string {
    if (scope === "global") return path.join(this.root, "global");
    if (scope === "local") return this.localDirectory;
    if (scope === "workspace") return path.join(workspace, ".agents");
    throw new CoreError("INVALID_REQUEST", "Invalid agent scope");
  }

  private target(scope: AgentFileScope, name: string, workspace: string): string {
    if (!name || name.length > 180 || name !== path.basename(name) || name === "." || name === ".." || name.includes("\0") || !/\.md$/i.test(name)) throw new CoreError("INVALID_REQUEST", "Agent name must be a plain Markdown file name");
    return path.join(this.directory(scope, workspace), name);
  }
}

export function parseAgent(fileName: string, content: string): AiAgent {
  let body = content;
  const fields = new Map<string, string>();
  const servers: string[] = [];
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (frontmatter) {
    body = content.slice(frontmatter[0].length);
    let list: string | undefined;
    for (const line of frontmatter[1]!.split(/\r?\n/)) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item && list === "mcpServers") { servers.push(unquote(item[1]!)); continue; }
      const field = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
      if (!field) continue;
      list = field[1]; fields.set(field[1]!, unquote(field[2]!));
    }
    const inline = fields.get("mcpServers");
    if (inline?.startsWith("[") && inline.endsWith("]")) servers.push(...inline.slice(1, -1).split(",").map((value) => unquote(value.trim())).filter(Boolean));
  }
  const fallback = fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return { name: fields.get("name") || fallback, ...(fields.get("description") ? { description: fields.get("description") } : {}), instructions: body.trim(), ...(servers.length ? { mcpServers: [...new Set(servers)] } : {}) };
}

function normalizeName(name: string): string { const trimmed = name.trim(); return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`; }
function unquote(value: string): string { return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"); }
function scopeOrder(scope: AgentFileScope): number { return scope === "global" ? 0 : scope === "local" ? 1 : 2; }
