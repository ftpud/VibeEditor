import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LanguageDescriptor, LanguageService, LanguageServiceEvents } from "../language/service.js";
import { PROVIDER_API_VERSION, type ProviderFactory } from "../ai/stdio-provider.js";
import { RESERVED_PROVIDER_IDS } from "../ai/provider-definitions.js";

/** Version of the plugin contract (manifest + module exports). Bump on breaking changes. */
export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  id: string; name?: string; version: string; apiVersion: number;
  /** What the plugin promises to provide; the module's exports must match. */
  contributes: { providers?: string[]; languages?: string[] };
  /** Core entry module, relative to the plugin directory. */
  core: string;
}

export interface LanguageContribution { descriptor: LanguageDescriptor; create(workspace: string, events: LanguageServiceEvents): LanguageService }
export interface ProviderContribution { id: string; create: ProviderFactory }

/** What a plugin's Core module must export. */
export interface PluginModule { apiVersion: number; providers?: ProviderContribution[]; languages?: LanguageContribution[] }

export type { PluginStatus } from "@remote-ide/protocol";
import type { PluginStatus } from "@remote-ide/protocol";
export interface LoadedPlugins { status: PluginStatus[]; providers: ProviderFactory[]; languages: LanguageContribution[] }

const KEYS = new Set(["id", "name", "version", "apiVersion", "contributes", "core"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const idList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && /^[a-z0-9-]+$/.test(item));

export function validateManifest(input: unknown): PluginManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("manifest must be an object");
  const value = input as Record<string, unknown>;
  const extra = Object.keys(value).filter((key) => !KEYS.has(key));
  if (extra.length) throw new Error(`unknown manifest field ${extra.join(", ")}`);
  if (!text(value.id) || !/^[a-z0-9-]+$/.test(value.id)) throw new Error("id must contain only lowercase letters, digits and hyphens");
  if (!text(value.version)) throw new Error("version must be a non-empty string");
  if (value.apiVersion !== PLUGIN_API_VERSION) throw new Error(`apiVersion ${String(value.apiVersion)} is not supported (Core provides ${PLUGIN_API_VERSION})`);
  if (!text(value.core) || path.isAbsolute(value.core) || value.core.split(/[\\/]/).includes("..")) throw new Error("core must be a relative path inside the plugin directory");
  const contributes = value.contributes as Record<string, unknown> | undefined;
  if (!contributes || typeof contributes !== "object" || Array.isArray(contributes)) throw new Error("contributes must be an object");
  const unknown = Object.keys(contributes).filter((key) => key !== "providers" && key !== "languages");
  if (unknown.length) throw new Error(`unknown contribution ${unknown.join(", ")}`);
  for (const key of ["providers", "languages"] as const) if (contributes[key] !== undefined && !idList(contributes[key])) throw new Error(`contributes.${key} must list ids`);
  return value as unknown as PluginManifest;
}

/** The plugin directory is chosen by the Core host's operator; nothing is ever loaded from a workspace. */
export function pluginsDirectory(): string | undefined { return process.env.REMOTE_IDE_PLUGINS_DIR || undefined; }

/**
 * Loads every `<directory>/<plugin>/plugin.json`. A plugin that fails to
 * validate, import or match its manifest is reported and skipped; it never
 * affects startup or other plugins. Plugins run arbitrary code in Core.
 */
export async function loadPlugins(directory = pluginsDirectory(), options: { builtInProviders?: ReadonlySet<string>; builtInLanguages?: ReadonlySet<string>; disabled?: ReadonlySet<string> } = {}): Promise<LoadedPlugins> {
  const result: LoadedPlugins = { status: [], providers: [], languages: [] };
  if (!directory) return result;
  let names: string[];
  try { names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return result; }
  const providers = new Set([...RESERVED_PROVIDER_IDS, ...(options.builtInProviders ?? [])]);
  const languages = new Set(options.builtInLanguages ?? []);
  const seen = new Set<string>();
  for (const name of names) {
    const root = path.join(directory, name);
    const status: PluginStatus = { id: name, state: "failed", providers: [], languages: [] };
    result.status.push(status);
    try {
      const manifest = validateManifest(JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8")));
      Object.assign(status, { id: manifest.id, version: manifest.version, ...(manifest.name ? { name: manifest.name } : {}) });
      if (seen.has(manifest.id)) throw new Error(`duplicate plugin id '${manifest.id}'`);
      seen.add(manifest.id);
      if (options.disabled?.has(manifest.id)) { status.error = "disabled"; continue; }
      const entry = path.resolve(root, manifest.core);
      if (path.relative(root, entry).startsWith("..")) throw new Error("core escapes the plugin directory");
      const module = await import(pathToFileURL(entry).href) as Partial<PluginModule>;
      if (module.apiVersion !== PLUGIN_API_VERSION) throw new Error(`module apiVersion ${String(module.apiVersion)} does not match ${PLUGIN_API_VERSION}`);
      const contributedProviders = module.providers ?? [];
      const contributedLanguages = module.languages ?? [];
      const sameSet = (declared: string[] | undefined, actual: string[]) => [...(declared ?? [])].sort().join() === [...actual].sort().join();
      if (!sameSet(manifest.contributes.providers, contributedProviders.map((item) => item.id))) throw new Error("providers exported by the module do not match the manifest");
      if (!sameSet(manifest.contributes.languages, contributedLanguages.map((item) => item.descriptor.id))) throw new Error("languages exported by the module do not match the manifest");
      for (const provider of contributedProviders) if (providers.has(provider.id)) throw new Error(`provider id '${provider.id}' is already taken`);
      for (const language of contributedLanguages) if (languages.has(language.descriptor.id)) throw new Error(`language id '${language.descriptor.id}' is already taken`);
      for (const provider of contributedProviders) providers.add(provider.id);
      for (const language of contributedLanguages) languages.add(language.descriptor.id);
      result.providers.push(...contributedProviders.map((item) => item.create));
      result.languages.push(...contributedLanguages);
      Object.assign(status, { state: "loaded", providers: contributedProviders.map((item) => item.id), languages: contributedLanguages.map((item) => item.descriptor.id) });
    } catch (error) { status.error = error instanceof Error ? error.message : String(error); }
  }
  return result;
}

export { PROVIDER_API_VERSION };
