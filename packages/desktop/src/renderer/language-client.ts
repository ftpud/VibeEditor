import type { JavaFileType, JavaProjectNode, LanguageProjectNode, LanguageBreakpoint, LanguageDebugCommand, ProtocolOperations, RequestType } from "@remote-ide/protocol";
import type { CoreClient } from "./client";

type LanguageRequest = Exclude<Extract<RequestType, `language.${string}`>, "language.list">;
type RequestOptions = Parameters<CoreClient["request"]>[2];

/** Binds every operation to the selected language while preserving CoreClient root routing. */
export function languageClient(client: CoreClient, language: string) {
  const request = <T extends LanguageRequest>(type: T, payload: Omit<ProtocolOperations[T]["payload"], "language">, options?: RequestOptions) =>
    client.request(type, { ...payload, language } as ProtocolOperations[T]["payload"], options);
  return {
    request,
    setBreakpoints: (breakpoints: LanguageBreakpoint[]) => request("language.debug.setBreakpoints", { breakpoints }),
    startDebug: (breakpoints: LanguageBreakpoint[], options?: RequestOptions) => request("language.debug.start", { breakpoints }, options),
    debugVariables: (reference: string, start?: number) => request("language.debug.variables", { reference, start }),
    debugCommand: (command: LanguageDebugCommand) => request("language.debug.command", { command }),
    applyChanges: (options?: RequestOptions) => request("language.debug.applyChanges", {}, options)
  };
}

/** Converts a language project node to the explorer's Java-shaped node; Java type metadata travels in `extra.javaType`. */
export function toJavaProjectNode(node: LanguageProjectNode): JavaProjectNode {
  const { extra, children, type, ...rest } = node;
  return { ...rest, type: type as JavaProjectNode["type"], ...(children ? { children: children.map(toJavaProjectNode) } : {}), ...(extra?.javaType ? { javaType: extra.javaType as JavaFileType } : {}) };
}

export async function loadJavaProjectTree(client: CoreClient): Promise<JavaProjectNode[]> {
  return (await languageClient(client, "java").request("language.projectTree", {})).tree.map(toJavaProjectNode);
}
