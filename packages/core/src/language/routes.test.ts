import { describe, expect, it, vi } from "vitest";
import type { Request } from "@remote-ide/protocol";
import { LanguageRegistry, LanguageSessions } from "./registry.js";
import { handleLanguageRequest, type LanguageRequestType } from "./routes.js";
import type { LanguageDescriptor, LanguageService } from "./service.js";

const caps = { projectTree: true, build: false, run: false, debug: false, lsp: false, workspaceSymbols: true, configuration: false };
const descriptor: LanguageDescriptor = { id: "stub", name: "Stub", extensions: ["stub"], projectMarkers: [], capabilities: caps };
const service = { descriptor, projectTree: vi.fn(async () => [{ name: "src", path: "src", type: "sourceRoot" }]), workspaceSymbols: vi.fn(async () => ({ symbols: [{ name: "A", kind: 5, path: "a.stub", line: 1, column: 1 }] })), check: vi.fn(async () => [{ path: "a.stub", line: 1, column: 1, severity: "error" as const, message: "x" }]), dispose: vi.fn(async () => undefined) } as unknown as LanguageService;
const registry = new LanguageRegistry().register(descriptor, () => service);
const call = (type: LanguageRequestType, payload: object) => handleLanguageRequest(registry, new LanguageSessions(registry, "/w"), "root-1", { id: "1", type, payload, rootId: "root-1" } as unknown as Request<LanguageRequestType>);

describe("language routes", () => {
  it("lists languages and routes by the language id with root tagging", async () => {
    expect(await call("language.list", {})).toEqual({ languages: [descriptor] });
    expect(await call("language.projectTree", { language: "stub" })).toEqual({ tree: [{ name: "src", path: "src", type: "sourceRoot" }] });
    expect(await call("language.symbols", { language: "stub", query: "A" })).toMatchObject({ symbols: [{ name: "A", rootId: "root-1" }] });
    expect(await call("language.check", { language: "stub" })).toMatchObject({ diagnostics: [{ rootId: "root-1", language: "stub" }] });
  });

  it("rejects unknown languages and unsupported capabilities", async () => {
    await expect(call("language.projectTree", { language: "nope" })).rejects.toThrow("Unknown language");
    await expect(call("language.build", { language: "stub" })).rejects.toThrow("does not support build");
    await expect(call("language.debug.command", { language: "stub", command: "continue" })).rejects.toThrow("does not support debug");
    await expect(call("language.lsp.completion", { language: "stub", path: "a", content: "", line: 1, column: 1 })).rejects.toThrow("does not support lsp");
  });
});
