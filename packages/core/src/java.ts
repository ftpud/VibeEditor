import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { FileRevision, JavaToolCheck, JavaRunConfiguration, JavaApplyChangesResult, JavaBreakpoint, JavaDebugVariable, JavaDebugState, JavaDiagnostic, JavaMainClass, JavaProjectNode, JavaProjectOptions, JavaTypeSuggestion } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";
import { javaConfigurationPath } from "@remote-ide/protocol";
import { expandJavaToolPath, javaConfigurationTemplate, javaSpawnError, javaToolEnvironment, javaToolExecutable, parseJavaConfiguration, readJavaConfiguration, writeJavaConfiguration } from "./java-configuration.js";
import { WorkspaceStateStore } from "./workspace-state.js";

type JavaProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null; signal: string | null }
  | { type: "debug"; state: JavaDebugState };

export class JavaProjectService {
  private process?: ChildProcessWithoutNullStreams;
  private debugStarting = false;
  private debugLaunchGeneration = 0;
  private debugging = false;
  private debugTarget?: ChildProcessWithoutNullStreams;
  private activeDebugOptions?: JavaProjectOptions;
  private debugState: JavaDebugState = { status: "stopped", variables: [] };
  private debugGeneration = 0;
  private applyingChanges = false;
  private applyBuildProcess?: ChildProcessWithoutNullStreams;
  private debugClassFiles = new Map<string, { file: string; hash: string }>();
  private debugBreakpoints: JavaBreakpoint[] = [];
  private debugBuffer = "";
  private debugLocation?: { className: string; method: string; line: number };
  private awaitingDebugLocals = false;
  private awaitingDebugStopPrompt = false;
  private debugReferences = new Map<string, { expression: string; length?: number }>();
  private debugPaused = false;
  private inspectionQueue: Promise<unknown> = Promise.resolve();
  private pendingInspection?: { quiet?: boolean; resolve: (output: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
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
    const existing = await this.getOptions();
    if (existing?.pomPath === pomPath) {
      for (const existingRoot of existing.sourceRoots) if (!sourceRoots.includes(existingRoot)) sourceRoots.push(existingRoot);
    }
    const options: JavaProjectOptions = {
      type: "maven",
      pomPath,
      mavenExecutable: existing?.pomPath === pomPath ? existing.mavenExecutable : await this.detectMavenExecutable(pomPath),
      ...(existing?.pomPath === pomPath ? { javaHome: existing.javaHome, mavenArguments: existing.mavenArguments, buildGoals: existing.buildGoals } : {}),
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
    const file = await readJavaConfiguration(this.filesystem);
    return file ? parseJavaConfiguration(file.content) : (await this.state.load()).javaProject;
  }

  async readConfiguration(): Promise<{ path: string; content: string; revision?: FileRevision; template: string }> {
    const file = await readJavaConfiguration(this.filesystem);
    let options = (await this.state.load()).javaProject;
    if (file) { try { options = parseJavaConfiguration(file.content); } catch { /* Keep invalid JSON accessible for repair. */ } }
    options ??= { type: "maven", pomPath: "pom.xml", mavenExecutable: await this.detectMavenExecutable("pom.xml"), sourceRoots: ["src/main/java", "src/test/java"], outputPath: "target/classes", testOutputPath: "target/test-classes", runConfigurations: [] };
    const template = javaConfigurationTemplate(options);
    return { path: javaConfigurationPath, content: file?.content ?? JSON.stringify(options, null, 2) + "\n", revision: file?.revision, template };
  }

  async saveConfiguration(content: string, expectedRevision?: FileRevision): Promise<{ options: JavaProjectOptions; content: string; revision: FileRevision }> {
    if (this.process || this.debugStarting || this.applyingChanges) throw new CoreError("JAVA_PROCESS_FAILED", "Stop the Java process before changing its configuration");
    const options = parseJavaConfiguration(content);
    await this.filesystem.resolveExisting(options.pomPath);
    for (const profile of options.runConfigurations) await this.launchDirectory(profile);
    const normalized = JSON.stringify(options, null, 2) + "\n";
    const revision = await writeJavaConfiguration(this.filesystem, normalized, expectedRevision);
    await this.state.save({ ...(await this.state.load()), javaProject: options });
    this.dependencyTypes = undefined;
    return { options, content: normalized, revision };
  }

  async checkTools(content: string): Promise<JavaToolCheck[]> {
    const options = parseJavaConfiguration(content);
    const workspace = this.filesystem.getWorkspace();
    const tools = [
      { tool: "Maven" as const, executable: expandJavaToolPath(options.mavenExecutable, workspace), args: ["--version"] },
      { tool: "Java" as const, executable: javaToolExecutable(options, "java", workspace), args: ["-version"] },
      { tool: "Java compiler" as const, executable: javaToolExecutable(options, "javac", workspace), args: ["-version"] },
      { tool: "Java debugger" as const, executable: javaToolExecutable(options, "jdb", workspace), args: ["-version"] }
    ];
    return Promise.all(tools.map(({ tool, executable, args }) => new Promise<JavaToolCheck>((resolve) => {
      const child = spawn(executable, args, { cwd: workspace, env: javaToolEnvironment(options, workspace), stdio: "pipe" });
      let output = "";
      const append = (data: Buffer) => { output = (output + data.toString()).slice(-4000); };
      child.stdout.on("data", append); child.stderr.on("data", append);
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ tool, executable, ok: false, message: "Tool check timed out after 15 seconds. Verify the executable on the Core host." }); }, 15_000);
      child.on("error", (error) => { clearTimeout(timer); resolve({ tool, executable, ok: false, message: javaSpawnError(error, executable, tool).message }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ tool, executable, ok: code === 0, message: output.trim() || `Exited with code ${code}` }); });
    })));
  }

  private async detectMavenExecutable(pomPath: string): Promise<string> {
    for (const root of [...new Set([path.posix.dirname(pomPath), "."])]) {
      const wrapper = path.posix.join(root, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
      try { if ((await stat(await this.filesystem.resolveExisting(wrapper))).isFile()) return `./${wrapper}`; }
      catch { /* A project wrapper is optional. */ }
    }
    return "mvn";
  }

  private async launchDirectory(profile: JavaRunConfiguration): Promise<string> {
    if (!profile.workingDirectory || profile.workingDirectory === ".") return this.filesystem.getWorkspace();
    const directory = await this.filesystem.resolveExisting(profile.workingDirectory);
    if (!(await stat(directory)).isDirectory()) throw new CoreError("INVALID_REQUEST", `Working directory is not a directory: ${profile.workingDirectory}`);
    return directory;
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

  async build(): Promise<void> { const options = await this.requireOptions(); await this.start(options.buildGoals ?? ["package", "-DskipTests"], "Build"); }
  async check(): Promise<JavaDiagnostic[]> {
    if (this.process || this.debugStarting) throw new CoreError("JAVA_PROCESS_FAILED", "Java checks are unavailable while a build, run, or debug process is active");
    const options = await this.requireOptions();
    const output = await this.capture(options.mavenExecutable, ["-f", options.pomPath, "compile", "-DskipTests", "-Dstyle.color=never"], options, "Java check");
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
    if (!this.dependencyTypes && !this.process && !this.debugStarting) this.dependencyTypes = await this.indexDependencyTypes(options);
    const lower = normalized.toLowerCase();
    return [...projectTypes, ...(this.dependencyTypes ?? [])]
      .filter((item) => item.simpleName.toLowerCase().startsWith(lower))
      .filter((item, index, all) => all.findIndex((candidate) => candidate.qualifiedName === item.qualifiedName) === index)
      .sort((a, b) => Number(b.simpleName === normalized) - Number(a.simpleName === normalized) || a.simpleName.localeCompare(b.simpleName) || a.qualifiedName.localeCompare(b.qualifiedName))
      .slice(0, 100);
  }
  async run(): Promise<void> {
    if (this.process || this.debugStarting) throw new CoreError("JAVA_PROCESS_FAILED", "A Java process is already active");
    this.debugStarting = true;
    const launch = ++this.debugLaunchGeneration;
    try {
      const options = await this.requireOptions();
      const configuration = options.runConfigurations.find((item) => item.id === options.selectedRunConfigurationId);
      if (!configuration) throw new CoreError("JAVA_PROCESS_FAILED", "Choose a launch profile in Java configuration first");
      if (launch !== this.debugLaunchGeneration) throw new CoreError("JAVA_PROCESS_FAILED", "Java run was cancelled");
      await this.runAndWait(options.mavenExecutable, ["-f", options.pomPath, ...(options.buildGoals ?? ["package", "-DskipTests"])], "Run build", options);
      if (launch !== this.debugLaunchGeneration) throw new CoreError("JAVA_PROCESS_FAILED", "Java run was cancelled");
      const classpath = await this.buildDebugClasspath(options);
      const cwd = await this.launchDirectory(configuration);
      if (launch !== this.debugLaunchGeneration) throw new CoreError("JAVA_PROCESS_FAILED", "Java run was cancelled");
      const executable = javaToolExecutable(options, "java", this.filesystem.getWorkspace());
      const child = spawn(executable, [...(configuration.vmArguments ?? []), "-classpath", classpath, configuration.mainClass, ...(configuration.programArguments ?? [])], { cwd, env: javaToolEnvironment(options, this.filesystem.getWorkspace(), configuration.environment), stdio: "pipe" });
      this.process = child;
      this.onProcessEvent({ type: "output", data: `> Run ${configuration.name} (${configuration.mainClass})\n` });
      child.stdout.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.stderr.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.on("close", (exitCode, signal) => { if (this.process === child) { this.process = undefined; this.onProcessEvent({ type: "exit", exitCode, signal }); } });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", (error) => reject(javaSpawnError(error, executable, "Java run"))); });
    } finally { this.debugStarting = false; }
  }

  private async launchDebugTarget(options: JavaProjectOptions, configuration: JavaRunConfiguration, launch: number): Promise<string> {
    const workspace = this.filesystem.getWorkspace();
    const cwd = await this.launchDirectory(configuration);
    const executable = javaToolExecutable(options, "java", workspace);
    const classpath = await this.buildDebugClasspath(options);
    if (launch !== this.debugLaunchGeneration) throw new CoreError("JAVA_PROCESS_FAILED", "Debugger start was cancelled");
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...(configuration.vmArguments ?? []), "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0", "-classpath", classpath, configuration.mainClass, ...(configuration.programArguments ?? [])], { cwd, env: javaToolEnvironment(options, workspace, configuration.environment), stdio: "pipe" });
      this.debugTarget = child;
      this.process = child;
      let buffer = "";
      let ready = false;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new CoreError("JAVA_PROCESS_FAILED", "Debug JVM did not start within 15 seconds. Check JDK home and VM arguments in Java configuration.")); }, 15_000);
      const consume = (data: Buffer) => {
        const text = data.toString();
        this.onProcessEvent({ type: "output", data: text });
        if (ready) return;
        buffer = (buffer + text).slice(-4000);
        const port = buffer.match(/Listening for transport dt_socket at address: (\d+)/)?.[1];
        if (port) { ready = true; clearTimeout(timer); resolve(`127.0.0.1:${port}`); }
      };
      child.stdout.on("data", consume); child.stderr.on("data", consume);
      child.on("error", (error) => { clearTimeout(timer); reject(javaSpawnError(error, executable, "Debug JVM")); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (this.debugTarget === child) this.debugTarget = undefined;
        if (this.process === child) this.process = undefined;
        if (!ready) reject(new CoreError("JAVA_PROCESS_FAILED", `Debug JVM exited before connecting (code ${code}). ${buffer.trim()}`));
      });
    });
  }

  async debug(breakpoints: JavaBreakpoint[]): Promise<void> {
    if (this.process || this.debugStarting) throw new CoreError("JAVA_PROCESS_FAILED", "A Java build, run, or debug process is already active");
    this.debugStarting = true;
    const launch = ++this.debugLaunchGeneration;
    const ensureLaunching = () => {
      if (launch !== this.debugLaunchGeneration) throw new CoreError("JAVA_PROCESS_FAILED", "Debugger start was cancelled");
    };
    try {
      const options = await this.requireOptions();
      const configuration = options.runConfigurations.find((item) => item.id === options.selectedRunConfigurationId);
      if (!configuration) throw new CoreError("JAVA_PROCESS_FAILED", "Select a Java run configuration first");
      if (!Array.isArray(breakpoints) || breakpoints.length > 1000) throw new CoreError("INVALID_REQUEST", "Invalid Java breakpoints");
      this.debugBreakpoints = breakpoints.map((breakpoint) => {
        if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(breakpoint.className) || !Number.isSafeInteger(breakpoint.line) || breakpoint.line < 1) throw new CoreError("INVALID_REQUEST", "Invalid Java breakpoint");
        return { ...breakpoint };
      });
      ensureLaunching();
      this.emitDebugState({ status: "starting", variables: [] });
      await this.runAndWait(options.mavenExecutable, ["-f", options.pomPath, ...(options.buildGoals ?? ["package", "-DskipTests"]), "-Dmaven.compiler.debug=true", "-Dmaven.compiler.debuglevel=lines,vars,source"], "Debug build", options);
      ensureLaunching();
      this.activeDebugOptions = options;
      this.debugClassFiles = await this.snapshotDebugClasses(options);
      ensureLaunching();
      const address = await this.launchDebugTarget(options, configuration, launch);
      ensureLaunching();
      const executable = javaToolExecutable(options, "jdb", this.filesystem.getWorkspace());
      const child = spawn(executable, ["-attach", address], { cwd: this.filesystem.getWorkspace(), env: javaToolEnvironment(options, this.filesystem.getWorkspace()), stdio: "pipe" });
      this.process = child;
      this.debugging = true;
      this.invalidateDebugInspection();
      this.debugBuffer = "";
      child.stdout.on("data", (data: Buffer) => this.consumeDebugOutput(data.toString()));
      child.stderr.on("data", (data: Buffer) => this.consumeDebugOutput(data.toString()));
      child.on("error", (error) => this.onProcessEvent({ type: "output", data: `${javaSpawnError(error, executable, "Java debugger").message}\n` }));
      child.on("close", (exitCode, signal) => {
        if (this.process !== child) return;
        this.invalidateDebugInspection();
        this.process = undefined; this.debugging = false;
        this.applyBuildProcess?.kill("SIGTERM");
        this.debugTarget?.kill("SIGTERM");
        this.activeDebugOptions = undefined;
        this.emitDebugState({ status: "stopped", variables: [] });
        this.onProcessEvent({ type: "exit", exitCode, signal });
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", (error) => reject(javaSpawnError(error, executable, "Java debugger"))); });
      ensureLaunching();
      for (const breakpoint of this.debugBreakpoints) child.stdin.write(`stop at ${breakpoint.className}:${breakpoint.line}\n`);
      child.stdin.write("cont\n");
      this.emitDebugState({ status: "running", variables: [] });
    } catch (error) {
      this.debugTarget?.kill("SIGTERM");
      this.emitDebugState({ status: "stopped", variables: [] });
      throw error;
    } finally { this.debugStarting = false; }
  }

  debugCommand(command: "continue" | "stepInto" | "stepOver" | "stepOut"): void {
    if (!this.process || !this.debugging) throw new CoreError("JAVA_PROCESS_FAILED", "No Java debugger is active");
    if (this.applyingChanges) throw new CoreError("JAVA_PROCESS_FAILED", "Wait for code changes to finish applying");
    if (!this.debugPaused) throw new CoreError("JAVA_PROCESS_FAILED", "Pause the Java debugger before stepping");
    const jdbCommands = { continue: "cont", stepInto: "step", stepOver: "next", stepOut: "step up" };
    if (!Object.hasOwn(jdbCommands, command)) throw new CoreError("INVALID_REQUEST", "Unknown Java debugger command");
    const jdbCommand = jdbCommands[command];
    this.invalidateDebugInspection();
    this.process.stdin.write(`${jdbCommand}\n`);
    this.emitDebugState({ status: "running", variables: [] });
  }

  async debugVariables(reference: string, start = 0): Promise<{ variables: JavaDebugVariable[]; nextStart?: number }> {
    if (this.applyingChanges) throw new CoreError("JAVA_PROCESS_FAILED", "Wait for code changes to finish applying");
    const generation = this.debugGeneration;
    const inspect = async () => {
      if (generation !== this.debugGeneration) throw new CoreError("INVALID_REQUEST", "This object belongs to an expired debugger pause");
      const target = this.debugReferences.get(reference);
      if (!this.debugPaused || !target) throw new CoreError("INVALID_REQUEST", "This object belongs to an expired debugger pause");
      if (!Number.isSafeInteger(start) || start < 0) throw new CoreError("INVALID_REQUEST", "Invalid array offset");
      const readArray = async (length: number) => {
        const end = Math.min(length, start + 50);
        const variables: JavaDebugVariable[] = [];
        for (let index = start; index < end; index++) {
          const expression = `${target.expression}[${index}]`;
          const output = await this.inspectDebugExpression(expression);
          if (generation !== this.debugGeneration) throw new CoreError("INVALID_REQUEST", "Debugger pause ended during inspection");
          const value = output.match(/ = ([\s\S]*?)\s*[\w$.-]+\[\d+\]\s*$/)?.[1]?.trim();
          if (value === undefined) throw new CoreError("JAVA_PROCESS_FAILED", output.trim());
          variables.push(this.debugVariable(`[${index}]`, value, expression));
        }
        return { variables, ...(end < length ? { nextStart: end } : {}) };
      };
      if (target.length !== undefined) return readArray(target.length);
      const output = await this.inspectDebugExpression(target.expression);
      if (generation !== this.debugGeneration) throw new CoreError("INVALID_REQUEST", "Debugger pause ended during inspection");
      if (!/ = \{/.test(output)) throw new CoreError("JAVA_PROCESS_FAILED", output.trim());
      const variables = [...output.matchAll(/^\s*([\w$.]+): (.+)$/gm)].map((match) => {
        const name = match[1]!;
        const separator = name.lastIndexOf(".");
        const expression = separator < 0 ? `${target.expression}.${name}` : `((${name.slice(0, separator)})${target.expression}).${name.slice(separator + 1)}`;
        return this.debugVariable(name, match[2]!.trim(), expression);
      });
      if (variables.length === 0) {
        // An array element's dump has no identity/length header. Query its length rather than
        // splitting jdb's unescaped strings on commas, which corrupts string array values.
        const lengthOutput = await this.inspectDebugExpression(`${target.expression}.length`);
        if (generation !== this.debugGeneration) throw new CoreError("INVALID_REQUEST", "Debugger pause ended during inspection");
        const length = lengthOutput.match(/ = (\d+)\s*[\w$.-]+\[\d+\]\s*$/)?.[1];
        if (length !== undefined) {
          target.length = Number(length);
          return readArray(target.length);
        }
      }
      return { variables };
    };
    const result = this.inspectionQueue.then(inspect);
    this.inspectionQueue = result.catch(() => undefined);
    return result;
  }

  private debugVariable(name: string, value: string, expression: string): JavaDebugVariable {
    const object = value.match(/^instance of (.+?)\s*\(id=(\d+)\)$/);
    if (!object) {
      if (value.startsWith("{")) {
        const reference = crypto.randomUUID();
        this.debugReferences.set(reference, { expression });
        return { name, value: "Object / array", reference };
      }
      return { name, value };
    }
    const type = object[1]!;
    const length = type.match(/\[(\d+)\]$/)?.[1];
    const reference = crypto.randomUUID();
    this.debugReferences.set(reference, { expression, ...(length !== undefined ? { length: Number(length) } : {}) });
    return { name, value, type, objectId: object[2]!, reference, ...(length !== undefined ? { indexedCount: Number(length) } : {}) };
  }

  private inspectDebugExpression(expression: string): Promise<string> {
    if (!this.debugPaused || !this.process) return Promise.reject(new CoreError("JAVA_PROCESS_FAILED", "Java debugger is no longer paused"));
    return this.runDebugCommand(`dump ${expression}`);
  }

  private runDebugCommand(command: string, quiet = false): Promise<string> {
    if (!this.debugPaused || !this.process) return Promise.reject(new CoreError("JAVA_PROCESS_FAILED", "Java debugger is no longer paused"));
    if (this.pendingInspection) return Promise.reject(new CoreError("JAVA_PROCESS_FAILED", "A debugger command is already pending"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Stop accepting inspections until the next pause: a late prompt must not resolve another request.
        this.invalidateDebugInspection();
        this.debugPaused = true;
        this.emitDebugState({ status: "paused", ...this.debugLocation, variables: [], applyingChanges: this.applyingChanges, inspectionError: "Debugger inspection timed out. Step or continue to refresh the pause." });
      }, 10_000);
      this.debugBuffer = "";
      this.pendingInspection = { resolve, reject, timer, quiet };
      this.process!.stdin.write(`${command}\n`);
    });
  }

  private invalidateDebugInspection(): void {
    this.debugGeneration++;
    this.debugPaused = false;
    this.debugReferences.clear();
    this.awaitingDebugLocals = false;
    this.awaitingDebugStopPrompt = false;
    if (this.pendingInspection) {
      clearTimeout(this.pendingInspection.timer);
      this.pendingInspection.reject(new CoreError("JAVA_PROCESS_FAILED", "Debugger inspection ended; pause again to inspect values"));
      this.pendingInspection = undefined;
    }
  }

  private async publishDebugPause(state: JavaDebugState): Promise<void> {
    const generation = this.debugGeneration;
    if (state.method !== "main") {
      try {
        const output = await this.runDebugCommand("dump this", true);
        if (generation !== this.debugGeneration || !this.debugPaused) return;
        if (/ this = \{/.test(output)) {
          const reference = crypto.randomUUID();
          this.debugReferences.set(reference, { expression: "this" });
          state = { ...state, variables: [{ name: "this", value: state.className ?? "Current instance", reference, type: state.className }, ...state.variables] };
        }
      } catch { /* Static methods have no current instance; locals remain inspectable. */ }
    }
    if (generation === this.debugGeneration && this.debugPaused) this.emitDebugState(state);
  }

  private emitDebugState(state: JavaDebugState): void {
    this.debugState = state;
    this.onProcessEvent({ type: "debug", state });
  }

  private async snapshotDebugClasses(options: JavaProjectOptions): Promise<Map<string, { file: string; hash: string }>> {
    const files = new Map<string, { file: string; hash: string }>();
    const visit = async (directory: string, prefix: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        const relative = prefix ? `${prefix}.${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(file, relative);
        else if (entry.isFile() && entry.name.endsWith(".class") && entry.name !== "module-info.class") {
          const className = relative.slice(0, -6);
          if (!files.has(className)) files.set(className, { file, hash: crypto.createHash("sha256").update(await readFile(file)).digest("hex") });
        }
      }
    };
    for (const output of [options.outputPath, options.testOutputPath]) {
      let directory: string;
      try { directory = await this.filesystem.resolveExisting(output); }
      catch (error) { if (error instanceof CoreError && error.code === "FILE_NOT_FOUND") continue; throw error; }
      await visit(directory, "");
    }
    return files;
  }

  private compileDebugChanges(options: JavaProjectOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [...(options.mavenArguments ?? []), "-f", options.pomPath, "compile", "test-compile", "-DskipTests", "-Dmaven.compiler.debug=true", "-Dmaven.compiler.debuglevel=lines,vars,source"];
      this.onProcessEvent({ type: "output", data: `> ${options.mavenExecutable} ${args.join(" ")}\n` });
      const child = spawn(expandJavaToolPath(options.mavenExecutable, this.filesystem.getWorkspace()), args, { cwd: this.filesystem.getWorkspace(), env: javaToolEnvironment(options, this.filesystem.getWorkspace()), stdio: "pipe" });
      this.applyBuildProcess = child;
      child.stdout.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.stderr.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.on("error", (error) => reject(javaSpawnError(error, options.mavenExecutable, "Compile")));
      child.on("close", (code) => {
        if (this.applyBuildProcess === child) this.applyBuildProcess = undefined;
        if (code === 0) resolve();
        else reject(new CoreError("JAVA_PROCESS_FAILED", "Compilation failed. No code changes were applied; see Build Output."));
      });
    });
  }

  async applyDebugChanges(): Promise<JavaApplyChangesResult> {
    if (!this.debugPaused || !this.process || this.applyingChanges) throw new CoreError("JAVA_PROCESS_FAILED", "Pause the Java debugger before applying code changes");
    const child = this.process;
    const generation = this.debugGeneration;
    this.applyingChanges = true;
    this.emitDebugState({ ...this.debugState, applyingChanges: true });
    const ensurePaused = () => {
      if (this.process !== child || !this.debugPaused || this.debugGeneration !== generation) throw new CoreError("JAVA_PROCESS_FAILED", "Debugger pause ended while applying changes");
    };
    const result: JavaApplyChangesResult = { appliedClasses: [], deferredClasses: [], failedClasses: [], restartRequired: false };
    try {
      await this.inspectionQueue;
      ensurePaused();
      const options = this.activeDebugOptions ?? await this.requireOptions();
      await this.compileDebugChanges(options);
      ensurePaused();
      const next = await this.snapshotDebugClasses(options);
      const changed = [...next].filter(([name, entry]) => this.debugClassFiles.get(name)?.hash !== entry.hash);
      const classesOutput = await this.runDebugCommand("classes", true);
      ensurePaused();
      const loaded = new Set(classesOutput.split(/\r?\n/).map((line) => line.trim()));
      if (!classesOutput.includes("** classes list **")) throw new CoreError("JAVA_PROCESS_FAILED", "Could not list loaded Java classes");
      const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "vibe-hotswap-"));
      try {
        for (const [className, entry] of changed) {
          ensurePaused();
          if (!loaded.has(className)) {
            result.deferredClasses.push(className);
            this.debugClassFiles.set(className, entry);
            continue;
          }
          // jdb tokenizes filenames on whitespace. A temporary file also freezes the bytes during reload.
          const file = path.join(temporaryDirectory, `${result.appliedClasses.length + result.failedClasses.length}.class`);
          if (/\s/.test(file)) throw new CoreError("JAVA_PROCESS_FAILED", "The debugger temporary directory must have a path without spaces");
          await writeFile(file, await readFile(entry.file));
          const output = await this.runDebugCommand(`redefine ${className} ${file}`);
          ensurePaused();
          const message = output.replace(/[\w$.-]+\[\d+\]\s*$/, "").trim();
          if (message) {
            result.failedClasses.push({ className, message });
            result.restartRequired = true;
          } else {
            result.appliedClasses.push(className);
            this.debugClassFiles.set(className, entry);
          }
        }
      } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
      for (const className of this.debugClassFiles.keys()) {
        if (!next.has(className) && loaded.has(className)) {
          result.failedClasses.push({ className, message: "Loaded class was removed. Restart to remove it from the JVM." });
          result.restartRequired = true;
        }
      }
      // HotSwap clears breakpoints in redefined classes. Restore the original line breakpoints.
      for (const breakpoint of this.debugBreakpoints.filter((item) => result.appliedClasses.includes(item.className))) {
        const output = await this.runDebugCommand(`stop at ${breakpoint.className}:${breakpoint.line}`);
        ensurePaused();
        if (!/(?:Set|Deferring) breakpoint/.test(output)) {
          const warning = `Breakpoint could not be restored: ${breakpoint.className}:${breakpoint.line}. Move it to an executable line and restart debugging.`;
          (result.warnings ??= []).push(warning);
          this.onProcessEvent({ type: "output", data: `${warning}\n` });
        }
      }
      return result;
    } finally {
      if (this.process === child && this.debugPaused) {
        this.debugReferences.clear();
        try {
          const output = await this.runDebugCommand("locals");
          const variables = [...output.matchAll(/^\s*([A-Za-z_$][\w$]*)\s+=\s+(.+)$/gm)].map((match) => this.debugVariable(match[1]!, match[2]!.trim(), match[1]!));
          if (this.process === child && this.debugPaused) await this.publishDebugPause({ ...this.debugState, applyingChanges: false, inspectionError: undefined, variables });
        } catch (error) {
          if (this.process === child && this.debugPaused) this.emitDebugState({ ...this.debugState, applyingChanges: false, variables: [], inspectionError: error instanceof Error ? error.message : String(error) });
        }
      }
      this.applyingChanges = false;
    }
  }

  stop(): void {
    this.debugLaunchGeneration++;
    this.applyBuildProcess?.kill("SIGTERM");
    this.debugTarget?.kill("SIGTERM");
    if (!this.process) return;
    const child = this.process;
    if (this.debugging) {
      this.invalidateDebugInspection();
      child.stdin.write("exit\n");
      setTimeout(() => { if (this.process === child) child.kill("SIGKILL"); }, 1_000).unref();
      return;
    }
    child.kill("SIGTERM");
  }

  close(): void { this.stop(); }

  private async start(goals: string[], label: string): Promise<void> {
    if (this.process || this.debugStarting) throw new CoreError("JAVA_PROCESS_FAILED", "A Java build or run process is already active");
    const options = await this.requireOptions();
    if (this.process || this.debugStarting) throw new CoreError("JAVA_PROCESS_FAILED", "A Java process is already active");
    this.onProcessEvent({ type: "output", data: `> ${options.mavenExecutable} -f ${options.pomPath} ${goals.join(" ")}\n` });
    try {
      const executable = expandJavaToolPath(options.mavenExecutable, this.filesystem.getWorkspace());
      const child = spawn(executable, [...(options.mavenArguments ?? []), "-f", options.pomPath, ...goals], { cwd: this.filesystem.getWorkspace(), env: javaToolEnvironment(options, this.filesystem.getWorkspace()), stdio: "pipe" });
      this.process = child;
      child.stdout.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.stderr.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.on("error", (error) => this.onProcessEvent({ type: "output", data: `${javaSpawnError(error, executable, label).message}\n` }));
      child.on("close", (exitCode, signal) => {
        if (this.process !== child) return;
        this.process = undefined;
        this.onProcessEvent({ type: "exit", exitCode, signal });
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", (error) => reject(javaSpawnError(error, executable, label))); });
    } catch (error) {
      this.process = undefined;
      if (error instanceof CoreError) throw error;
      throw new CoreError("JAVA_PROCESS_FAILED", `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private runAndWait(command: string, args: string[], label: string, options?: JavaProjectOptions): Promise<void> {
    if (options) { command = expandJavaToolPath(command, this.filesystem.getWorkspace()); args = [...(options.mavenArguments ?? []), ...args]; }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.filesystem.getWorkspace(), env: options ? javaToolEnvironment(options, this.filesystem.getWorkspace()) : process.env, stdio: "pipe" });
      this.process = child;
      child.stdout.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.stderr.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.on("error", (error) => { if (this.process === child) this.process = undefined; reject(javaSpawnError(error, command, label)); });
      child.on("close", (code) => {
        if (this.process === child) this.process = undefined;
        if (code === 0) resolve(); else reject(new CoreError("JAVA_PROCESS_FAILED", `${label} exited with code ${code}`));
      });
    });
  }

  private capture(command: string, args: string[], options?: JavaProjectOptions, label = "Java command", requireSuccess = false): Promise<string> {
    if (options && command === options.mavenExecutable) { command = expandJavaToolPath(command, this.filesystem.getWorkspace()); args = [...(options.mavenArguments ?? []), ...args]; }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.filesystem.getWorkspace(), env: options ? javaToolEnvironment(options, this.filesystem.getWorkspace()) : process.env, stdio: "pipe" });
      let output = "";
      child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
      child.on("error", (error) => reject(javaSpawnError(error, command, label)));
      child.on("close", (code) => { if (requireSuccess && code !== 0) reject(new CoreError("JAVA_PROCESS_FAILED", `${label} failed (code ${code}). ${output.slice(-2000)}`)); else resolve(output); });
    });
  }

  private async buildDebugClasspath(options: JavaProjectOptions, managed = true): Promise<string> {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "vibe-jdb-"));
    const classpathFile = path.join(temporaryDirectory, "classpath.txt");
    try {
      const args = ["-q", "-f", options.pomPath, "dependency:build-classpath", `-Dmdep.outputFile=${classpathFile}`];
      if (managed) await this.runAndWait(options.mavenExecutable, args, "Resolve debug classpath", options);
      else await this.capture(options.mavenExecutable, args, options, "Resolve dependency classpath", true);
      const dependencies = (await readFile(classpathFile, "utf8")).trim();
      const workspace = this.filesystem.getWorkspace();
      const outputs = [options.outputPath, options.testOutputPath].map((output) => path.resolve(workspace, output));
      return [...outputs, ...(dependencies ? dependencies.split(path.delimiter) : [])].join(path.delimiter);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async indexDependencyTypes(options: JavaProjectOptions): Promise<JavaTypeSuggestion[]> {
    const classpath = await this.buildDebugClasspath(options, false);
    const jars = classpath.split(path.delimiter).filter((entry) => entry.endsWith(".jar"));
    const suggestions: JavaTypeSuggestion[] = [];
    for (const jar of jars) {
      const listing = await this.capture(javaToolExecutable(options, "jar", this.filesystem.getWorkspace()), ["tf", jar], options).catch(() => "");
      for (const entry of listing.split(/\r?\n/)) {
        if (!entry.endsWith(".class") || entry.includes("$") || entry.endsWith("module-info.class") || entry.endsWith("package-info.class")) continue;
        const qualifiedName = entry.slice(0, -6).replaceAll("/", ".");
        const simpleName = qualifiedName.split(".").pop()!;
        suggestions.push({ simpleName, qualifiedName, source: "dependency" });
      }
    }
    const javaSettings = await this.capture(javaToolExecutable(options, "java", this.filesystem.getWorkspace()), ["-XshowSettings:properties", "-version"], options).catch(() => "");
    const javaHome = javaSettings.match(/^\s*java\.home\s*=\s*(.+)$/m)?.[1]?.trim();
    if (javaHome) {
      const listing = await this.capture(javaToolExecutable(options, "jimage", this.filesystem.getWorkspace()), ["list", path.join(javaHome, "lib", "modules")], options).catch(() => "");
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
    if (!this.pendingInspection?.quiet) this.onProcessEvent({ type: "output", data });
    if (this.pendingInspection && this.debugBuffer.length + data.length > 1_000_000) {
      this.invalidateDebugInspection();
      this.debugPaused = true;
      this.emitDebugState({ status: "paused", ...this.debugLocation, variables: [], applyingChanges: this.applyingChanges, inspectionError: "Debugger output exceeded the inspection limit. Step or continue to refresh the pause." });
      this.debugBuffer = "";
      return;
    }
    this.debugBuffer = (this.debugBuffer + data).slice(this.pendingInspection ? -1_000_000 : -20_000);
    if (this.pendingInspection) {
      if (/[\w$.-]+\[\d+\]\s*$/.test(this.debugBuffer)) {
        const pending = this.pendingInspection;
        this.pendingInspection = undefined;
        clearTimeout(pending.timer);
        pending.resolve(this.debugBuffer);
        this.debugBuffer = "";
      }
      return;
    }
    const stopped = this.debugBuffer.match(/(?:Breakpoint hit:|Step completed:|Exception occurred:)[\s\S]*?"thread=[^"]+",\s+([\w$]+(?:\.[\w$]+)*)\.([\w$<>]+)\([^)]*\),\s+line=(\d+)/);
    if (stopped) {
      this.invalidateDebugInspection();
      const exception = this.debugBuffer.match(/Exception occurred: (.*?)(?:"thread=|\r?\n)/)?.[1]?.trim();
      this.debugState = { status: "paused", variables: [], ...(exception ? { stopReason: exception } : {}) };
      this.debugLocation = { className: stopped[1]!, method: stopped[2]!, line: Number(stopped[3]) };
      this.awaitingDebugStopPrompt = true;
    }
    if (this.awaitingDebugStopPrompt) {
      if (!/[\w$.-]+\[\d+\]\s*$/.test(this.debugBuffer)) return;
      this.awaitingDebugStopPrompt = false;
      this.awaitingDebugLocals = true;
      this.debugBuffer = "";
      this.process?.stdin.write("locals\n");
      return;
    }
    if (!this.awaitingDebugLocals || !/[\w$.-]+\[\d+\]\s*$/.test(this.debugBuffer) || !this.debugLocation) return;
    const variables = [...this.debugBuffer.matchAll(/^\s*([A-Za-z_$][\w$]*)\s+=\s+(.+)$/gm)].map((match) => this.debugVariable(match[1]!, match[2]!.trim(), match[1]!));
    this.debugPaused = true;
    const inspectionError = this.debugBuffer.match(/(?:Local variable information not available[^\r\n]*|No default thread specified[^\r\n]*|.*obsolete.*)/i)?.[0];
    this.awaitingDebugLocals = false;
    this.debugBuffer = "";
    void this.publishDebugPause({ status: "paused", ...this.debugLocation, variables, ...(this.debugState.stopReason ? { stopReason: this.debugState.stopReason } : {}), ...(inspectionError ? { inspectionError } : {}) });
  }

  private async requireOptions(): Promise<JavaProjectOptions> {
    const options = await this.getOptions();
    if (!options) throw new CoreError("JAVA_NOT_CONFIGURED", "Load a pom.xml as a Maven project first");
    return options;
  }

  private async saveProject(javaProject: JavaProjectOptions): Promise<void> {
    const file = await readJavaConfiguration(this.filesystem);
    if (file) await writeJavaConfiguration(this.filesystem, JSON.stringify(javaProject, null, 2) + "\n", file.revision);
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
