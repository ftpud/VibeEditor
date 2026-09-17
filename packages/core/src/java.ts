import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { JavaBreakpoint, JavaDebugState, JavaDiagnostic, JavaMainClass, JavaProjectNode, JavaProjectOptions, JavaTypeSuggestion } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";
import { WorkspaceStateStore } from "./workspace-state.js";

type JavaProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null; signal: string | null }
  | { type: "debug"; state: JavaDebugState };

export class JavaProjectService {
  private process?: ChildProcessWithoutNullStreams;
  private debugging = false;
  private debugBuffer = "";
  private debugLocation?: { className: string; method: string; line: number };
  private awaitingDebugLocals = false;
  private dependencyTypes?: JavaTypeSuggestion[];

  constructor(
    private readonly filesystem: WorkspaceFileSystem,
    private readonly state: WorkspaceStateStore,
    private readonly onProcessEvent: (event: JavaProcessEvent) => void
  ) {}

  async loadMavenProject(pomPath: string): Promise<{ options: JavaProjectOptions; tree: JavaProjectNode[] }> {
    this.dependencyTypes = undefined;
    if (path.posix.basename(pomPath) !== "pom.xml") throw new CoreError("MAVEN_PROJECT_INVALID", "Select a pom.xml file");
    const xml = (await this.filesystem.read(pomPath)).content;
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
        try { content = (await this.filesystem.read(filePath)).content; } catch { continue; }
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
  async check(): Promise<JavaDiagnostic[]> {
    if (this.process) throw new CoreError("JAVA_PROCESS_FAILED", "Java checks are unavailable while a build, run, or debug process is active");
    const options = await this.requireOptions();
    const output = await this.capture(options.mavenExecutable, ["-f", options.pomPath, "compile", "-DskipTests", "-Dstyle.color=never"]);
    const diagnostics: JavaDiagnostic[] = [];
    const workspace = this.filesystem.getWorkspace();
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.replace(/\x1b\[[0-9;]*m/g, "");
      const match = line.match(/^\[(ERROR|WARNING)]\s+(.+?\.java):\[(\d+),(\d+)]\s+(.+)$/) ?? line.match(/^(.+?\.java):(\d+):(?:(\d+):)?\s*(error|warning):\s*(.+)$/i);
      if (!match) continue;
      const mavenFormat = match[1] === "ERROR" || match[1] === "WARNING";
      const filePath = mavenFormat ? match[2]! : match[1]!;
      const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
      const relative = path.relative(workspace, absolute).split(path.sep).join(path.posix.sep);
      if (relative.startsWith("..")) continue;
      diagnostics.push({
        path: relative,
        line: Number(mavenFormat ? match[3] : match[2]),
        column: Number((mavenFormat ? match[4] : match[3]) || 1),
        severity: (mavenFormat ? match[1] : match[4])!.toLowerCase() as "error" | "warning",
        message: (mavenFormat ? match[5] : match[5])!.trim()
      });
    }
    return diagnostics;
  }

  async completeType(prefix: string): Promise<JavaTypeSuggestion[]> {
    const normalized = prefix.trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(normalized)) return [];
    const options = await this.requireOptions();
    const projectTypes: JavaTypeSuggestion[] = [];
    for (const sourceRoot of options.sourceRoots) {
      let absolute: string;
      try { absolute = await this.filesystem.resolveExisting(sourceRoot); } catch { continue; }
      for (const filePath of await this.collectJavaFiles(absolute, sourceRoot)) {
        const content = await this.filesystem.read(filePath).then((file) => file.content).catch(() => "");
        const packageName = content.match(/^\s*package\s+([\w$.]+)\s*;/m)?.[1];
        for (const match of content.matchAll(/\b(?:public\s+)?(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g)) {
          const simpleName = match[1]!;
          projectTypes.push({ simpleName, qualifiedName: packageName ? `${packageName}.${simpleName}` : simpleName, source: "project" });
        }
      }
    }
    if (!this.dependencyTypes) this.dependencyTypes = await this.indexDependencyTypes(options);
    const lower = normalized.toLowerCase();
    return [...projectTypes, ...this.dependencyTypes]
      .filter((item) => item.simpleName.toLowerCase().startsWith(lower))
      .filter((item, index, all) => all.findIndex((candidate) => candidate.qualifiedName === item.qualifiedName) === index)
      .sort((a, b) => Number(b.simpleName === normalized) - Number(a.simpleName === normalized) || a.simpleName.localeCompare(b.simpleName) || a.qualifiedName.localeCompare(b.qualifiedName))
      .slice(0, 100);
  }
  async run(): Promise<void> {
    const options = await this.requireOptions();
    const configuration = options.runConfigurations.find((item) => item.id === options.selectedRunConfigurationId);
    if (!configuration) throw new CoreError("JAVA_PROCESS_FAILED", "Select a Java run configuration first");
    await this.start(["exec:java", `-Dexec.mainClass=${configuration.mainClass}`], "Run");
  }

  async debug(breakpoints: JavaBreakpoint[]): Promise<void> {
    const options = await this.requireOptions();
    const configuration = options.runConfigurations.find((item) => item.id === options.selectedRunConfigurationId);
    if (!configuration) throw new CoreError("JAVA_PROCESS_FAILED", "Select a Java run configuration first");
    if (this.process) throw new CoreError("JAVA_PROCESS_FAILED", "A Java build, run, or debug process is already active");
    this.onProcessEvent({ type: "debug", state: { status: "starting", variables: [] } });
    await this.runAndWait(options.mavenExecutable, ["-f", options.pomPath, "package", "-DskipTests"], "Debug build");
    const classpath = await this.buildDebugClasspath(options);
    const child = spawn("jdb", ["-classpath", classpath, configuration.mainClass], { cwd: this.filesystem.getWorkspace(), env: process.env, stdio: "pipe" });
    this.process = child;
    this.debugging = true;
    this.debugBuffer = "";
    child.stdout.on("data", (data: Buffer) => this.consumeDebugOutput(data.toString()));
    child.stderr.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
    child.on("error", (error) => this.onProcessEvent({ type: "output", data: `Debugger failed to start: ${error.message}\n` }));
    child.on("close", (exitCode, signal) => {
      this.process = undefined; this.debugging = false;
      this.onProcessEvent({ type: "debug", state: { status: "stopped", variables: [] } });
      this.onProcessEvent({ type: "exit", exitCode, signal });
    });
    for (const breakpoint of breakpoints) child.stdin.write(`stop at ${breakpoint.className}:${breakpoint.line}\n`);
    child.stdin.write("run\n");
    this.onProcessEvent({ type: "debug", state: { status: "running", variables: [] } });
  }

  debugCommand(command: "continue" | "stepInto" | "stepOver" | "stepOut"): void {
    if (!this.process || !this.debugging) throw new CoreError("JAVA_PROCESS_FAILED", "No Java debugger is active");
    const jdbCommand = { continue: "cont", stepInto: "step", stepOver: "next", stepOut: "step up" }[command];
    this.process.stdin.write(`${jdbCommand}\n`);
    this.onProcessEvent({ type: "debug", state: { status: "running", variables: [] } });
  }

  stop(): void {
    if (!this.process) return;
    const child = this.process;
    if (this.debugging) {
      child.stdin.write("exit\n");
      setTimeout(() => { if (this.process === child) child.kill("SIGKILL"); }, 1_000).unref();
      return;
    }
    child.kill("SIGTERM");
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

  private runAndWait(command: string, args: string[], label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.filesystem.getWorkspace(), env: process.env, stdio: "pipe" });
      this.process = child;
      child.stdout.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.stderr.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.on("error", (error) => { this.process = undefined; reject(new CoreError("JAVA_PROCESS_FAILED", `${label} failed: ${error.message}`)); });
      child.on("close", (code) => {
        this.process = undefined;
        if (code === 0) resolve(); else reject(new CoreError("JAVA_PROCESS_FAILED", `${label} exited with code ${code}`));
      });
    });
  }

  private capture(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.filesystem.getWorkspace(), env: process.env, stdio: "pipe" });
      let output = "";
      child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
      child.on("error", (error) => reject(new CoreError("JAVA_PROCESS_FAILED", `Java diagnostics failed: ${error.message}`)));
      child.on("close", () => resolve(output));
    });
  }

  private async buildDebugClasspath(options: JavaProjectOptions): Promise<string> {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "vibe-jdb-"));
    const classpathFile = path.join(temporaryDirectory, "classpath.txt");
    try {
      await this.runAndWait(options.mavenExecutable, ["-q", "-f", options.pomPath, "dependency:build-classpath", `-Dmdep.outputFile=${classpathFile}`], "Resolve debug classpath");
      const dependencies = (await readFile(classpathFile, "utf8")).trim();
      const workspace = this.filesystem.getWorkspace();
      const outputs = [options.outputPath, options.testOutputPath].map((output) => path.resolve(workspace, output));
      return [...outputs, ...(dependencies ? dependencies.split(path.delimiter) : [])].join(path.delimiter);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async indexDependencyTypes(options: JavaProjectOptions): Promise<JavaTypeSuggestion[]> {
    const classpath = await this.buildDebugClasspath(options);
    const jars = classpath.split(path.delimiter).filter((entry) => entry.endsWith(".jar"));
    const suggestions: JavaTypeSuggestion[] = [];
    for (const jar of jars) {
      const listing = await this.capture("jar", ["tf", jar]).catch(() => "");
      for (const entry of listing.split(/\r?\n/)) {
        if (!entry.endsWith(".class") || entry.includes("$") || entry.endsWith("module-info.class") || entry.endsWith("package-info.class")) continue;
        const qualifiedName = entry.slice(0, -6).replaceAll("/", ".");
        const simpleName = qualifiedName.split(".").pop()!;
        suggestions.push({ simpleName, qualifiedName, source: "dependency" });
      }
    }
    const javaSettings = await this.capture("java", ["-XshowSettings:properties", "-version"]).catch(() => "");
    const javaHome = javaSettings.match(/^\s*java\.home\s*=\s*(.+)$/m)?.[1]?.trim();
    if (javaHome) {
      const listing = await this.capture("jimage", ["list", path.join(javaHome, "lib", "modules")]).catch(() => "");
      for (const entry of listing.split(/\r?\n/).map((line) => line.trim())) {
        if (!entry.endsWith(".class") || entry.includes("$") || entry.includes("module-info") || entry.includes("package-info")) continue;
        const normalized = entry.replace(/^modules\//, "").replace(/^[^/]+\/(?=(?:java|javax)\/)/, "");
        if (!/^(java|javax)\//.test(normalized) || normalized.includes("/internal/")) continue;
        const qualifiedName = normalized.slice(0, -6).replaceAll("/", ".");
        suggestions.push({ simpleName: qualifiedName.split(".").pop()!, qualifiedName, source: "dependency" });
      }
    }
    return suggestions;
  }

  private consumeDebugOutput(data: string): void {
    this.onProcessEvent({ type: "output", data });
    this.debugBuffer = (this.debugBuffer + data).slice(-20_000);
    const stopped = this.debugBuffer.match(/(?:Breakpoint hit:|Step completed:)\s+"[^"]+",\s+([\w$]+(?:\.[\w$]+)*)\.([\w$<>]+)\([^)]*\),\s+line=(\d+)/);
    if (stopped) {
      this.debugLocation = { className: stopped[1]!, method: stopped[2]!, line: Number(stopped[3]) };
      this.awaitingDebugLocals = true;
      this.debugBuffer = "";
      this.process?.stdin.write("locals\n");
      return;
    }
    if (!this.awaitingDebugLocals || !/[\w$]+\[\d+\]\s*$/.test(this.debugBuffer) || !this.debugLocation) return;
    const variables = [...this.debugBuffer.matchAll(/^\s*([A-Za-z_$][\w$]*)\s+=\s+(.+)$/gm)].slice(-100).map((match) => ({ name: match[1]!, value: match[2]!.trim() }));
    this.onProcessEvent({ type: "debug", state: { status: "paused", ...this.debugLocation, variables } });
    this.awaitingDebugLocals = false;
    this.debugBuffer = "";
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
