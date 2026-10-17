import { expect, it } from "vitest";
import type { LanguageDescriptor } from "@remote-ide/protocol";
import { projectRegistration, runProject } from "./run-projects";
const descriptor: LanguageDescriptor = { id: "node", name: "Node.js", extensions: ["js"], projectMarkers: ["package.json"], capabilities: { run: true, build: true, projectTree: true, configuration: true, debug: false, workspaceSymbols: false, lsp: false, runConfigurations: true } };
it("offers registration only for exact manifest filenames, including nested projects", () => {
  expect(projectRegistration("web/package.json")).toEqual({ language: "node", label: "Add as npm project", extra: { packageJsonPath: "web/package.json" } });
  expect(projectRegistration("server/pom.xml")).toEqual({ language: "java", label: "Add as Maven project", extra: { pomPath: "server/pom.xml" } });
  expect(projectRegistration("package.json.backup")).toBeUndefined();
  expect(projectRegistration("src/index.js")).toBeUndefined();
});
it("keeps installed but unregistered languages out of run controls", () => {
  expect(runProject(descriptor, { configured: false, scripts: ["dev"], runConfigurations: [] })).toBeUndefined();
  expect(runProject(descriptor, {})).toBeUndefined();
  expect(runProject(descriptor, { configured: true, packageJsonPath: "web/package.json", name: "Web", runConfigurations: [{ id: "dev", name: "Development", script: "dev" }, null], selectedRunConfigurationId: "dev" })).toMatchObject({ language: "node", name: "Web", path: "web/package.json", configurations: [{ id: "dev", name: "Development" }], selectedId: "dev" });
});
it("retains existing Maven projects created before the configured marker", () => {
  expect(runProject({ ...descriptor, id: "java", name: "Java" }, { pomPath: "pom.xml", runConfigurations: [] })).toMatchObject({ language: "java", path: "pom.xml" });
});
