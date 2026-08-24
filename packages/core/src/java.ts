import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { JavaMainClass, JavaProjectNode, JavaProjectOptions } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";
import { WorkspaceStateStore } from "./workspace-state.js";

type JavaProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null; signal: string | null };

export class JavaProjectService {
  private process?: ChildProcessWithoutNullStreams;

  constructor(
    private readonly filesystem: WorkspaceFileSystem,
    private readonly state: WorkspaceStateStore,
    private readonly onProcessEvent: (event: JavaProcessEvent) => void
  ) {}

  async loadMavenProject(pomPath: string): Promise<{ options: JavaProjectOptions; tree: JavaProjectNode[] }> {
    if (path.posix.basename(pomPath) !== "pom.xml") throw new CoreError("MAVEN_PROJECT_INVALID", "Select a pom.xml file");
    const xml = await this.filesystem.read(pomPath);
    let document: Record<string, unknown>;
    try { document = new XMLParser({ ignoreAttributes: false }).parse(xml) as Record<string, unknown>; }
    catch (error) { throw new CoreError("MAVEN_PROJECT_INVALID", `Could not parse pom.xml: ${error instanceof Error ? error.message : String(error)}`); }
    const project = document.project as Record<string, unknown> | undefined;
    if (!project) throw new CoreError("MAVEN_PROJECT_INVALID", "pom.xml does not contain a Maven project");
    const build = (project.build as Record<string, unknown> | undefined) ?? {};
    const moduleRoot = path.posix.dirname(pomPath) === "." ? "" : path.posix.dirname(pomPath);
    const relative = (value: unknown, fallback: string) => path.posix.join(moduleRoot, typeof value === "string" ? value : fallback);
    const candidates = [relative(build.sourceDirectory, "src/main/java"), relative(build.testSourceDirectory, "src/test/java")];
    const sourceRoots: string[] = [];
    for (const candidate of candidates) {
      try { if ((await stat(await this.filesystem.resolveExisting(candidate))).isDirectory()) sourceRoots.push(candidate); } catch { /* Optional Maven source directory. */ }
    }
    const existing = (await this.state.load()).javaProject;
    if (existing?.pomPath === pomPath) {
      for (const existingRoot of existing.sourceRoots) if (!sourceRoots.includes(existingRoot)) sourceRoots.push(existingRoot);
    }
    const options: JavaProjectOptions = {
      type: "maven",
      pomPath,
      mavenExecutable: existing?.pomPath === pomPath ? existing.mavenExecutable : "mvn",
      sourceRoots,
      outputPath: relative(build.outputDirectory, "target/classes"),
      testOutputPath: relative(build.testOutputDirectory, "target/test-classes"),
      runConfigurations: existing?.pomPath === pomPath ? existing.runConfigurations : [],
      ...(existing?.pomPath === pomPath && existing.selectedRunConfigurationId ? { selectedRunConfigurationId: existing.selectedRunConfigurationId } : {})
    };
    await this.saveProject(options);
    return { options, tree: await this.buildProjectTree(options) };
  }

  async getOptions(): Promise<JavaProjectOptions | undefined> {
    return (await this.state.load()).javaProject;
  }

  async addSourceRoot(sourcePath: string): Promise<{ options: JavaProjectOptions; tree: JavaProjectNode[] }> {
    const options = await this.requireOptions();
    const info = await stat(await this.filesystem.resolveExisting(sourcePath));
    if (!info.isDirectory()) throw new CoreError("INVALID_REQUEST", "Java source root must be a directory");
    const next = { ...options, sourceRoots: [...new Set([...options.sourceRoots, sourcePath])] };
    await this.saveProject(next);
    return { options: next, tree: await this.buildProjectTree(next) };
  }

  async getProjectTree(): Promise<JavaProjectNode[]> {
    return this.buildProjectTree(await this.requireOptions());
  }

  async listMainClasses(): Promise<JavaMainClass[]> {
    const options = await this.requireOptions();
    const classes: JavaMainClass[] = [];
    for (const sourceRoot of options.sourceRoots) {
      let absolute: string;
      try { absolute = await this.filesystem.resolveExisting(sourceRoot); } catch { continue; }
      for (const filePath of await this.collectJavaFiles(absolute, sourceRoot)) {
        let content: string;
        try { content = await this.filesystem.read(filePath); } catch { continue; }
        if (!/\bpublic\s+static\s+void\s+main\s*\(\s*(?:java\.lang\.)?String(?:\s*\[\s*\]|\s*\.\.\.)/m.test(content)) continue;
        const packageName = content.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1];
        const simpleName = path.posix.basename(filePath, ".java");
        classes.push({ className: packageName ? `${packageName}.${simpleName}` : simpleName, path: filePath });
      }
    }
    return classes.sort((a, b) => a.className.localeCompare(b.className));
  }

  async addRunConfiguration(name: string, mainClass: string): Promise<JavaProjectOptions> {
    const options = await this.requireOptions();
    const available = await this.listMainClasses();
    if (!available.some((item) => item.className === mainClass)) throw new CoreError("INVALID_REQUEST", `Main class was not found: ${mainClass}`);
    if (!name.trim() || name.length > 100) throw new CoreError("INVALID_REQUEST", "Run configuration name is required and must not exceed 100 characters");
    const configuration = { id: crypto.randomUUID(), name: name.trim(), mainClass };
    const next = { ...options, runConfigurations: [...options.runConfigurations, configuration], selectedRunConfigurationId: configuration.id };
    await this.saveProject(next);
    return next;
  }

  async selectRunConfiguration(id: string): Promise<JavaProjectOptions> {
    const options = await this.requireOptions();
    if (!options.runConfigurations.some((configuration) => configuration.id === id)) throw new CoreError("INVALID_REQUEST", `Run configuration not found: ${id}`);
    const next = { ...options, selectedRunConfigurationId: id };
    await this.saveProject(next);
    return next;
  }

  async build(): Promise<void> { await this.start(["package", "-DskipTests"], "Build"); }
  async run(): Promise<void> {
    const options = await this.requireOptions();
    const configuration = options.runConfigurations.find((item) => item.id === options.selectedRunConfigurationId);
    if (!configuration) throw new CoreError("JAVA_PROCESS_FAILED", "Select a Java run configuration first");
    await this.start(["exec:java", `-Dexec.mainClass=${configuration.mainClass}`], "Run");
  }

  stop(): void {
    if (!this.process) return;
    this.process.kill("SIGTERM");
  }

  close(): void { this.stop(); }

  private async start(goals: string[], label: string): Promise<void> {
    if (this.process) throw new CoreError("JAVA_PROCESS_FAILED", "A Java build or run process is already active");
    const options = await this.requireOptions();
    this.onProcessEvent({ type: "output", data: `> ${options.mavenExecutable} -f ${options.pomPath} ${goals.join(" ")}\n` });
    try {
      const child = spawn(options.mavenExecutable, ["-f", options.pomPath, ...goals], { cwd: this.filesystem.getWorkspace(), env: process.env, stdio: "pipe" });
      this.process = child;
      child.stdout.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.stderr.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.on("error", (error) => this.onProcessEvent({ type: "output", data: `${label} failed to start: ${error.message}\n` }));
      child.on("close", (exitCode, signal) => {
        this.process = undefined;
        this.onProcessEvent({ type: "exit", exitCode, signal });
      });
    } catch (error) {
      this.process = undefined;
      throw new CoreError("JAVA_PROCESS_FAILED", `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async requireOptions(): Promise<JavaProjectOptions> {
    const options = await this.getOptions();
    if (!options) throw new CoreError("JAVA_NOT_CONFIGURED", "Load a pom.xml as a Maven project first");
    return options;
  }

  private async saveProject(javaProject: JavaProjectOptions): Promise<void> {
    const current = await this.state.load();
    await this.state.save({ ...current, javaProject });
  }

  private async buildProjectTree(options: JavaProjectOptions): Promise<JavaProjectNode[]> {
    const roots: JavaProjectNode[] = [];
    for (const sourceRoot of options.sourceRoots) {
      let absolute: string;
      try { absolute = await this.filesystem.resolveExisting(sourceRoot); } catch { continue; }
      roots.push({ name: sourceRoot, path: sourceRoot, type: "sourceRoot", children: await this.walkPackages(absolute, sourceRoot) });
    }
    return roots;
  }

  private async walkPackages(directory: string, relativeDirectory: string): Promise<JavaProjectNode[]> {
    const nodes: JavaProjectNode[] = [];
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) nodes.push({ name: entry.name, path: relative, type: "package", children: await this.walkPackages(absolute, relative) });
      else if (entry.isFile() && entry.name.endsWith(".java")) nodes.push({ name: entry.name, path: relative, type: "file" });
    }
    return compactPackages(nodes);
  }

  private async collectJavaFiles(directory: string, relativeDirectory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) files.push(...await this.collectJavaFiles(absolute, relative));
      else if (entry.isFile() && entry.name.endsWith(".java")) files.push(relative);
    }
    return files;
  }
}

function compactPackages(nodes: JavaProjectNode[]): JavaProjectNode[] {
  return nodes.map((node) => {
    if (node.type !== "package") return node;
    let name = node.name;
    let compactedPath = node.path;
    let children = compactPackages(node.children ?? []);
    while (children.length === 1 && children[0]?.type === "package") {
      const child = children[0];
      name = `${name}.${child.name}`;
      compactedPath = child.path;
      children = child.children ?? [];
    }
    return { name, path: compactedPath, type: "package", children };
  });
}
