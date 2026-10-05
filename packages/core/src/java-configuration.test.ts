import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { javaConfigurationPath } from "@remote-ide/protocol";
import { WorkspaceFileSystem } from "./filesystem.js";
import { JavaProjectService } from "./java.js";
import { WorkspaceStateStore } from "./workspace-state.js";
import { javaLaunchEnvironment, javaToolEnvironment, javaToolExecutable, parseJavaConfiguration } from "./java-configuration.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function workspace(wrapper = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-java-settings-"));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "vibe-java-settings-state-"));
  directories.push(root, stateDirectory);
  await mkdir(path.join(root, "src/main/java"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId></project>");
  if (wrapper) await writeFile(path.join(root, "mvnw"), "#!/bin/sh\nexit 0\n");
  const filesystem = new WorkspaceFileSystem(); await filesystem.open(root);
  const state = new WorkspaceStateStore(root, stateDirectory);
  let exited = false;
  const service = new JavaProjectService(filesystem, state, (event) => { if (event.type === "exit") exited = true; });
  const { options } = await service.loadMavenProject("pom.xml");
  return { root, filesystem, service, options, state, waitForExit: async () => { const deadline = Date.now() + 3000; while (!exited) { if (Date.now() > deadline) throw new Error("Process did not exit"); await new Promise((resolve) => setTimeout(resolve, 10)); } } };
}

describe("Java configuration", () => {
  it("detects a project Maven wrapper and supplies a JSON template", async () => {
    const { service, options } = await workspace(true);
    expect(options.mavenExecutable).toBe("./mvnw");
    const result = await service.readConfiguration();
    expect(result.path).toBe(javaConfigurationPath);
    expect(result.revision).toBeUndefined();
    const template = parseJavaConfiguration(result.template);
    expect(template.runConfigurations[0]).toMatchObject({ name: "Application", mainClass: "com.example.App", workingDirectory: ".", programArguments: [], vmArguments: [], environment: {} });
  });

  it("persists settings and profiles, reads file edits, and rejects stale writes", async () => {
    const { service, options, root } = await workspace();
    const configuration = { ...options, javaHome: "/opt/jdk", mavenArguments: ["-Pdev"], buildGoals: ["compile"], runConfigurations: [{ id: "app", name: "App", mainClass: "demo.App", programArguments: ["one argument", ""], vmArguments: ["-ea", "-Xmx1g"], environment: { MODE: "dev" }, workingDirectory: "." }], selectedRunConfigurationId: "app" };
    const saved = await service.saveConfiguration(JSON.stringify(configuration));
    expect(JSON.parse(await readFile(path.join(root, javaConfigurationPath), "utf8"))).toEqual(configuration);
    expect(await service.getOptions()).toEqual(configuration);
    await writeFile(path.join(root, javaConfigurationPath), JSON.stringify({ ...configuration, mavenExecutable: "/opt/maven/bin/mvn" }));
    await expect(service.saveConfiguration(saved.content, saved.revision)).rejects.toThrow("File changed");
    expect((await service.getOptions())?.mavenExecutable).toBe("/opt/maven/bin/mvn");
    await expect(service.saveConfiguration(saved.content)).rejects.toThrow("Reopen the editor");
  });

  it("keeps malformed JSON accessible for repair without replacing it", async () => {
    const { service, root } = await workspace();
    await mkdir(path.join(root, ".vibe")); await writeFile(path.join(root, javaConfigurationPath), "{broken");
    await expect(service.getOptions()).rejects.toThrow("invalid JSON");
    const file = await service.readConfiguration();
    expect(file.content).toBe("{broken");
    const saved = await service.saveConfiguration(file.template, file.revision);
    expect(saved.options.runConfigurations[0]?.mainClass).toBe("com.example.App");
  });

  it("validates unknown fields, duplicate profiles, argument arrays, and environment values", async () => {
    const { options } = await workspace();
    const base = { ...options, runConfigurations: [{ id: "app", name: "App", mainClass: "demo.App" }] };
    expect(() => parseJavaConfiguration(JSON.stringify({ ...base, mvn: "mvn" }))).toThrow('unknown field "mvn"');
    expect(() => parseJavaConfiguration(JSON.stringify({ ...base, runConfigurations: [...base.runConfigurations, ...base.runConfigurations] }))).toThrow("different id");
    expect(() => parseJavaConfiguration(JSON.stringify({ ...base, runConfigurations: [{ ...base.runConfigurations[0], vmArguments: "-ea" }] }))).toThrow("vmArguments must be an array");
    expect(() => parseJavaConfiguration(JSON.stringify({ ...base, runConfigurations: [{ ...base.runConfigurations[0], environment: { PORT: 8080 } }] }))).toThrow("environment must be a JSON object");
  });

  it("uses configured Maven arguments and JDK home during builds", async () => {
    const { service, options, root, waitForExit } = await workspace();
    const executable = path.join(root, "fake-maven");
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync('build.json', JSON.stringify({ args: process.argv.slice(2), javaHome: process.env.JAVA_HOME }));\n`);
    await chmod(executable, 0o755);
    await service.saveConfiguration(JSON.stringify({ ...options, mavenExecutable: "./fake-maven", javaHome: "/opt/test-jdk", mavenArguments: ["-Pdev", "-Dvalue=with spaces"], buildGoals: ["compile"] }));
    await service.build(); await waitForExit();
    expect(JSON.parse(await readFile(path.join(root, "build.json"), "utf8"))).toEqual({ args: ["-Pdev", "-Dvalue=with spaces", "-f", "pom.xml", "compile"], javaHome: "/opt/test-jdk" });
  });

  it("reports missing tools and executable permissions with repair instructions", async () => {
    const { service, options, root } = await workspace();
    await service.saveConfiguration(JSON.stringify({ ...options, mavenExecutable: "./missing-mvn", javaHome: "/missing/jdk" }));
    await expect(service.build()).rejects.toThrow(/Core host.*Java configuration.*Maven executable/);
    const checks = await service.checkTools(JSON.stringify({ ...options, mavenExecutable: "./missing-mvn", javaHome: "/missing/jdk" }));
    expect(checks).toHaveLength(4); expect(checks.every((item) => !item.ok)).toBe(true);
    expect(checks.find((item) => item.tool === "Java debugger")?.message).toContain("full JDK");
    const file = await service.readConfiguration();
    await writeFile(path.join(root, "no-permission-mvn"), "#!/bin/sh\nexit 0\n");
    await service.saveConfiguration(JSON.stringify({ ...options, mavenExecutable: "./no-permission-mvn" }), file.revision);
    await expect(service.build()).rejects.toThrow("chmod +x mvnw");
  });

  it("configures Java tools and PATH consistently", async () => {
    const { root, options } = await workspace();
    const configuration = { ...options, javaHome: "./jdk" };
    expect(javaToolExecutable(configuration, "jdb", root)).toBe(path.join(root, "jdk/bin/jdb"));
    const environment = javaToolEnvironment(configuration, root, { MODE: "dev" });
    expect(environment.JAVA_HOME).toBe(path.join(root, "jdk"));
    expect(environment.PATH?.startsWith(path.join(root, "jdk/bin") + path.delimiter)).toBe(true);
    expect(environment.MODE).toBe("dev");
  });
});

it("loads .env files afresh and lets inline values override them", async () => {
  const { root, filesystem, options } = await workspace();
  const profile = { id: "app", name: "App", mainClass: "demo.App", environmentFile: "app.env", environment: { MODE: "inline" } };
  const config = { ...options, runConfigurations: [profile] };
  expect(parseJavaConfiguration(JSON.stringify(config)).runConfigurations[0]?.environmentFile).toBe("app.env");
  await writeFile(path.join(root, "app.env"), "MODE=file\nTOKEN=first\n");
  expect(await javaLaunchEnvironment(filesystem, profile)).toEqual({ MODE: "inline", TOKEN: "first" });
  await writeFile(path.join(root, "app.env"), "TOKEN=second\n");
  expect(await javaLaunchEnvironment(filesystem, profile)).toEqual({ MODE: "inline", TOKEN: "second" });
  expect(() => parseJavaConfiguration(JSON.stringify({ ...config, runConfigurations: [{ ...profile, environmentFile: "../app.env" }] }))).toThrow("environmentFile");
});

it("rejects missing and invalid .env files", async () => {
  const { root, filesystem } = await workspace();
  const profile = { id: "app", name: "App", mainClass: "demo.App", environmentFile: "app.env" };
  await expect(javaLaunchEnvironment(filesystem, profile)).rejects.toThrow("Environment file app.env");
  for (const content of ["invalid", '{"PORT":8080}', "BAD-NAME=value", "TOKEN=bad\0value"]) {
    await writeFile(path.join(root, "app.env"), content);
    await expect(javaLaunchEnvironment(filesystem, profile)).rejects.toThrow("Environment file app.env");
  }
  expect(await javaLaunchEnvironment(filesystem, { ...profile, environmentFile: undefined })).toEqual({});
});

it("supports .env comments, quotes, export prefixes, empty values, and literal variables", async () => {
  const { root, filesystem } = await workspace();
  const profile = { id: "app", name: "App", mainClass: "demo.App", environmentFile: "app.env" };
  await writeFile(path.join(root, "app.env"), [
    "# application settings", "export MODE=development # comment", 'MESSAGE="hello world # literal"',
    "SINGLE='literal value'", "EMPTY=", "PORT=8080", "LITERAL=$MODE", 'MULTILINE="first\\nsecond"',
    "DUPLICATE=first", "DUPLICATE=last"
  ].join("\r\n"));
  expect(await javaLaunchEnvironment(filesystem, profile)).toEqual({
    MODE: "development", MESSAGE: "hello world # literal", SINGLE: "literal value", EMPTY: "", PORT: "8080",
    LITERAL: "$MODE", MULTILINE: "first\nsecond", DUPLICATE: "last"
  });
});

it("preserves large JSON environment values and files above 200 KB", async () => {
  const { root, filesystem } = await workspace();
  const profile = { id: "app", name: "App", mainClass: "demo.App", environmentFile: "default-env.json", environment: { MODE: "inline" } };
  const json = JSON.stringify({ message: "complex=value", nested: { data: "x".repeat(30_000) }, enabled: true });
  const values = { CONFIG: json, ...Object.fromEntries(Array.from({ length: 110 }, (_, index) => [`CONFIG_${index}`, JSON.stringify({ data: "y".repeat(2_000) })])) };
  // A .json filename still contains dotenv KEY=value entries.
  await writeFile(path.join(root, "default-env.json"), Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"));
  expect(await javaLaunchEnvironment(filesystem, profile)).toEqual({ ...values, MODE: "inline" });
});
