import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceFileSystem } from "./filesystem.js";
import { JavaProjectService } from "./java.js";
import { WorkspaceStateStore } from "./workspace-state.js";

async function createMavenWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "remote-ide-java-"));
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-java-state-"));
  await mkdir(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  await mkdir(path.join(root, "src", "generated", "org", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>app</artifactId><version>1</version></project>");
  await writeFile(path.join(root, "src", "main", "java", "com", "example", "App.java"), "package com.example; class App { public static void main(String[] args) {} }\n");
  await writeFile(path.join(root, "src", "generated", "org", "demo", "Generated.java"), "package org.demo; class Generated {}\n");
  const filesystem = new WorkspaceFileSystem();
  await filesystem.open(root);
  const state = new WorkspaceStateStore(root, stateDirectory);
  return { root, filesystem, state, service: new JavaProjectService(filesystem, state, () => undefined) };
}

describe("JavaProjectService", () => {
  it("loads Maven options and creates a compact package tree", async () => {
    const { service, state } = await createMavenWorkspace();
    const result = await service.loadMavenProject("pom.xml");
    expect(result.options).toMatchObject({ type: "maven", pomPath: "pom.xml", mavenExecutable: "mvn", sourceRoots: ["src/main/java"], outputPath: "target/classes" });
    expect(result.tree[0]).toMatchObject({ type: "sourceRoot", path: "src/main/java" });
    expect(result.tree[0]?.children?.[0]).toMatchObject({ type: "package", name: "com.example" });
    expect(result.tree[0]?.children?.[0]?.children?.[0]).toMatchObject({ type: "file", name: "App.java" });
    await expect(state.load()).resolves.toMatchObject({ javaProject: result.options });
  });

  it("adds and persists a custom source root", async () => {
    const { service } = await createMavenWorkspace();
    await service.loadMavenProject("pom.xml");
    const result = await service.addSourceRoot("src/generated");
    expect(result.options.sourceRoots).toContain("src/generated");
    expect(result.tree.find((node) => node.path === "src/generated")?.children?.[0]).toMatchObject({ name: "org.demo", type: "package" });
    await expect(service.getOptions()).resolves.toEqual(result.options);
  });

  it("discovers main classes and persists a selected run profile", async () => {
    const { service } = await createMavenWorkspace();
    await service.loadMavenProject("pom.xml");
    await expect(service.listMainClasses()).resolves.toEqual([{ className: "com.example.App", path: "src/main/java/com/example/App.java" }]);
    const options = await service.addRunConfiguration("Application", "com.example.App");
    expect(options.runConfigurations).toEqual([expect.objectContaining({ name: "Application", mainClass: "com.example.App" })]);
    expect(options.selectedRunConfigurationId).toBe(options.runConfigurations[0]?.id);
    await expect(service.getOptions()).resolves.toEqual(options);
  });
});
