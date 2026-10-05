import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { JavaApplyChangesResult, JavaBreakpoint, JavaDebugVariable, JavaDebugState, JavaDiagnostic, JavaMainClass, JavaProjectNode, JavaProjectOptions, JavaTypeSuggestion } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";
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
  private pendingInspection?: { resolve: (output: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
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
    if (this.process || this.debugStarting) throw new CoreError("JAVA_PROCESS_FAILED", "Java checks are unavailable while a build, run, or debug process is active");
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
      this.debugBreakpoints = breakpoints.map((breakpoint) => {
        if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(breakpoint.className) || !Number.isSafeInteger(breakpoint.line) || breakpoint.line < 1) throw new CoreError("INVALID_REQUEST", "Invalid Java breakpoint");
        return { ...breakpoint };
      });
      ensureLaunching();
      this.emitDebugState({ status: "starting", variables: [] });
      await this.runAndWait(options.mavenExecutable, ["-f", options.pomPath, "package", "-DskipTests", "-Dmaven.compiler.debug=true", "-Dmaven.compiler.debuglevel=lines,vars,source"], "Debug build");
      ensureLaunching();
      const classpath = await this.buildDebugClasspath(options);
      ensureLaunching();
      this.debugClassFiles = await this.snapshotDebugClasses(options);
      ensureLaunching();
      const child = spawn("jdb", ["-classpath", classpath, configuration.mainClass], { cwd: this.filesystem.getWorkspace(), env: process.env, stdio: "pipe" });
      this.process = child;
      this.debugging = true;
      this.invalidateDebugInspection();
      this.debugBuffer = "";
      child.stdout.on("data", (data: Buffer) => this.consumeDebugOutput(data.toString()));
      child.stderr.on("data", (data: Buffer) => this.consumeDebugOutput(data.toString()));
      child.on("error", (error) => this.onProcessEvent({ type: "output", data: `Debugger failed to start: ${error.message}\n` }));
      child.on("close", (exitCode, signal) => {
        if (this.process !== child) return;
        this.invalidateDebugInspection();
        this.process = undefined; this.debugging = false;
        this.applyBuildProcess?.kill("SIGTERM");
        this.emitDebugState({ status: "stopped", variables: [] });
        this.onProcessEvent({ type: "exit", exitCode, signal });
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      for (const breakpoint of this.debugBreakpoints) child.stdin.write(`stop at ${breakpoint.className}:${breakpoint.line}\n`);
      child.stdin.write("run\n");
      this.emitDebugState({ status: "running", variables: [] });
    } catch (error) {
      this.emitDebugState({ status: "stopped", variables: [] });
      throw error;
    } finally { this.debugStarting = false; }
  }

  debugCommand(command: "continue" | "stepInto" | "stepOver" | "stepOut"): void {
    if (!this.process || !this.debugging) throw new CoreError("JAVA_PROCESS_FAILED", "No Java debugger is active");
    if (this.applyingChanges) throw new CoreError("JAVA_PROCESS_FAILED", "Wait for code changes to finish applying");
    if (!this.debugPaused) throw new CoreError("JAVA_PROCESS_FAILED", "Pause the Java debugger before stepping");
    this.invalidateDebugInspection();
    const jdbCommand = { continue: "cont", stepInto: "step", stepOver: "next", stepOut: "step up" }[command];
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
      if (target.length !== undefined) {
        const end = Math.min(target.length, start + 50);
        const variables: JavaDebugVariable[] = [];
        for (let index = start; index < end; index++) {
          const expression = `${target.expression}[${index}]`;
          const output = await this.inspectDebugExpression(expression);
          if (generation !== this.debugGeneration) throw new CoreError("INVALID_REQUEST", "Debugger pause ended during inspection");
          const value = output.match(/ = ([\s\S]*?)\s*[\w$.-]+\[\d+\]\s*$/)?.[1]?.trim();
          if (value === undefined) throw new CoreError("JAVA_PROCESS_FAILED", output.trim());
          variables.push(this.debugVariable(`[${index}]`, value, expression));
        }
        return { variables, ...(end < target.length ? { nextStart: end } : {}) };
      }
      const output = await this.inspectDebugExpression(target.expression);
      if (generation !== this.debugGeneration) throw new CoreError("INVALID_REQUEST", "Debugger pause ended during inspection");
      if (!/ = \{/.test(output)) throw new CoreError("JAVA_PROCESS_FAILED", output.trim());
      const variables = [...output.matchAll(/^\s*([\w$.]+): (.+)$/gm)].map((match) =>
        this.debugVariable(match[1]!, match[2]!.trim(), `${target.expression}.${match[1]!.split(".").pop()}`));
      if (variables.length === 0) {
        const body = output.match(/ = \{([\s\S]*?)\n\}/)?.[1]?.trim() ?? "";
        const elements = body.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\r\n]+/g) ?? [];
        const end = Math.min(elements.length, start + 50);
        return { variables: elements.slice(start, end).map((value, offset) => this.debugVariable(`[${start + offset}]`, value.trim(), `${target.expression}[${start + offset}]`)), ...(end < elements.length ? { nextStart: end } : {}) };
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

  private runDebugCommand(command: string): Promise<string> {
    if (!this.debugPaused || !this.process) return Promise.reject(new CoreError("JAVA_PROCESS_FAILED", "Java debugger is no longer paused"));
    if (this.pendingInspection) return Promise.reject(new CoreError("JAVA_PROCESS_FAILED", "A debugger command is already pending"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Stop accepting inspections until the next pause: a late prompt must not resolve another request.
        this.invalidateDebugInspection();
        this.debugPaused = true;
      }, 10_000);
      this.debugBuffer = "";
      this.pendingInspection = { resolve, reject, timer };
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
      const args = ["-f", options.pomPath, "compile", "test-compile", "-DskipTests", "-Dmaven.compiler.debug=true", "-Dmaven.compiler.debuglevel=lines,vars,source"];
      this.onProcessEvent({ type: "output", data: `> ${options.mavenExecutable} ${args.join(" ")}\n` });
      const child = spawn(options.mavenExecutable, args, { cwd: this.filesystem.getWorkspace(), env: process.env, stdio: "pipe" });
      this.applyBuildProcess = child;
      child.stdout.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.stderr.on("data", (data: Buffer) => this.onProcessEvent({ type: "output", data: data.toString() }));
      child.on("error", (error) => reject(new CoreError("JAVA_PROCESS_FAILED", `Compile failed: ${error.message}`)));
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
      const options = await this.requireOptions();
      await this.compileDebugChanges(options);
      ensurePaused();
      const next = await this.snapshotDebugClasses(options);
      const changed = [...next].filter(([name, entry]) => this.debugClassFiles.get(name)?.hash !== entry.hash);
      const classesOutput = await this.runDebugCommand("classes");
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
        if (!/(?:Set|Deferring) breakpoint/.test(output)) this.onProcessEvent({ type: "output", data: `Breakpoint could not be restored: ${breakpoint.className}:${breakpoint.line}\n` });
      }
      return result;
    } finally {
      if (this.process === child && this.debugPaused) {
        this.debugReferences.clear();
        try {
          const output = await this.runDebugCommand("locals");
          const variables = [...output.matchAll(/^\s*([A-Za-z_$][\w$]*)\s+=\s+(.+)$/gm)].map((match) => this.debugVariable(match[1]!, match[2]!.trim(), match[1]!));
          if (this.process === child && this.debugPaused) this.emitDebugState({ ...this.debugState, applyingChanges: false, variables });
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
    if (this.pendingInspection && this.debugBuffer.length + data.length > 1_000_000) {
      this.invalidateDebugInspection();
      this.debugPaused = true;
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
    const stopped = this.debugBuffer.match(/(?:Breakpoint hit:|Step completed:)\s+"[^"]+",\s+([\w$]+(?:\.[\w$]+)*)\.([\w$<>]+)\([^)]*\),\s+line=(\d+)/);
    if (stopped) {
      this.invalidateDebugInspection();
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
    this.emitDebugState({ status: "paused", ...this.debugLocation, variables, ...(inspectionError ? { inspectionError } : {}) });
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
