/**
 * Language service contract (plugins-todo.md 2.2).
 *
 * A language service owns everything language-specific for one workspace root:
 * project detection and loading, source roots, build/run/debug, tool checks and
 * the language server launch. Core owns the generic machinery around it
 * (transport, processes, run configurations, one LSP host, state persistence).
 *
 * DECISION (language extras): language-specific payloads travel as an opaque
 * `extra` record. Each service declares `validateExtra`, so Core can reject
 * malformed input without a per-language protocol union. Generic fields stay
 * typed; JVM-only data (class names, hot-swap results) lives in `extra`.
 */

/** What a service can do; the UI hides everything it does not advertise. */
export interface LanguageCapabilities {
  projectTree: boolean;
  build: boolean;
  run: boolean;
  debug: boolean;
  lsp: boolean;
  workspaceSymbols: boolean;
  configuration: boolean;
}

export interface LanguageDescriptor {
  /** Stable identifier carried by `language.*` requests, e.g. `java`. */
  id: string;
  name: string;
  /** Lowercase file extensions without the dot. */
  extensions: string[];
  /** Workspace-relative marker files that indicate a project, e.g. `pom.xml`. */
  projectMarkers: string[];
  capabilities: LanguageCapabilities;
}

/** Opaque, service-validated language-specific data. */
export type LanguageExtra = Record<string, unknown>;

export interface LanguageProjectNode {
  name: string;
  path: string;
  /** `sourceRoot` and `file` are generic; grouping kinds such as `package` are service-defined. */
  type: string;
  sourceKind?: "source" | "test";
  children?: LanguageProjectNode[];
  extra?: LanguageExtra;
}

export interface LanguageToolCheck { tool: string; executable: string; ok: boolean; message: string }
export interface LanguageDiagnostic { path: string; line: number; column: number; severity: "error" | "warning"; message: string }
export interface LanguageSymbol { name: string; kind: number; path: string; line: number; column: number; container?: string }

export interface LanguageRunTarget { id: string; name: string; path?: string; extra?: LanguageExtra }

/** Reuses `run-configs.ts` and `project-processes.ts`; a service only describes what to launch. */
export interface LanguageRunSpec { command: string; args: string[]; cwd?: string; env?: Record<string, string> }

export interface LanguageBreakpoint { path: string; line: number; extra?: LanguageExtra }
export interface LanguageDebugVariable { name: string; value: string; reference?: string; type?: string; indexedCount?: number; extra?: LanguageExtra }
export interface LanguageDebugState {
  status: "starting" | "running" | "paused" | "stopped";
  path?: string;
  line?: number;
  frame?: string;
  variables: LanguageDebugVariable[];
  stopReason?: string;
  inspectionError?: string;
  busy?: boolean;
  extra?: LanguageExtra;
}
export type LanguageDebugCommand = "continue" | "pause" | "stepOver" | "stepInto" | "stepOut" | "stop";

/** How Core's single generic LSP host should start this language's server. */
export interface LanguageServerLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  initializationOptions?: unknown;
  /** Resolves false when prerequisites (JDK, installed server) are missing, so Core can report instead of crash. */
  ready?: () => Promise<boolean>;
}

/** Events a service pushes; Core adds the language id and root. */
export interface LanguageServiceEvents {
  output(text: string, stream: "stdout" | "stderr"): void;
  exit(code: number | null): void;
  debugState(state: LanguageDebugState): void;
  semanticChanged(): void;
}

export interface LanguageService {
  readonly descriptor: LanguageDescriptor;

  /** True when `workspace` contains a project this service handles. */
  detect(workspace: string): Promise<boolean>;
  /** Load or reload the project; returns the service's view of it. */
  load(input?: LanguageExtra): Promise<LanguageExtra>;
  options(): Promise<LanguageExtra>;
  projectTree(): Promise<LanguageProjectNode[]>;
  addSourceRoot(path: string): Promise<void>;
  workspaceSymbols(query: string, limit?: number): Promise<{ symbols: LanguageSymbol[]; truncated?: boolean }>;
  checkTools(content?: string): Promise<LanguageToolCheck[]>;
  readConfiguration(): Promise<{ content: string; revision: string; path: string }>;
  saveConfiguration(content: string, expectedRevision?: string): Promise<{ revision: string }>;
  check(): Promise<LanguageDiagnostic[]>;

  listRunTargets(): Promise<LanguageRunTarget[]>;
  addRunConfiguration(name: string, target: string): Promise<LanguageExtra>;
  selectRunConfiguration(id: string): Promise<LanguageExtra>;
  build(): Promise<void>;
  run(): Promise<void>;
  stop(): void;

  setBreakpoints(breakpoints: LanguageBreakpoint[]): Promise<void>;
  startDebug(breakpoints: LanguageBreakpoint[]): Promise<void>;
  debugVariables(reference: string, start?: number): Promise<{ variables: LanguageDebugVariable[] }>;
  debugCommand(command: LanguageDebugCommand): void;
  applyChanges(): Promise<LanguageExtra>;

  /** Launch spec for the generic LSP host; undefined when `capabilities.lsp` is false. */
  languageServer(): LanguageServerLaunch | undefined;
  /** Validates `extra` payloads this service accepts; throws a descriptive Error. */
  validateExtra(kind: "breakpoint" | "runConfiguration" | "load", extra: unknown): LanguageExtra;

  dispose(): Promise<void>;
}

/** Optional operations are guarded by capability flags; this keeps minimal services small. */
export type PartialLanguageService = Pick<LanguageService, "descriptor" | "detect" | "dispose"> & Partial<LanguageService>;
