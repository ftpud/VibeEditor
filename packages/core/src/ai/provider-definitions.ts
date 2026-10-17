import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AiConfiguration, AiModel, AiOption, AiProviderDescriptor } from "@remote-ide/acp";
import { StdioAcpProvider, type ProviderContext, type ProviderFactory } from "./stdio-provider.js";

/** A provider declared as data: an external ACP agent started from a command on the Core host. */
export interface ProviderDefinition {
  id: string; name: string; description: string;
  command: string; args?: string[]; env?: Record<string, string>;
  /** Variables the agent reads credentials from; documented to the user, never stored. */
  credentialEnv?: string[];
  models?: { id: string; name: string; defaultReasoning?: string; reasoningLevels?: string[] }[];
  options?: AiOption[];
  capabilities?: Partial<AiProviderDescriptor["capabilities"]>;
}

const KEYS = new Set(["id", "name", "description", "command", "args", "env", "credentialEnv", "models", "options", "capabilities"]);
const MODEL_KEYS = new Set(["id", "name", "defaultReasoning", "reasoningLevels"]);
const CAPABILITY_KEYS = ["models", "usage", "mcp", "agents", "contextWindow", "skills"] as const;
const OPTION_TYPES = new Set(["select", "number", "boolean", "text"]);
/** IDs a definition may not claim; they belong to built-in providers or are reserved. */
export const RESERVED_PROVIDER_IDS = new Set(["codex", "claude", "copilot", "default", "fake"]);

const isString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`${label}: unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")}`);
}

/** Strictly validates parsed JSON; throws a message naming the first problem. */
export function validateProviderDefinition(input: unknown, reserved: ReadonlySet<string> = RESERVED_PROVIDER_IDS): ProviderDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("definition must be an object");
  const value = input as Record<string, unknown>;
  unknownKeys(value, KEYS, "definition");
  for (const key of ["id", "name", "description", "command"] as const) if (!isString(value[key])) throw new Error(`${key} must be a non-empty string`);
  if (!/^[a-z0-9-]+$/.test(value.id as string)) throw new Error("id may contain only lowercase letters, digits and hyphens");
  if (reserved.has(value.id as string)) throw new Error(`id '${value.id}' is reserved`);
  if (value.args !== undefined && !Array.isArray(value.args)) throw new Error("args must be an array of strings");
  if (Array.isArray(value.args) && !value.args.every((arg) => typeof arg === "string")) throw new Error("args must be an array of strings");
  if (value.env !== undefined && (!value.env || typeof value.env !== "object" || Array.isArray(value.env) || !Object.values(value.env).every((item) => typeof item === "string"))) throw new Error("env must map names to strings");
  if (value.credentialEnv !== undefined && !isStringArray(value.credentialEnv)) throw new Error("credentialEnv must be an array of variable names");
  if (value.models !== undefined) {
    if (!Array.isArray(value.models)) throw new Error("models must be an array");
    for (const model of value.models) {
      if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("each model must be an object");
      unknownKeys(model as Record<string, unknown>, MODEL_KEYS, "model");
      const entry = model as Record<string, unknown>;
      if (!isString(entry.id) || !isString(entry.name)) throw new Error("model needs a non-empty id and name");
      if (entry.reasoningLevels !== undefined && !isStringArray(entry.reasoningLevels)) throw new Error("model reasoningLevels must be an array of strings");
      if (entry.defaultReasoning !== undefined && typeof entry.defaultReasoning !== "string") throw new Error("model defaultReasoning must be a string");
    }
  }
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) throw new Error("options must be an array");
    const seen = new Set<string>();
    for (const option of value.options) {
      const entry = option as Record<string, unknown> | null;
      if (!entry || typeof entry !== "object" || !isString(entry.id) || !isString(entry.name) || typeof entry.description !== "string" || !OPTION_TYPES.has(entry.type as string)) throw new Error("each option needs id, name, description and a valid type");
      if (seen.has(entry.id)) throw new Error(`duplicate option '${entry.id}'`);
      seen.add(entry.id);
      if (!["string", "number", "boolean"].includes(typeof entry.defaultValue)) throw new Error(`option '${entry.id}' needs a defaultValue`);
    }
  }
  if (value.capabilities !== undefined) {
    const capabilities = value.capabilities as Record<string, unknown>;
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) throw new Error("capabilities must be an object");
    unknownKeys(capabilities, new Set(CAPABILITY_KEYS), "capabilities");
    if (!Object.values(capabilities).every((flag) => typeof flag === "boolean")) throw new Error("capabilities must be booleans");
  }
  return value as unknown as ProviderDefinition;
}

/** A stdio ACP provider built entirely from a definition; the agent is user-supplied and never installed by Core. */
export class ConfiguredStdioProvider extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor;

  constructor(private readonly definition: ProviderDefinition, ctx: ProviderContext) {
    super(ctx.onChanged, undefined, ctx.turns, ctx.projectRoot, ctx.bridgeWorkspace);
    const capabilities = { models: true, usage: false, mcp: true, agents: true, contextWindow: true, skills: true, ...definition.capabilities };
    this.descriptor = {
      id: definition.id, name: definition.name, description: definition.description,
      settings: { title: `${definition.name} settings`, description: `Options declared by the ${definition.name} provider definition.`, sections: [] },
      options: definition.options ?? [], capabilities
    };
  }

  protected command(_configuration: AiConfiguration): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    return { command: this.definition.command, args: this.definition.args ?? [], env: { ...this.definition.env } };
  }

  protected async fallbackModels(): Promise<AiModel[]> {
    return (this.definition.models ?? []).map((model) => ({ id: model.id, name: model.name, defaultReasoning: model.defaultReasoning ?? "", reasoningLevels: model.reasoningLevels ?? [] }));
  }
}

export function providerDefinitionsDirectory(): string {
  return process.env.REMOTE_IDE_PROVIDER_DEFINITIONS_DIR ?? path.join(os.homedir(), ".remote-ide", "providers");
}

/**
 * Reads `*.json` definitions from a Core-host directory. Invalid files, and
 * duplicates of an earlier id, are reported through `warn` and skipped so one
 * bad file never prevents startup.
 */
export function loadProviderDefinitions(directory = providerDefinitionsDirectory(), taken: ReadonlySet<string> = new Set(), warn: (message: string) => void = (message) => console.warn(message)): ProviderDefinition[] {
  let names: string[];
  try { names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort(); } catch { return []; }
  const ids = new Set(taken);
  const loaded: ProviderDefinition[] = [];
  for (const name of names) {
    try {
      const definition = validateProviderDefinition(JSON.parse(readFileSync(path.join(directory, name), "utf8")));
      if (ids.has(definition.id)) throw new Error(`duplicate provider id '${definition.id}'`);
      ids.add(definition.id); loaded.push(definition);
    } catch (error) { warn(`Skipping provider definition ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return loaded;
}

export function definitionFactory(definition: ProviderDefinition): ProviderFactory { return (ctx) => new ConfiguredStdioProvider(definition, ctx); }
