import type { LanguageExtra, Request, RequestType, WorkspaceRootId } from "@remote-ide/protocol";
import { CoreError } from "../errors.js";
import type { LanguageRegistry, LanguageSessions } from "./registry.js";
import type { LanguageService } from "./service.js";

export type LanguageRequestType = Extract<RequestType, `language.${string}`>;
export const isLanguageRequest = (type: string): type is LanguageRequestType => type.startsWith("language.");

function optional<T extends LanguageService, K extends "completion" | "definition" | "references" | "semanticTokens">(service: T, method: K): NonNullable<T[K]> {
  const fn = service[method];
  if (!fn) throw new CoreError("INVALID_REQUEST", `Language '${service.descriptor.id}' does not provide ${method}`);
  return fn.bind(service) as NonNullable<T[K]>;
}

/** Routes `language.*` requests to the service named in the payload, enforcing advertised capabilities. */
export async function handleLanguageRequest(registry: LanguageRegistry, sessions: LanguageSessions, rootId: WorkspaceRootId, request: Request<LanguageRequestType>): Promise<unknown> {
  if (request.type === "language.list") return { languages: registry.list() };
  const language = request.payload.language;
  if (typeof language !== "string") throw new CoreError("INVALID_REQUEST", "language must be a string");
  const rooted = <T extends object>(items: T[]) => items.map((item) => ({ ...item, rootId, language }));
  switch (request.type) {
    case "language.load": {
      const service = sessions.get(language);
      const loaded = await service.load(service.validateExtra("load", request.payload.extra));
      return { options: (loaded.options as LanguageExtra | undefined) ?? loaded };
    }
    case "language.options": return { options: await sessions.get(language).options() };
    case "language.configuration.read": return sessions.require(language, "configuration").readConfiguration();
    case "language.configuration.save": return sessions.require(language, "configuration").saveConfiguration(request.payload.content, request.payload.expectedRevision);
    case "language.tools.check": return { checks: await sessions.get(language).checkTools(request.payload.content) };
    case "language.addSourceRoot": await sessions.require(language, "projectTree").addSourceRoot(request.payload.path); return {};
    case "language.projectTree": return { tree: await sessions.require(language, "projectTree").projectTree() };
    case "language.symbols": {
      const result = await sessions.require(language, "workspaceSymbols").workspaceSymbols(request.payload.query, request.payload.limit);
      return { ...result, symbols: result.symbols.map((symbol) => ({ ...symbol, rootId })) };
    }
    case "language.listRunTargets": return { targets: await sessions.require(language, "run").listRunTargets() };
    case "language.addRunConfiguration": return { options: await sessions.require(language, "run").addRunConfiguration(request.payload.name, request.payload.target) };
    case "language.selectRunConfiguration": return { options: await sessions.require(language, "run").selectRunConfiguration(request.payload.id) };
    case "language.build": await sessions.require(language, "build").build(); return {};
    case "language.run": await sessions.require(language, "run").run(); return {};
    case "language.stop": sessions.require(language, "run").stop(); return {};
    case "language.debug.setBreakpoints": await sessions.require(language, "debug").setBreakpoints(request.payload.breakpoints); return {};
    case "language.debug.start": await sessions.require(language, "debug").startDebug(request.payload.breakpoints); return {};
    case "language.debug.applyChanges": return sessions.require(language, "debug").applyChanges();
    case "language.debug.variables": return sessions.require(language, "debug").debugVariables(request.payload.reference, request.payload.start);
    case "language.debug.command": sessions.require(language, "debug").debugCommand(request.payload.command); return {};
    case "language.check": return { diagnostics: rooted(await sessions.get(language).check()) };
    case "language.lsp.completion": { const { path, content, line, column } = request.payload; return { items: await optional(sessions.require(language, "lsp"), "completion")(path, content, line, column) }; }
    case "language.lsp.definition": { const { path, content, line, column } = request.payload; return { locations: rooted(await optional(sessions.require(language, "lsp"), "definition")(path, content, line, column)) }; }
    case "language.lsp.references": { const { path, content, line, column } = request.payload; return { locations: rooted(await optional(sessions.require(language, "lsp"), "references")(path, content, line, column)) }; }
    case "language.lsp.semanticTokens": return { tokens: await optional(sessions.require(language, "lsp"), "semanticTokens")(request.payload.path, request.payload.content) };
  }
}

