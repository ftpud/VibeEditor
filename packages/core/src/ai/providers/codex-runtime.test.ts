import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexRuntime, updateCodexRuntime } from "./codex-runtime.js";

describe("Codex startup runtime updates", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "vibe-codex-runtime-"));
    vi.stubEnv("REMOTE_IDE_CODEX_AUTO_UPDATE", "1");
  });
  afterEach(async () => {
    vi.stubEnv("REMOTE_IDE_CODEX_AUTO_UPDATE", "0");
    await updateCodexRuntime(path.join(directory, "empty"));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const registry = (adapter = "1.12.0", codex = "0.154.0") => vi.fn(async (args: string[]) => {
    if (args[0] === "view") return JSON.stringify(args[1]!.includes("codex-acp") ? adapter : codex);
    const prefix = args[args.indexOf("--prefix") + 1]!;
    for (const [name, main] of [["@agentclientprotocol/codex-acp", "dist/index.js"], ["@openai/codex", "bin/codex.js"]]) {
      const root = path.join(prefix, "node_modules", name!);
      await mkdir(path.dirname(path.join(root, main!)), { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name, main }));
      await writeFile(path.join(root, main!), "");
    }
    return "";
  });

  it("selects a complete update and skips installation when versions are unchanged", async () => {
    const npm = registry();
    await updateCodexRuntime(directory, npm);
    expect(resolveCodexRuntime("@agentclientprotocol/codex-acp")).toContain(directory);
    expect(resolveCodexRuntime("@openai/codex/bin/codex.js")).toContain(directory);
    await updateCodexRuntime(directory, npm);
    expect(npm.mock.calls.filter(([args]) => args[0] === "install")).toHaveLength(1);
  });

  it("preserves the working installation after an interrupted update", async () => {
    await updateCodexRuntime(directory, registry());
    const previous = await readFile(path.join(directory, "current.json"), "utf8");
    const entry = resolveCodexRuntime("@agentclientprotocol/codex-acp");
    await updateCodexRuntime(directory, async (args) => {
      if (args[0] === "install") throw new Error("network unavailable");
      return JSON.stringify(args[1]!.includes("codex-acp") ? "1.13.0" : "0.155.0");
    });
    expect(await readFile(path.join(directory, "current.json"), "utf8")).toBe(previous);
    expect(resolveCodexRuntime("@agentclientprotocol/codex-acp")).toBe(entry);
  });

  it("accepts npm versions returned as singleton arrays", async () => {
    const npm = registry();
    await updateCodexRuntime(directory, async (args) => {
      const result = await npm(args);
      return args[0] === "view" ? JSON.stringify([JSON.parse(result)]) : result;
    });
    expect(resolveCodexRuntime("@agentclientprotocol/codex-acp")).toContain(directory);
  });

  it("uses bundled dependencies when the first registry check fails", async () => {
    const bundled = resolveCodexRuntime("@agentclientprotocol/codex-acp");
    await updateCodexRuntime(directory, async () => { throw new Error("offline"); });
    expect(resolveCodexRuntime("@agentclientprotocol/codex-acp")).toBe(bundled);
  });

  it("loads the cached runtime without network access when updates are disabled", async () => {
    await updateCodexRuntime(directory, registry());
    vi.stubEnv("REMOTE_IDE_CODEX_AUTO_UPDATE", "0");
    const npm = registry();
    await updateCodexRuntime(directory, npm);
    expect(npm).not.toHaveBeenCalled();
    expect(resolveCodexRuntime("@agentclientprotocol/codex-acp")).toContain(directory);
  });
});
