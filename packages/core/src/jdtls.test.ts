import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc/node.js";
import { WorkspaceFileSystem } from "./filesystem.js";
import { JdtLanguageService } from "./jdtls.js";
import { JavaSemanticCache, javaLanguageStateDirectory } from "./java-semantic-cache.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-jdt-cache-")); directories.push(root);
  const state = await mkdtemp(path.join(os.tmpdir(), "vibe-jdt-state-")); directories.push(state);
  await writeFile(path.join(root, "App.java"), "class App {}");
  const filesystem = new WorkspaceFileSystem(); await filesystem.open(root);
  return { root, state, filesystem };
}
function mockLsp(service: JdtLanguageService, data = [0, 6, 3, 0, 1]) {
  const connection = { sendRequest: vi.fn(async (method: string) => method === "java/buildWorkspace" ? 1 : { data }), sendNotification: vi.fn() };
  const internals = service as unknown as { ready(): Promise<MessageConnection>; sync(file: string, content: string): Promise<string>; semanticLegend: { tokenTypes: string[]; tokenModifiers: string[] } };
  const ready = vi.spyOn(internals, "ready").mockResolvedValue(connection as unknown as MessageConnection);
  vi.spyOn(internals, "sync").mockResolvedValue("file:///App.java");
  internals.semanticLegend = { tokenTypes: ["class"], tokenModifiers: ["declaration"] };
  return { ready, connection };
}

it("loads persisted highlighting after reopening a task without starting JDT or compiling", async () => {
  const { root, state, filesystem } = await fixture();
  const service = new JdtLanguageService(filesystem, state); const lsp = mockLsp(service);
  const tokens = await service.semanticTokens("App.java", "class App {}");
  expect(tokens).toEqual([{ startLine: 1, startColumn: 7, endLine: 1, endColumn: 10, type: "class", modifiers: ["declaration"] }]);
  const restored = new JdtLanguageService(filesystem, state); const restoredLsp = mockLsp(restored);
  await expect(restored.semanticTokens("App.java", "class App {}")).resolves.toEqual(tokens);
  expect(restoredLsp.ready).not.toHaveBeenCalled();
  expect(restoredLsp.connection.sendRequest).not.toHaveBeenCalled();
  expect(lsp.connection.sendRequest).toHaveBeenCalledTimes(1);
  expect(javaLanguageStateDirectory(root, state)).not.toBe(javaLanguageStateDirectory(`${root}-other-task`, state));
  const other = new JavaSemanticCache(`${root}-other-task`, state);
  expect((await other.get("App.java", "class App {}")).tokens).toBeUndefined();
  await restored.semanticTokens("App.java", "class App { int edited; }");
  expect(restoredLsp.ready).toHaveBeenCalledTimes(1);
});

it("invalidates and regenerates visited files on an explicit build", async () => {
  const { state, filesystem } = await fixture();
  const service = new JdtLanguageService(filesystem, state); const { connection } = mockLsp(service);
  await service.semanticTokens("App.java", "class App {}");
  await service.rebuild();
  expect(connection.sendRequest).toHaveBeenCalledWith("java/buildWorkspace", true);
  expect(connection.sendRequest.mock.calls.filter(([method]) => method === "textDocument/semanticTokens/full")).toHaveLength(2);
  const restored = new JdtLanguageService(filesystem, state); const restoredLsp = mockLsp(restored);
  await restored.semanticTokens("App.java", "class App {}");
  expect(restoredLsp.ready).not.toHaveBeenCalled();
});

it("does not restore pre-build snapshots from requests that finish late", async () => {
  const { root, state } = await fixture();
  const cache = new JavaSemanticCache(root, state);
  const tokens = [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, type: "class", modifiers: [] }];
  const { generation } = await cache.get("App.java", "class App {}");
  await cache.invalidate();
  await cache.put("App.java", "class App {}", tokens, generation);
  expect((await new JavaSemanticCache(root, state).get("App.java", "class App {}")).tokens).toBeUndefined();
});
