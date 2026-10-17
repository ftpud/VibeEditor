import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceFileSystem } from "../../../filesystem.js";
import { LanguageRegistry, LanguageSessions } from "../../../language/registry.js";
import { handleLanguageRequest, type LanguageRequestType } from "../../../language/routes.js";
import { NODE_DESCRIPTOR, NodeLanguageService } from "./service.js";
import type { Request } from "@remote-ide/protocol";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "remote-ide-lang-node-"));
  const filesystem = new WorkspaceFileSystem();
  await filesystem.initialize(root);
  const events = { output: vi.fn(), exit: vi.fn(), debugState: vi.fn(), semanticChanged: vi.fn() };
  const registry = new LanguageRegistry().register(NODE_DESCRIPTOR, (workspace) => new NodeLanguageService(workspace, events, filesystem));
  const sessions = new LanguageSessions(registry, root);
  const call = (type: LanguageRequestType, payload: object = {}) => handleLanguageRequest(registry, sessions, "root", { id: "1", type, payload: { language: "node", ...payload }, rootId: "root" } as unknown as Request<LanguageRequestType>) as Promise<any>;
  return { root, events, registry, sessions, call };
}

describe("NodeLanguageService", () => {
  it("detects package.json, runs the start script and refuses unsupported capabilities", async () => {
    const { root, events, registry, sessions, call } = await setup();
    try {
      expect(await sessions.get("node").detect(root)).toBe(false);
      expect(await call("language.options")).toEqual({ options: { configured: false, scripts: [], runConfigurations: [] } });
      expect(registry.detectMarkers(["package.json"]).map((d) => d.id)).toEqual(["node"]);
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { start: "node -e \"console.log('hello')\"" } }));
      expect(await sessions.get("node").detect(root)).toBe(true);
      expect(await call("language.options")).toMatchObject({ options: { configured: false, name: "demo", scripts: ["start"], runConfigurations: [] } });
      expect(await call("language.listRunTargets")).toEqual({ targets: [{ id: "start", name: "npm run start" }] });
      await call("language.run");
      await vi.waitFor(() => expect(events.exit).toHaveBeenCalledWith(0, null));
      expect(events.output.mock.calls.map(([text]) => text).join("")).toContain("hello");
      await expect(call("language.build")).rejects.toThrow("no 'build' script");
      await expect(call("language.addRunConfiguration", { name: "x", target: "start" })).rejects.toThrow("Add package.json as an npm project first");
      await expect(call("language.addSourceRoot", { path: "src" })).rejects.toThrow("does not support sourceRoots");
      await expect(call("language.debug.start", { breakpoints: [] })).rejects.toThrow("does not support debug");
      await expect(call("language.lsp.completion", { path: "a.js", content: "", line: 1, column: 1 })).rejects.toThrow("does not support lsp");
    } finally { await sessions.dispose(); }
  });

  it("adds a package.json as an npm project and manages named run configurations", async () => {
    const { root, events, sessions, call } = await setup();
    try {
      await mkdir(path.join(root, "web"));
      await writeFile(path.join(root, "web/package.json"), JSON.stringify({ name: "web", scripts: { dev: "node -e \"console.log(process.env.GREETING + ':' + process.argv.slice(1).join(','))\"", build: "node -e \"console.log('built')\"", "lint:all": "node -e \"0\"" } }));
      await writeFile(path.join(root, "web/pnpm-lock.yaml"), "");
      await expect(call("language.load", { extra: { packageJsonPath: "../package.json" } })).rejects.toThrow();
      const loaded = await call("language.load", { extra: { packageJsonPath: "web/package.json" } });
      expect(loaded.options).toMatchObject({ configured: true, packageJsonPath: "web/package.json", packageManager: "pnpm", runConfigurations: [{ id: "dev", script: "dev" }], selectedRunConfigurationId: "dev" });
      const saved = JSON.parse(await readFile(path.join(root, ".settings/npm.json"), "utf8"));
      expect(saved).toMatchObject({ type: "npm", packageJsonPath: "web/package.json" });

      const added = await call("language.addRunConfiguration", { name: "Lint all", target: "lint:all" });
      expect(added.options.runConfigurations.map((item: { id: string }) => item.id)).toEqual(["dev", "Lint-all"]);
      await expect(call("language.addRunConfiguration", { name: "Bad", target: "nope" })).rejects.toThrow("no 'nope' script");
      expect((await call("language.selectRunConfiguration", { id: "Lint-all" })).options.selectedRunConfigurationId).toBe("Lint-all");
      expect((await call("language.removeRunConfiguration", { id: "Lint-all" })).options).toMatchObject({ selectedRunConfigurationId: "dev" });
      await expect(call("language.selectRunConfiguration", { id: "ghost" })).rejects.toThrow("Unknown run configuration");
      expect((await call("language.projectTree")).tree[0]).toMatchObject({ path: "web/package.json", children: [{ name: "dev" }, { name: "build" }, { name: "lint:all" }] });

      const read = await call("language.configuration.read");
      const edited = JSON.stringify({ ...JSON.parse(read.content), executable: "/definitely/missing" });
      await expect(call("language.configuration.save", { content: JSON.stringify({ type: "npm", packageJsonPath: "web/package.json", packageManager: "bun" }), expectedRevision: read.revision })).rejects.toThrow("packageManager");
      expect((await call("language.configuration.save", { content: edited, expectedRevision: read.revision })).options).toMatchObject({ executable: "/definitely/missing" });
      await expect(call("language.run")).rejects.toThrow();
      expect(events.exit).not.toHaveBeenCalled();
    } finally { await sessions.dispose(); }
  });

  it("offers a template before the project is added", async () => {
    const { root, sessions, call } = await setup();
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { start: "node -v", test: "node -v" } }));
      const read = await call("language.configuration.read");
      expect(read).toMatchObject({ path: ".settings/npm.json", template: expect.any(String) });
      expect(read.revision).toBeUndefined();
      expect(JSON.parse(read.content).runConfigurations.map((item: { id: string }) => item.id)).toEqual(["start", "test"]);
      await call("language.configuration.save", { content: read.content });
      expect((await call("language.options")).options.configured).toBe(true);
    } finally { await sessions.dispose(); }
  });

  it("runs the selected configuration with arguments and environment", async () => {
    const { root, events, sessions, call } = await setup();
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { show: "node -e \"console.log(process.env.NODE_OPTIONS + '|' + process.env.GREETING + ':' + process.argv.slice(1).join(','))\" --" } }));
      await call("language.load", { extra: {} });
      const read = await call("language.configuration.read");
      const config = JSON.parse(read.content);
      config.runConfigurations = [{ id: "show", name: "Show", script: "show", arguments: ["a", "b"], nodeOptions: ["--no-warnings"], environment: { GREETING: "hi" } }];
      config.selectedRunConfigurationId = "show";
      await call("language.configuration.save", { content: JSON.stringify(config), expectedRevision: read.revision });
      await call("language.run");
      await vi.waitFor(() => expect(events.output.mock.calls.map(([text]) => text).join("")).toContain("--no-warnings|hi:a,b"));
    } finally { await sessions.dispose(); }
  });

  it("stops the whole process tree", { timeout: 20_000 }, async () => {
    if (process.platform === "win32") return;
    const { root, events, sessions, call } = await setup();
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { start: "node -e \"setInterval(() => {}, 1000); console.log('READY'+(6*7))\"" } }));
      await call("language.run"); // resolves once started, not at exit
      expect(events.exit).not.toHaveBeenCalled();
      await expect(call("language.run")).rejects.toThrow("already running");
      await vi.waitFor(() => expect(events.output.mock.calls.map(([text]) => text).join("")).toContain("READY42"), { timeout: 10_000 });
      await call("language.stop");
      await vi.waitFor(() => expect(events.exit).toHaveBeenCalled(), { timeout: 10_000 });
    } finally { await sessions.dispose(); }
  });
});
