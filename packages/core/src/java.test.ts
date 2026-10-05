import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceFileSystem } from "./filesystem.js";
import { JavaProjectService } from "./java.js";
import { WorkspaceStateStore } from "./workspace-state.js";

async function createMavenWorkspace(onEvent: ConstructorParameters<typeof JavaProjectService>[2] = () => undefined, onBuildSucceeded?: () => Promise<void>) {
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
  return { root, filesystem, state, service: new JavaProjectService(filesystem, state, onEvent, onBuildSucceeded) };
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

// Exercise jdb's chunked command/response stream without requiring Maven.
describe("Java debugger inspection", () => {
  async function pausedDebugger() {
    const onEvent = vi.fn();
    const { service } = await createMavenWorkspace(onEvent);
    const debuggerService = service as unknown as {
      process: { stdin: { write: ReturnType<typeof vi.fn> } };
      debugging: boolean;
      consumeDebugOutput(data: string): void;
      debugReferences: Map<string, unknown>;
    };
    debuggerService.process = { stdin: { write: vi.fn() } };
    debuggerService.debugging = true;
    debuggerService.consumeDebugOutput('Breakpoint hit: "thread=main", Probe.main(), line=6 bci=13\n');
    expect(debuggerService.process.stdin.write).not.toHaveBeenCalled();
    debuggerService.consumeDebugOutput("main[1] ");
    expect(debuggerService.process.stdin.write).toHaveBeenCalledWith("locals\n");
    debuggerService.consumeDebugOutput("Local variables:\nobj = instance of Probe(id=413)\nmain[1] ");
    const reference = [...debuggerService.debugReferences.keys()][0]!;
    return { service, debuggerService, reference, onEvent };
  }

  it("expands fields and nested references without evaluating methods", async () => {
    const { service, debuggerService, reference } = await pausedDebugger();
    const result = service.debugVariables(reference);
    await Promise.resolve();
    expect(debuggerService.process.stdin.write).toHaveBeenLastCalledWith("dump obj\n");
    debuggerService.consumeDebugOutput(' obj = {\n    number: 42\n    text: "hello, world"\n    child: instance of Probe(id=413)\n    nums: instance of int[2] (id=415)\n}\nma');
    debuggerService.consumeDebugOutput("in[1] ");
    const fields = (await result).variables;
    expect(fields).toEqual([
      { name: "number", value: "42" },
      { name: "text", value: '\"hello, world\"' },
      expect.objectContaining({ name: "child", objectId: "413", reference: expect.any(String) }),
      expect.objectContaining({ name: "nums", indexedCount: 2, reference: expect.any(String) })
    ]);
    const elements = service.debugVariables(fields[3]!.reference!);
    await Promise.resolve();
    debuggerService.consumeDebugOutput(" obj.nums[0] = 3\nmain[1] ");
    await new Promise((resolve) => setTimeout(resolve, 0));
    debuggerService.consumeDebugOutput(" obj.nums[1] = 5\nmain[1] ");
    expect((await elements).variables).toEqual([{ name: "[0]", value: "3" }, { name: "[1]", value: "5" }]);
  });

  it("rejects stale and pending inspections when execution resumes", async () => {
    const { service, reference } = await pausedDebugger();
    const pending = service.debugVariables(reference);
    await Promise.resolve();
    const rejected = expect(pending).rejects.toThrow("inspection ended");
    service.debugCommand("continue");
    await rejected;
    await expect(service.debugVariables(reference)).rejects.toThrow("expired debugger pause");
  });
});

describe("Java debugger pause handling", () => {
  it("recognizes uncaught exceptions and exposes this in instance methods", async () => {
    const onEvent = vi.fn();
    const { service } = await createMavenWorkspace(onEvent);
    const debuggerService = service as unknown as { process: { stdin: { write: ReturnType<typeof vi.fn> } }; debugging: boolean; consumeDebugOutput(data: string): void };
    debuggerService.process = { stdin: { write: vi.fn() } }; debuggerService.debugging = true;
    debuggerService.consumeDebugOutput('Exception occurred: java.lang.RuntimeException (uncaught)"thread=main", Probe.work(), line=12 bci=9\nmain[1] ');
    expect(debuggerService.process.stdin.write).toHaveBeenLastCalledWith("locals\n");
    debuggerService.consumeDebugOutput("Local variables:\ncount = 4\nmain[1] ");
    expect(debuggerService.process.stdin.write).toHaveBeenLastCalledWith("dump this\n");
    debuggerService.consumeDebugOutput(" this = {\n    field: 7\n}\nmain[1] ");
    await Promise.resolve();
    expect(onEvent).toHaveBeenLastCalledWith({ type: "debug", state: expect.objectContaining({ status: "paused", stopReason: "java.lang.RuntimeException (uncaught)", variables: [expect.objectContaining({ name: "this", reference: expect.any(String) }), { name: "count", value: "4" }] }) });
  });
});

it("detects a pause when application output interrupts a breakpoint message", async () => {
  const onEvent = vi.fn();
  const { service } = await createMavenWorkspace(onEvent);
  const debuggerService = service as unknown as { process: { stdin: { write: ReturnType<typeof vi.fn> } }; consumeDebugOutput(data: string): void };
  debuggerService.process = { stdin: { write: vi.fn() } };
  debuggerService.consumeDebugOutput('RESULT=17,STATE\nBreakpoint hit: =7\n"thread=main", Probe.main(), line=8 bci=9\nmain[1] ');
  expect(debuggerService.process.stdin.write).toHaveBeenLastCalledWith("locals\n");
  debuggerService.consumeDebugOutput("Local variables:\nvalue = 17\nmain[1] ");
  expect(onEvent).toHaveBeenLastCalledWith({ type: "debug", state: expect.objectContaining({ status: "paused", className: "Probe", line: 8, variables: [{ name: "value", value: "17" }] }) });
});


describe("Java launch build reuse", () => {
  it("skips Maven for unchanged launches and profile changes, but rebuilds changed inputs or outputs", async () => {
    const { root, service } = await createMavenWorkspace();
    const { options } = await service.loadMavenProject("pom.xml");
    const launch = service as unknown as {
      prepareLaunch(config: typeof options, label: string, generation: number): Promise<string>;
      runAndWait(): Promise<void>;
      buildDebugClasspath(): Promise<string>;
    };
    const output = path.join(root, options.outputPath, "App.class");
    const build = vi.spyOn(launch, "runAndWait").mockImplementation(async () => {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, "compiled classes");
    });
    const classpath = vi.spyOn(launch, "buildDebugClasspath").mockResolvedValue(`${path.dirname(output)}${path.delimiter}${path.join(root, options.testOutputPath)}`);
    await launch.prepareLaunch(options, "Run build", 0);
    await launch.prepareLaunch(options, "Debug build", 0);
    await launch.prepareLaunch({ ...options, runConfigurations: [{ id: "other", name: "Other", mainClass: "Other" }], selectedRunConfigurationId: "other" }, "Run build", 0);
    expect(build).toHaveBeenCalledTimes(1);
    expect(classpath).toHaveBeenCalledTimes(1);
    const source = path.join(root, "src/main/java/com/example/App.java");
    await writeFile(source, "package com.example; class App { int changed; }\n");
    await launch.prepareLaunch(options, "Run build", 0);
    expect(build).toHaveBeenCalledTimes(2);
    await mkdir(path.join(root, "src/main/resources"), { recursive: true });
    await writeFile(path.join(root, "src/main/resources/application.properties"), "setting=changed");
    await launch.prepareLaunch(options, "Run build", 0);
    expect(build).toHaveBeenCalledTimes(3);
    await writeFile(path.join(root, "pom.xml"), "<project><version>2</version></project>");
    await launch.prepareLaunch(options, "Run build", 0);
    expect(build).toHaveBeenCalledTimes(4);
    await writeFile(output, "external rebuild");
    await launch.prepareLaunch(options, "Run build", 0);
    expect(build).toHaveBeenCalledTimes(5);
    await launch.prepareLaunch({ ...options, mavenArguments: ["-Pother"] }, "Run build", 0);
    expect(build).toHaveBeenCalledTimes(6);
  });

  it("does not reuse failed or cancelled builds", async () => {
    const { service } = await createMavenWorkspace();
    const { options } = await service.loadMavenProject("pom.xml");
    const launch = service as unknown as {
      prepareLaunch(config: typeof options, label: string, generation: number): Promise<string>;
      runAndWait(): Promise<void>;
      buildDebugClasspath(): Promise<string>;
    };
    const build = vi.spyOn(launch, "runAndWait").mockRejectedValueOnce(new Error("Build failed")).mockResolvedValue(undefined);
    vi.spyOn(launch, "buildDebugClasspath").mockResolvedValue("classes");
    await expect(launch.prepareLaunch(options, "Run build", 0)).rejects.toThrow("Build failed");
    await launch.prepareLaunch(options, "Run build", 0);
    expect(build).toHaveBeenCalledTimes(2);
    service.stop();
    await expect(launch.prepareLaunch(options, "Run build", 0)).rejects.toThrow("cancelled");
  });
});


it("refreshes language metadata only after a successful explicit Java Build", async () => {
  const refresh = vi.fn(async () => undefined);
  const events: unknown[] = [];
  const { root, state, service } = await createMavenWorkspace((event) => events.push(event), refresh);
  const { options } = await service.loadMavenProject("pom.xml");
  const script = path.join(root, "fake-maven.cjs");
  await writeFile(script, "process.exit(0)");
  await state.save({ openFiles: [], javaProject: { ...options, mavenExecutable: process.execPath, mavenArguments: [script] } });
  await service.build();
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "exit", exitCode: 0 })));
  expect(refresh).toHaveBeenCalledTimes(1);
  events.length = 0;
  await writeFile(script, "process.exit(1)");
  await service.build();
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "exit", exitCode: 1 })));
  expect(refresh).toHaveBeenCalledTimes(1);
});
