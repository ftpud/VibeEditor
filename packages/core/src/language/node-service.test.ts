import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LanguageRegistry, LanguageSessions } from "./registry.js";
import { handleLanguageRequest, type LanguageRequestType } from "./routes.js";
import { NODE_DESCRIPTOR, NodeLanguageService } from "./node-service.js";
import type { Request } from "@remote-ide/protocol";

describe("NodeLanguageService", () => {
  it("detects package.json, runs scripts and refuses unsupported capabilities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-lang-node-"));
    const events = { output: vi.fn(), exit: vi.fn(), debugState: vi.fn(), semanticChanged: vi.fn() };
    const registry = new LanguageRegistry().register(NODE_DESCRIPTOR, (workspace) => new NodeLanguageService(workspace, events));
    const sessions = new LanguageSessions(registry, root);
    const call = (type: LanguageRequestType, payload: object) => handleLanguageRequest(registry, sessions, "root", { id: "1", type, payload, rootId: "root" } as unknown as Request<LanguageRequestType>);
    try {
      expect(await sessions.get("node").detect(root)).toBe(false);
      expect(registry.detectMarkers(["package.json"]).map((d) => d.id)).toEqual(["node"]);
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { start: "node -e \"console.log('hello')\"" } }));
      expect(await sessions.get("node").detect(root)).toBe(true);
      expect(await call("language.options", { language: "node" })).toEqual({ options: { name: "demo", scripts: ["start"] } });
      expect(await call("language.listRunTargets", { language: "node" })).toEqual({ targets: [{ id: "start", name: "npm run start" }] });
      await call("language.run", { language: "node" });
      expect(events.output.mock.calls.map(([text]) => text).join("")).toContain("hello");
      expect(events.exit).toHaveBeenCalledWith(0, null);
      await expect(call("language.build", { language: "node" })).rejects.toThrow("no 'build' script");
      await expect(call("language.debug.start", { language: "node", breakpoints: [] })).rejects.toThrow("does not support debug");
      await expect(call("language.lsp.completion", { language: "node", path: "a.js", content: "", line: 1, column: 1 })).rejects.toThrow("does not support lsp");
    } finally { await sessions.dispose(); }
  });
});
