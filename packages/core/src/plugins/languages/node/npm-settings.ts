import path from "node:path";
import { CoreError } from "../../../errors.js";
import { isSafeRelativePath } from "../../../path-safety.js";

export const npmConfigurationPath = ".settings/npm.json";
export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn"] as const;
export type PackageManager = typeof PACKAGE_MANAGERS[number];

export interface NpmRunConfiguration {
  id: string; name: string; script: string;
  arguments?: string[];
  /** Passed to the script via NODE_OPTIONS (e.g. --inspect, --max-old-space-size=4096). */
  nodeOptions?: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentFile?: string;
}
export interface NpmProjectOptions {
  type: "npm";
  packageJsonPath: string;
  packageManager: PackageManager;
  /** Node/npm executable name or path; defaults to the package manager command. */
  executable?: string;
  runConfigurations: NpmRunConfiguration[];
  selectedRunConfigurationId?: string;
}

const reject = (message: string) => new CoreError("INVALID_REQUEST", message);
const strings = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200 || !value.every((item) => typeof item === "string" && item.length <= 10_000 && !item.includes("\0"))) throw reject(`${field} must be an array of strings (one argument per item)`);
  return value as string[];
};
const unknownFields = (value: Record<string, unknown>, fields: string[], label: string) => {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown) throw reject(`${label}: unknown field "${unknown}"`);
};

export function validatePackageJsonPath(value: unknown): string {
  if (!isSafeRelativePath(value) || path.posix.basename(String(value).replace(/\\/g, "/")) !== "package.json") throw reject("packageJsonPath must be a package.json path inside the workspace");
  return path.posix.normalize(String(value).replace(/\\/g, "/"));
}

export function validateNpmRunConfiguration(value: unknown): NpmRunConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw reject("Each run configuration must be an object");
  const candidate = value as Record<string, unknown>;
  unknownFields(candidate, ["id", "name", "script", "arguments", "nodeOptions", "workingDirectory", "environment", "environmentFile"], "Run configuration");
  if (typeof candidate.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(candidate.id)) throw reject("Run configuration id must use letters, numbers, or hyphens");
  if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 100) throw reject("Run configuration name is required (up to 100 characters)");
  if (typeof candidate.script !== "string" || !candidate.script.trim() || candidate.script.length > 200 || /[\0\r\n]/.test(candidate.script)) throw reject(`Run configuration "${candidate.name}": script must be a package.json script name`);
  const args = strings(candidate.arguments, "arguments");
  const nodeOptions = strings(candidate.nodeOptions, "nodeOptions");
  if (candidate.workingDirectory !== undefined && !isSafeRelativePath(candidate.workingDirectory)) throw reject("workingDirectory must be inside the workspace; use . for its root");
  if (candidate.environmentFile !== undefined && !isSafeRelativePath(candidate.environmentFile)) throw reject("environmentFile must be an .env file inside the workspace");
  if (candidate.environment !== undefined && (!candidate.environment || typeof candidate.environment !== "object" || Array.isArray(candidate.environment) || Object.keys(candidate.environment).length > 100 || !Object.entries(candidate.environment).every(([key, item]) => /^[A-Za-z_]\w*$/.test(key) && typeof item === "string" && item.length <= 10_000 && !item.includes("\0")))) throw reject("environment must be a JSON object mapping environment variable names to strings");
  return {
    id: candidate.id, name: candidate.name.trim(), script: candidate.script.trim(),
    ...(args ? { arguments: args } : {}), ...(nodeOptions ? { nodeOptions } : {}),
    ...(typeof candidate.workingDirectory === "string" ? { workingDirectory: candidate.workingDirectory } : {}),
    ...(candidate.environment ? { environment: candidate.environment as Record<string, string> } : {}),
    ...(typeof candidate.environmentFile === "string" ? { environmentFile: candidate.environmentFile } : {})
  };
}

export function validateNpmProjectOptions(value: unknown): NpmProjectOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw reject("npm configuration must be a JSON object");
  const candidate = value as Record<string, unknown>;
  unknownFields(candidate, ["type", "packageJsonPath", "packageManager", "executable", "runConfigurations", "selectedRunConfigurationId"], "npm configuration");
  if (candidate.type !== "npm") throw reject('type must be "npm"');
  const packageJsonPath = validatePackageJsonPath(candidate.packageJsonPath);
  if (!PACKAGE_MANAGERS.includes(candidate.packageManager as PackageManager)) throw reject(`packageManager must be one of ${PACKAGE_MANAGERS.join(", ")}`);
  if (candidate.executable !== undefined && (typeof candidate.executable !== "string" || !candidate.executable.trim() || candidate.executable.length > 1000 || /[\0\r\n]/.test(candidate.executable))) throw reject("executable must be an executable name or path");
  const raw = candidate.runConfigurations ?? [];
  if (!Array.isArray(raw) || raw.length > 50) throw reject("runConfigurations must be an array of at most 50 run configurations");
  const runConfigurations = raw.map(validateNpmRunConfiguration);
  if (new Set(runConfigurations.map((item) => item.id)).size !== runConfigurations.length) throw reject("Each run configuration must have a different id");
  const selected = candidate.selectedRunConfigurationId;
  if (selected !== undefined && (typeof selected !== "string" || !runConfigurations.some((item) => item.id === selected))) throw reject("selectedRunConfigurationId must match a run configuration id");
  return {
    type: "npm", packageJsonPath, packageManager: candidate.packageManager as PackageManager,
    ...(typeof candidate.executable === "string" ? { executable: candidate.executable.trim() } : {}),
    runConfigurations, ...(typeof selected === "string" ? { selectedRunConfigurationId: selected } : {})
  };
}

export function parseNpmConfiguration(content: string): NpmProjectOptions {
  if (typeof content !== "string" || Buffer.byteLength(content) > 200_000) throw reject("npm configuration must be JSON text under 200 KB");
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) { throw reject(`${npmConfigurationPath}: invalid JSON. ${error instanceof Error ? error.message : String(error)}`); }
  try { return validateNpmProjectOptions(value); } catch (error) { throw reject(`${npmConfigurationPath}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Run configurations seeded when a package.json is added: the common entry-point scripts that exist. */
export function defaultRunConfigurations(scripts: string[]): NpmRunConfiguration[] {
  const preferred = ["start", "dev", "serve", "test"].filter((name) => scripts.includes(name));
  const chosen = preferred.length ? preferred : scripts.slice(0, 1);
  return chosen.map((script) => ({ id: script, name: script, script }));
}
