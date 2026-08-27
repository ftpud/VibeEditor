import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { JavaProjectOptions, JavaRunConfiguration, WorkspaceOptions } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

const EMPTY_OPTIONS: WorkspaceOptions = { openFiles: [] };

export class WorkspaceStateStore {
  private readonly stateFile: string;

  constructor(workspace: string, stateDirectory = path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(workspace).digest("hex");
    this.stateFile = path.join(stateDirectory, `${key}.json`);
  }

  async load(): Promise<WorkspaceOptions> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as unknown;
      return validateWorkspaceOptions(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_OPTIONS };
      console.error(`[core] could not load workspace options: ${error instanceof Error ? error.message : String(error)}`);
      return { ...EMPTY_OPTIONS };
    }
  }

  async save(options: WorkspaceOptions): Promise<void> {
    const validated = validateWorkspaceOptions(options);
    const directory = path.dirname(this.stateFile);
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await rename(temporary, this.stateFile);
    } catch (error) {
      throw new CoreError("WRITE_FAILED", `Could not save workspace options: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function validateWorkspaceOptions(value: unknown): WorkspaceOptions {
  if (!value || typeof value !== "object") throw new CoreError("INVALID_REQUEST", "Workspace options must be an object");
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.openFiles) || candidate.openFiles.length > 100 || !candidate.openFiles.every(isSafeRelativePath)) {
    throw new CoreError("INVALID_REQUEST", "openFiles must contain at most 100 safe relative paths");
  }
  if (candidate.activeFile !== undefined && !isSafeRelativePath(candidate.activeFile)) {
    throw new CoreError("INVALID_REQUEST", "activeFile must be a safe relative path");
  }
  const openFiles = [...new Set(candidate.openFiles as string[])];
  const activeFile = typeof candidate.activeFile === "string" && openFiles.includes(candidate.activeFile) ? candidate.activeFile : undefined;
  const javaProject = candidate.javaProject === undefined ? undefined : validateJavaProjectOptions(candidate.javaProject);
  const terminal = candidate.terminal === undefined ? undefined : validateTerminalOptions(candidate.terminal);
  const fileColors = candidate.fileColors === undefined ? undefined : validateFileColors(candidate.fileColors);
  if (candidate.gitCommitMessage !== undefined && (typeof candidate.gitCommitMessage !== "string" || candidate.gitCommitMessage.length > 10_000)) throw new CoreError("INVALID_REQUEST", "Invalid Git commit message draft");
  const gitCommitMessage = typeof candidate.gitCommitMessage === "string" ? candidate.gitCommitMessage : undefined;
  return { openFiles, ...(activeFile ? { activeFile } : {}), ...(javaProject ? { javaProject } : {}), ...(terminal ? { terminal } : {}), ...(fileColors && Object.keys(fileColors).length ? { fileColors } : {}), ...(gitCommitMessage ? { gitCommitMessage } : {}) };
}

function validateFileColors(value: unknown): NonNullable<WorkspaceOptions["fileColors"]> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 500) throw new CoreError("INVALID_REQUEST", "Invalid file colors");
  const colors = new Set(["red", "orange", "yellow", "green", "blue", "purple", "gray"]); const result: Record<string, "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray"> = {};
  for (const [filePath, color] of Object.entries(value as Record<string, unknown>)) { if (!isSafeRelativePath(filePath) || typeof color !== "string" || !colors.has(color)) throw new CoreError("INVALID_REQUEST", "Invalid colored file entry"); result[filePath] = color as typeof result[string]; }
  return result;
}

function validateTerminalOptions(value: unknown): NonNullable<WorkspaceOptions["terminal"]> {
  if (!value || typeof value !== "object") throw new CoreError("INVALID_REQUEST", "Invalid terminal workspace options");
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.tabs) || candidate.tabs.length > 20 || !candidate.tabs.every((tab) => {
    if (!tab || typeof tab !== "object") return false;
    const item = tab as Record<string, unknown>;
    return typeof item.title === "string" && item.title.length <= 100 && (item.terminalId === undefined || (typeof item.terminalId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.terminalId)));
  })) throw new CoreError("INVALID_REQUEST", "Terminal tabs must contain at most 20 valid entries");
  if (typeof candidate.panelOpen !== "boolean") throw new CoreError("INVALID_REQUEST", "Invalid terminal panel options");
  const tabs = candidate.tabs.map((tab) => {
    const item = tab as { title: string; terminalId?: string };
    return { title: (item.title.trim() || "Terminal").slice(0, 100), ...(item.terminalId ? { terminalId: item.terminalId } : {}) };
  });
  const activeTabIndex = Number.isInteger(candidate.activeTabIndex) && (candidate.activeTabIndex as number) >= 0 && (candidate.activeTabIndex as number) < tabs.length ? candidate.activeTabIndex as number : undefined;
  return { tabs, ...(activeTabIndex !== undefined ? { activeTabIndex } : {}), panelOpen: candidate.panelOpen };
}

export function validateJavaProjectOptions(value: unknown): JavaProjectOptions {
  if (!value || typeof value !== "object") throw new CoreError("INVALID_REQUEST", "Java project options must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "maven" || !isSafeRelativePath(candidate.pomPath) || typeof candidate.mavenExecutable !== "string" || !candidate.mavenExecutable || candidate.mavenExecutable.length > 500) {
    throw new CoreError("INVALID_REQUEST", "Invalid Maven project options");
  }
  if (!Array.isArray(candidate.sourceRoots) || candidate.sourceRoots.length > 50 || !candidate.sourceRoots.every(isSafeRelativePath)) {
    throw new CoreError("INVALID_REQUEST", "Java sourceRoots must contain safe relative paths");
  }
  if (!isSafeRelativePath(candidate.outputPath) || !isSafeRelativePath(candidate.testOutputPath)) throw new CoreError("INVALID_REQUEST", "Java output paths must be relative");
  const rawConfigurations = candidate.runConfigurations ?? [];
  if (!Array.isArray(rawConfigurations) || rawConfigurations.length > 50) throw new CoreError("INVALID_REQUEST", "Java runConfigurations must be an array");
  const runConfigurations = rawConfigurations.map(validateRunConfiguration);
  const selectedRunConfigurationId = typeof candidate.selectedRunConfigurationId === "string" && runConfigurations.some((configuration) => configuration.id === candidate.selectedRunConfigurationId)
    ? candidate.selectedRunConfigurationId
    : undefined;
  return {
    type: "maven",
    pomPath: candidate.pomPath,
    mavenExecutable: candidate.mavenExecutable,
    sourceRoots: [...new Set(candidate.sourceRoots as string[])],
    outputPath: candidate.outputPath,
    testOutputPath: candidate.testOutputPath,
    runConfigurations,
    ...(selectedRunConfigurationId ? { selectedRunConfigurationId } : {})
  };
}

function validateRunConfiguration(value: unknown): JavaRunConfiguration {
  if (!value || typeof value !== "object") throw new CoreError("INVALID_REQUEST", "Invalid Java run configuration");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(candidate.id) || typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 100 || typeof candidate.mainClass !== "string" || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(candidate.mainClass)) {
    throw new CoreError("INVALID_REQUEST", "Invalid Java run configuration");
  }
  return { id: candidate.id, name: candidate.name.trim(), mainClass: candidate.mainClass };
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\0")) return false;
  const normalized = path.normalize(value);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}
