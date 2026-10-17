import type { LanguageDescriptor, LanguageExtra } from "@remote-ide/protocol";

export type ProjectRunConfiguration = { id: string; name: string };
export type RunProject = {
  language: string;
  name: string;
  path?: string;
  capabilities: LanguageDescriptor["capabilities"];
  configurations: ProjectRunConfiguration[];
  selectedId?: string;
  terminalRunning?: boolean;
};
export type RunProjectProcess = { running: boolean; log: string; error?: string };

/** An installed language is not a configured project. Keep unused tools out of run controls. */
export function runProject(descriptor: LanguageDescriptor, options: LanguageExtra): RunProject | undefined {
  if (!descriptor.capabilities.run || options.configured === false) return;
  // Older Java configurations predate the explicit configured marker.
  if (options.configured !== true && !Array.isArray(options.runConfigurations)) return;
  const configurations = Array.isArray(options.runConfigurations) ? options.runConfigurations.filter((value): value is ProjectRunConfiguration => !!value && typeof value === "object" && typeof value.id === "string" && typeof value.name === "string").map(({ id, name }) => ({ id, name })) : [];
  const path = typeof options.packageJsonPath === "string" ? options.packageJsonPath : typeof options.pomPath === "string" ? options.pomPath : undefined;
  return {
    language: descriptor.id,
    terminalRunning: options.terminalRunning === true,
    name: typeof options.name === "string" && options.name ? options.name : descriptor.name,
    path,
    capabilities: descriptor.capabilities,
    configurations,
    selectedId: typeof options.selectedRunConfigurationId === "string" ? options.selectedRunConfigurationId : undefined
  };
}

export function runConfigurationKey(language: string, id: string): string { return JSON.stringify([language, id]); }
export function projectRegistration(path: string): { language: string; label: string; extra: LanguageExtra } | undefined {
  const name = path.split("/").pop();
  if (name === "package.json") return { language: "node", label: "Add as npm project", extra: { packageJsonPath: path } };
  if (name === "pom.xml") return { language: "java", label: "Add as Maven project", extra: { pomPath: path } };
}
