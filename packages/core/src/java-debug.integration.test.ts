import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JavaDebugState } from "@remote-ide/protocol";
import { WorkspaceFileSystem } from "./filesystem.js";
import { JavaProjectService } from "./java.js";
import { WorkspaceStateStore } from "./workspace-state.js";

const hasJdk = ["javac", "jdb"].every((command) => spawnSync(command, ["-version"]).status === 0);

// Use real javac/jdb, with a tiny Maven stand-in so this test needs no dependency downloads.
describe.skipIf(!hasJdk)("Java debugger with a live JVM", () => {
  it("preserves object state while replacing code, restores breakpoints, and rejects schema/compile changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vibe-java-live-"));
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "vibe-java-live-state-"));
    const source = path.join(root, "src/main/java/com/example/App.java");
    const code = (value: number, extra = "") => `package com.example;
public class App {
  static class Base { Node inherited; } static class Node extends Base { int value = 7; Node child = this; int[] nums = {3, 5}; Object[] mixed = {this, "comma,quote", null, new String[]{"first,second", "third"}}; Node() { inherited = this; } }
  ${extra}
  static int calculate(Node node) { return node.value + ${value}; }
  public static void main(String[] args) throws Exception { if (!"greeting with spaces".equals(args[0]) || args[1].length() != 0 || !"flag with spaces".equals(System.getProperty("demo.flag")) || !"from-profile".equals(System.getenv("DEMO_MODE"))) throw new IllegalStateException("Launch configuration was not applied");
    Node node = new Node();
    int result = calculate(node);
    java.nio.file.Files.writeString(java.nio.file.Path.of("result.txt"), result + ":" + node.value); System.out.println("RESULT=" + result + ",STATE=" + node.value);
    result = calculate(node);
    java.nio.file.Files.writeString(java.nio.file.Path.of("second.txt"), String.valueOf(result)); System.out.println("SECOND=" + result);
  }
}
`;
    let latest: JavaDebugState = { status: "stopped", variables: [] };
    let output = "";
    let exits = 0;
    const filesystem = new WorkspaceFileSystem();
    await filesystem.open(root);
    const state = new WorkspaceStateStore(root, stateDirectory);
    const service = new JavaProjectService(filesystem, state, (event) => {
      if (event.type === "debug") latest = event.state;
      if (event.type === "output") output += event.data;
      if (event.type === "exit") exits++;
    });
    const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 15_000;
      while (!await predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}: ${output.slice(-5000)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await mkdir(path.dirname(source), { recursive: true });
      await mkdir(path.join(root, "target/classes"), { recursive: true });
      await writeFile(source, code(1));
      await writeFile(path.join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>app</artifactId><version>1</version></project>");
      const compiler = path.join(root, "maven-fixture");
      await writeFile(compiler, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const classpath = process.argv.find(arg => arg.startsWith("-Dmdep.outputFile="));
if (classpath) { writeFileSync(classpath.split("=").slice(1).join("="), ""); process.exit(0); }
const build = spawnSync("javac", ["-g", "-d", "target/classes", "src/main/java/com/example/App.java"], { stdio: "inherit" });
process.exit(build.status ?? 1);
`);
      await chmod(compiler, 0o755);
      const { options } = await service.loadMavenProject("pom.xml");
      await state.save({ ...(await state.load()), javaProject: { ...options, mavenExecutable: compiler } });
      const configured = await service.addRunConfiguration("App", "com.example.App");
      await mkdir(path.join(root, "runtime"));
      const javaSettings = spawnSync("java", ["-XshowSettings:properties", "-version"], { encoding: "utf8" });
      const javaHome = javaSettings.stderr.match(/java\.home\s*=\s*(.+)/)?.[1]?.trim();
      expect(javaHome).toBeDefined();
      await service.saveConfiguration(JSON.stringify({ ...configured, javaHome, mavenArguments: ["-Pfixture"], buildGoals: ["compile"], runConfigurations: configured.runConfigurations.map((item) => ({ ...item, programArguments: ["greeting with spaces", ""], vmArguments: ["-ea", "-Ddemo.flag=flag with spaces"], environment: { DEMO_MODE: "from-profile" }, workingDirectory: "runtime" })) }));
      await service.debug([8].map((line) => ({ path: "src/main/java/com/example/App.java", className: "com.example.App", line })));
      await waitFor(() => latest.status === "paused", "first breakpoint");
      expect(latest.path).toBe("src/main/java/com/example/App.java");
      const node = latest.variables.find((variable) => variable.name === "node")!;
      expect(node.objectId).toBeDefined();
      const fields = (await service.debugVariables(node.reference!)).variables;
      expect(fields.find((field) => field.name === "value")?.value).toBe("7");
      const child = fields.find((field) => field.name === "child")!;
      expect(child.objectId).toBe(node.objectId);
      expect((await service.debugVariables(child.reference!)).variables.find((field) => field.name === "value")?.value).toBe("7");
      const array = fields.find((field) => field.name === "nums")!;
      expect((await service.debugVariables(array.reference!)).variables).toEqual([{ name: "[0]", value: "3" }, { name: "[1]", value: "5" }]);

      const inherited = fields.find((field) => field.name.endsWith(".inherited"))!;
      expect((await service.debugVariables(inherited.reference!)).variables.find((field) => field.name === "value")?.value).toBe("7");
      const mixed = fields.find((field) => field.name === "mixed")!;
      const elements = (await service.debugVariables(mixed.reference!)).variables;
      expect(elements[0]?.reference).toBeDefined();
      expect(elements[1]?.value).toBe('"comma,quote"');
      expect(elements[2]?.value).toBe("null");
      expect((await service.debugVariables(elements[0]!.reference!)).variables.find((field) => field.name === "value")?.value).toBe("7");
      expect((await service.debugVariables(elements[3]!.reference!)).variables).toEqual([{ name: "[0]", value: '"first,second"' }, { name: "[1]", value: '"third"' }]);

      // Add the method breakpoint and remove the entry breakpoint in the live session.
      await service.setDebugBreakpoints([{ path: "src/main/java/com/example/App.java", className: "com.example.App", line: 5 }]);
      await writeFile(source, code(10));
      const applied = await service.applyDebugChanges();
      expect(applied).toEqual({ appliedClasses: ["com.example.App"], deferredClasses: [], failedClasses: [], restartRequired: false });
      expect(latest.status).toBe("paused");
      expect(latest.applyingChanges).toBe(false);
      const newNode = latest.variables.find((variable) => variable.name === "node")!;
      expect(newNode.objectId).toBe(node.objectId);
      await expect(service.debugVariables(node.reference!)).rejects.toThrow("expired debugger pause");
      expect((await service.debugVariables(newNode.reference!)).variables.find((field) => field.name === "value")?.value).toBe("7");
      expect((await service.applyDebugChanges()).appliedClasses).toEqual([]);

      await writeFile(source, code(10, "static int newField;"));
      const unsupported = await service.applyDebugChanges();
      expect(unsupported.restartRequired).toBe(true);
      expect(unsupported.failedClasses[0]?.className).toBe("com.example.App");
      expect(unsupported.appliedClasses).toEqual([]);
      await writeFile(source, "this is not valid Java");
      await expect(service.applyDebugChanges()).rejects.toThrow("Compilation failed");
      expect(latest.status).toBe("paused");
      expect(latest.applyingChanges).toBe(false);

      await writeFile(source, code(10));
      service.debugCommand("continue");
      await waitFor(() => latest.status === "paused" && latest.line === 5, "restored method breakpoint");
      service.debugCommand("continue");
      await waitFor(async () => (await readFile(path.join(root, "runtime/result.txt"), "utf8").catch(() => "")) === "17:7", "new method result");
      await waitFor(() => latest.status === "paused" && latest.line === 5, "second method breakpoint");
      await service.setDebugBreakpoints([]);
      service.debugCommand("continue");
      await waitFor(() => latest.status === "stopped", "normal exit");
      expect(await readFile(path.join(root, "runtime/second.txt"), "utf8")).toBe("17");
      await rm(path.join(root, "runtime/result.txt"));
      await service.run();
      await waitFor(() => exits === 2, "configured normal Java run");
      expect(await readFile(path.join(root, "runtime/result.txt"), "utf8")).toBe("17:7");
      const mavenLaunches = () => (output.match(/^> .*maven-fixture /gm) ?? []).length;
      const before = mavenLaunches();
      await service.run();
      await waitFor(() => exits === 3, "unchanged Java run");
      expect(mavenLaunches()).toBe(before);
      await service.debug([{ path: "src/main/java/com/example/App.java", className: "com.example.App", line: 8 }]);
      await waitFor(() => latest.status === "paused" && latest.line === 8, "cached debug breakpoint");
      expect(mavenLaunches()).toBe(before);
      service.debugCommand("continue");
      await waitFor(() => latest.status === "stopped", "cached debugger exit");
    } finally {
      service.stop();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rm(root, { recursive: true, force: true });
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
