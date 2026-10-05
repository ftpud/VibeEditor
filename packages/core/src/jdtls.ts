import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node.js";
import type { JavaLspCompletion, JavaLspLocation, JavaSemanticToken, WorkspaceSymbol } from "@remote-ide/protocol";
import { JavaSemanticCache, javaLanguageStateDirectory } from "./java-semantic-cache.js";
import { CoreError } from "./errors.js";
import { WorkspaceFileSystem } from "./filesystem.js";

type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };
type LspLocation = { uri: string; range: LspRange };
const bundledTools = fileURLToPath(new URL("../../../.tools/", import.meta.url));

export class JdtLanguageService {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private starting?: Promise<void>;
  private readonly documents = new Map<string, { content: string; version: number }>();
  private semanticLegend: { tokenTypes: string[]; tokenModifiers: string[] } = { tokenTypes: [], tokenModifiers: [] };

  private readonly cache: JavaSemanticCache;
  private closed = false;
  constructor(private readonly filesystem: WorkspaceFileSystem, private readonly stateDirectory?: string) {
    this.cache = new JavaSemanticCache(filesystem.getWorkspace(), stateDirectory);
  }

  async completion(filePath: string, content: string, line: number, column: number): Promise<JavaLspCompletion[]> {
    const connection = await this.ready();
    const uri = await this.sync(filePath, content);
    const result = await connection.sendRequest("textDocument/completion", { textDocument: { uri }, position: toPosition(line, column), context: { triggerKind: 1 } }) as any;
    const items = Array.isArray(result) ? result : result?.items ?? [];
    const resolved = await Promise.all(items.slice(0, 100).map((item: any) => item.data && [7, 8, 13, 22].includes(item.kind) ? connection.sendRequest("completionItem/resolve", item).catch(() => item) : item));
    return resolved.map((item: any) => ({
      label: item.label,
      detail: item.detail,
      insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
      ...(item.textEdit?.range ? { range: fromRange(item.textEdit.range) } : {}),
      additionalTextEdits: (item.additionalTextEdits ?? []).map((edit: any) => ({ range: fromRange(edit.range), text: edit.newText }))
    }));
  }

  async definition(filePath: string, content: string, line: number, column: number): Promise<JavaLspLocation[]> {
    return this.locations("textDocument/definition", filePath, content, line, column, {});
  }

  async references(filePath: string, content: string, line: number, column: number): Promise<JavaLspLocation[]> {
    return this.locations("textDocument/references", filePath, content, line, column, { context: { includeDeclaration: false } });
  }

  async workspaceSymbols(query: string, limit = 100): Promise<{ symbols: WorkspaceSymbol[]; truncated: boolean }> {
    const connection = await this.ready();
    const bounded = Math.max(1, Math.min(200, limit));
    const result = await connection.sendRequest("workspace/symbol", { query: query.slice(0, 200) }) as any[] | null;
    const items = Array.isArray(result) ? result : [];
    const symbols = items.slice(0, bounded).flatMap((item: any) => {
      const location = item.location ?? item; const uri = location.uri; const range = location.range;
      if (typeof item.name !== "string" || typeof uri !== "string" || !range?.start) return [];
      const relative = this.relativeUri(uri);
      if (relative.startsWith("..") || relative.includes("://")) return [];
      return [{ name: item.name, kind: Number(item.kind) || 0, path: relative, line: range.start.line + 1, column: range.start.character + 1, ...(typeof item.containerName === "string" ? { container: item.containerName } : {}) }];
    });
    return { symbols, truncated: items.length > bounded };
  }

  async semanticTokens(filePath: string, content: string): Promise<JavaSemanticToken[]> {
    if (this.closed) throw new CoreError("JAVA_PROCESS_FAILED", "Java language service is closed");
    await this.filesystem.resolveExisting(filePath);
    const cached = await this.cache.get(filePath, content).catch(() => ({ generation: "unavailable", tokens: undefined }));
    if (cached.tokens) return cached.tokens;
    const connection = await this.ready();
    const uri = await this.sync(filePath, content);
    const result = await connection.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } }) as { data?: number[] } | null;
    const data = result?.data ?? []; const tokens: JavaSemanticToken[] = [];
    let line = 0; let column = 0;
    for (let index = 0; index + 4 < data.length; index += 5) {
      line += data[index]!; column = data[index] === 0 ? column + data[index + 1]! : data[index + 1]!;
      const length = data[index + 2]!; const type = this.semanticLegend.tokenTypes[data[index + 3]!] ?? ""; const bits = data[index + 4]!;
      const modifiers = this.semanticLegend.tokenModifiers.filter((_, bit) => (bits & (1 << bit)) !== 0);
      tokens.push({ startLine: line + 1, startColumn: column + 1, endLine: line + 1, endColumn: column + length + 1, type, modifiers });
    }
    if (tokens.length || !content.trim()) await this.cache.put(filePath, content, tokens, cached.generation).catch((error) => console.error(`[jdtls] could not cache highlighting: ${String(error)}`));
    return tokens;
  }

  async rebuild(): Promise<void> {
    if (this.closed) return;
    const files = new Set([...await this.cache.files(), ...[...this.documents.keys()].map((uri) => this.relativeUri(uri))]);
    await this.cache.invalidate();
    const connection = await this.ready();
    const snapshots = await Promise.all([...files].map(async (file) => {
      try { return { file, content: (await this.filesystem.read(file)).content }; } catch { return undefined; }
    }));
    const existing = snapshots.filter((snapshot): snapshot is { file: string; content: string } => !!snapshot);
    await Promise.all(existing.map((snapshot) => this.sync(snapshot.file, snapshot.content)));
    connection.sendNotification("workspace/didChangeWatchedFiles", { changes: existing.map(({ file }) => ({ uri: pathToFileURL(path.resolve(this.filesystem.getWorkspace(), file)).href, type: 2 })) });
    const result = await connection.sendRequest("java/buildWorkspace", true);
    if (result !== 1) throw new CoreError("JAVA_PROCESS_FAILED", `Java type index rebuild did not succeed (status ${result})`);
    for (const { file, content } of existing) {
      if (this.closed) return;
      try { await this.semanticTokens(file, content); }
      catch (error) { console.error(`[jdtls] could not refresh ${file}: ${String(error)}`); }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const connection = this.connection;
    const child = this.process;
    if (!connection) { child?.kill("SIGTERM"); return; }
    void connection.sendRequest("shutdown").catch(() => undefined).then(() => {
      connection.sendNotification("exit");
      setTimeout(() => { connection.dispose(); child?.kill("SIGTERM"); }, 100).unref();
    });
  }

  private async locations(method: string, filePath: string, content: string, line: number, column: number, extra: object): Promise<JavaLspLocation[]> {
    const connection = await this.ready();
    const uri = await this.sync(filePath, content);
    const result = await connection.sendRequest(method, { textDocument: { uri }, position: toPosition(line, column), ...extra }) as LspLocation | LspLocation[] | null;
    const locations = !result ? [] : Array.isArray(result) ? result : [result];
    return locations.map((raw: any) => {
      const location = raw.targetUri ? { uri: raw.targetUri, range: raw.targetSelectionRange ?? raw.targetRange } : raw;
      return { path: this.relativeUri(location.uri), ...fromRange(location.range) };
    }).filter((item) => !item.path.startsWith("..") && !item.path.includes("://"));
  }

  private async sync(filePath: string, content: string): Promise<string> {
    const uri = pathToFileURL(await this.filesystem.resolveExisting(filePath)).href;
    const existing = this.documents.get(uri);
    if (!existing) {
      this.documents.set(uri, { content, version: 1 });
      this.connection!.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "java", version: 1, text: content } });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else if (existing.content !== content) {
      const version = existing.version + 1;
      this.documents.set(uri, { content, version });
      this.connection!.sendNotification("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text: content }] });
    }
    return uri;
  }

  private async ready(): Promise<MessageConnection> {
    if (this.closed) throw new CoreError("JAVA_PROCESS_FAILED", "Java language service is closed");
    if (!this.starting) this.starting = this.start().catch((error) => { this.starting = undefined; throw error; });
    await this.starting;
    if (this.closed) throw new CoreError("JAVA_PROCESS_FAILED", "Java language service is closed");
    return this.connection!;
  }

  private async start(): Promise<void> {
    const distribution = path.join(bundledTools, "jdtls");
    let plugins: string[];
    try { plugins = await readdir(path.join(distribution, "plugins")); } catch { throw new CoreError("JAVA_PROCESS_FAILED", "JDT LS is not installed. Run npm run install:jdtls"); }
    const launcher = plugins.find((name) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name));
    if (!launcher) throw new CoreError("JAVA_PROCESS_FAILED", "JDT LS launcher was not found");
    const platform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
    const state = javaLanguageStateDirectory(this.filesystem.getWorkspace(), this.stateDirectory);
    const data = path.join(state, "jdtls", "data");
    const configuration = path.join(state, "jdtls", "config");
    await mkdir(path.dirname(configuration), { recursive: true });
    await cp(path.join(distribution, `config_${platform}`), configuration, { recursive: true, force: true });
    await mkdir(data, { recursive: true });
    const bundledJava = path.join(bundledTools, "jre21", process.platform === "darwin" ? "Contents/Home/bin/java" : process.platform === "win32" ? "bin/java.exe" : "bin/java");
    if (this.closed) throw new CoreError("JAVA_PROCESS_FAILED", "Java language service is closed");
    const child = spawn(bundledJava, ["-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Dlog.level=ERROR", "-Xmx1G", "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED", "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", path.join(distribution, "plugins", launcher), "-configuration", configuration, "-data", data], { cwd: this.filesystem.getWorkspace(), stdio: "pipe" });
    this.process = child;
    child.stderr.on("data", (data) => console.error(`[jdtls] ${data.toString().trimEnd()}`));
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    this.connection = connection;
    const javaSettings = { autobuild: { enabled: false } };
    connection.onRequest("workspace/configuration", (params: any) => (params?.items ?? []).map((item: any) => item.section === "java.autobuild.enabled" ? false : item.section === "java" ? javaSettings : { java: javaSettings }));
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("workspace/workspaceFolders", () => [{ uri: pathToFileURL(this.filesystem.getWorkspace()).href, name: path.basename(this.filesystem.getWorkspace()) }]);
    const serviceReady = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      connection.onNotification("language/status", (status: any) => { if (status?.type === "ServiceReady") { clearTimeout(timer); resolve(); } });
    });
    connection.listen();
    const initialized = await connection.sendRequest("initialize", { processId: process.pid, rootUri: pathToFileURL(this.filesystem.getWorkspace()).href, initializationOptions: { settings: { java: javaSettings }, bundles: [], extendedClientCapabilities: { progressReportProvider: true, classFileContentsSupport: true } }, capabilities: { textDocument: { synchronization: { dynamicRegistration: false, didSave: true }, completion: { completionItem: { snippetSupport: false, resolveSupport: { properties: ["additionalTextEdits", "textEdit"] } } }, definition: {}, references: {}, semanticTokens: { requests: { full: true }, tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"], tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"] } }, workspace: { workspaceFolders: true, configuration: true } }, workspaceFolders: [{ uri: pathToFileURL(this.filesystem.getWorkspace()).href, name: path.basename(this.filesystem.getWorkspace()) }] }) as any;
    const provider = initialized?.capabilities?.semanticTokensProvider;
    if (provider?.legend) this.semanticLegend = provider.legend;
    connection.sendNotification("initialized", {});
    connection.sendNotification("workspace/didChangeConfiguration", { settings: { java: javaSettings } });
    await serviceReady;
  }

  private relativeUri(uri: string): string {
    if (!uri.startsWith("file:")) return uri;
    return path.relative(this.filesystem.getWorkspace(), fileURLToPath(uri)).split(path.sep).join(path.posix.sep);
  }
}

function toPosition(line: number, column: number): LspPosition { return { line: Math.max(0, line - 1), character: Math.max(0, column - 1) }; }
function fromRange(range: LspRange) { return { startLine: range.start.line + 1, startColumn: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1 }; }
