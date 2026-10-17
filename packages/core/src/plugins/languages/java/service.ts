import type { JavaBreakpoint, JavaDebugState, JavaProjectNode } from "@remote-ide/protocol";
import { CoreError } from "../../../errors.js";
import { JavaProjectService, type JavaProcessEvent } from "./java.js";
import { JdtLanguageService } from "./jdtls.js";
import type { WorkspaceFileSystem } from "../../../filesystem.js";
import type { WorkspaceStateStore } from "../../../workspace-state.js";
import type { LanguageBreakpoint, LanguageDebugState, LanguageDescriptor, LanguageExtra, LanguageProjectNode, LanguageService, LanguageServiceEvents } from "../../../language/service.js";

export const JAVA_DESCRIPTOR: LanguageDescriptor = {
  id: "java", name: "Java", extensions: ["java"], projectMarkers: ["pom.xml", ".settings/java.json"],
  capabilities: { projectTree: true, build: true, run: true, debug: true, lsp: true, workspaceSymbols: true, configuration: true, runConfigurations: true, sourceRoots: true }
};

const extra = (value: unknown): LanguageExtra => (value && typeof value === "object" ? { ...(value as object) } : {}) as LanguageExtra;

function node(source: JavaProjectNode): LanguageProjectNode {
  const { javaType, children, ...rest } = source;
  return { ...rest, ...(children ? { children: children.map(node) } : {}), ...(javaType ? { extra: { javaType } } : {}) };
}

function debugState(state: JavaDebugState): LanguageDebugState {
  const { className, method, applyingChanges, variables, ...rest } = state;
  return {
    ...rest,
    variables: variables.map(({ objectId, ...variable }) => ({ ...variable, ...(objectId ? { extra: { objectId } } : {}) })),
    ...(method ? { frame: className ? `${className}.${method}` : method } : {}),
    ...(applyingChanges ? { busy: true } : {}),
    ...(className ? { extra: { className } } : {})
  };
}

/** Legacy `java.*` event hooks, kept until Desktop callers move to `language.*` events. */
export interface JavaLegacyEvents { process(event: JavaProcessEvent): void; semanticChanged(): void }

/**
 * Wraps the existing Java/Maven and JDT modules behind the language contract
 * without changing their behaviour. Java-only data (class names, hot-swap
 * results, Maven options) crosses the boundary as `extra`.
 */
export class JavaLanguageService implements LanguageService {
  readonly descriptor = JAVA_DESCRIPTOR;
  readonly java: JavaProjectService;
  readonly jdt: JdtLanguageService;

    constructor(private readonly filesystem: WorkspaceFileSystem, state: WorkspaceStateStore, events: LanguageServiceEvents, stateDirectory?: string, legacy?: JavaLegacyEvents) {
    this.jdt = new JdtLanguageService(filesystem, stateDirectory);
    this.java = new JavaProjectService(filesystem, state, (event) => {
      if (event.type === "output") events.output(event.data, "stdout");
      else if (event.type === "exit") events.exit(event.exitCode, event.signal);
      else events.debugState(debugState(event.state));
      legacy?.process(event);
    }, async () => {
      try { await this.jdt.rebuild(); } finally { events.semanticChanged(); legacy?.semanticChanged(); }
    });
  }

  async detect(): Promise<boolean> { return (await this.java.getOptions()) !== undefined; }
  async load(input?: LanguageExtra): Promise<LanguageExtra> {
    const pomPath = this.validateExtra("load", input).pomPath;
    const { options, tree } = await this.java.loadMavenProject(pomPath as string);
    return { options, tree: tree.map(node) };
  }
  async options(): Promise<LanguageExtra> { return extra(await this.java.getOptions()); }
  async projectTree(): Promise<LanguageProjectNode[]> { return (await this.java.getProjectTree()).map(node); }
  async addSourceRoot(path: string): Promise<void> { await this.java.addSourceRoot(path); }
  workspaceSymbols(query: string, limit?: number) { return this.jdt.workspaceSymbols(query, limit); }
  checkTools(content?: string) { return this.java.checkTools(content ?? ""); }
  async readConfiguration() { return this.java.readConfiguration(); }
  async saveConfiguration(content: string, expectedRevision?: unknown) {
    const { options, ...saved } = await this.java.saveConfiguration(content, expectedRevision as never);
    return { ...saved, options: extra(options) };
  }
  check() { return this.java.check(); }

  async listRunTargets() { return (await this.java.listMainClasses()).map((target) => ({ id: target.className, name: target.className, path: target.path })); }
  async addRunConfiguration(name: string, target: string) { return extra(await this.java.addRunConfiguration(name, target)); }
  async selectRunConfiguration(id: string) { return extra(await this.java.selectRunConfiguration(id)); }
  build() { return this.java.build(); }
  run() { return this.java.run(); }
  stop() { this.java.stop(); }

  private breakpoints(breakpoints: LanguageBreakpoint[]): JavaBreakpoint[] {
    return breakpoints.map(({ path, line, extra: details }) => ({ path, line, className: this.validateExtra("breakpoint", details).className as string }));
  }
  async setBreakpoints(breakpoints: LanguageBreakpoint[]) { return this.java.setDebugBreakpoints(this.breakpoints(breakpoints)); }
  async startDebug(breakpoints: LanguageBreakpoint[]) { return this.java.debug(this.breakpoints(breakpoints)); }
  async debugVariables(reference: string, start?: number) {
    const result = await this.java.debugVariables(reference, start);
    return { ...result, variables: debugState({ status: "paused", variables: result.variables }).variables };
  }
  debugCommand(command: Parameters<JavaProjectService["debugCommand"]>[0]) { this.java.debugCommand(command); }
  async applyChanges() { return extra(await this.java.applyDebugChanges()); }

  completion(path: string, content: string, line: number, column: number) { return this.jdt.completion(path, content, line, column); }
  definition(path: string, content: string, line: number, column: number) { return this.jdt.definition(path, content, line, column); }
  references(path: string, content: string, line: number, column: number) { return this.jdt.references(path, content, line, column); }
  semanticTokens(path: string, content: string) { return this.jdt.semanticTokens(path, content); }

  /** JDT is still driven by `jdtls.ts`; it moves to a generic launch spec when Core gains an LSP host. */
  languageServer() { return undefined; }

  validateExtra(kind: "breakpoint" | "runConfiguration" | "load", value: unknown): LanguageExtra {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as LanguageExtra : undefined;
    const need = (field: string) => { if (typeof record?.[field] !== "string" || !record[field]) throw new CoreError("INVALID_REQUEST", `${kind} requires a string '${field}'`); };
    if (kind === "breakpoint") need("className");
    if (kind === "load") need("pomPath");
    return record ?? {};
  }

  async dispose(): Promise<void> { this.java.close(); this.jdt.close(); }
}
