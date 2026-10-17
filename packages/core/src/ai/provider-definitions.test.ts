import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpRegistry } from "./index.js";
import { loadProviderDefinitions, validateProviderDefinition } from "./provider-definitions.js";

const AGENT = fileURLToPath(new URL("./providers/fake-acp-agent.mjs", import.meta.url));
const base = { id: "custom-agent", name: "Custom", description: "Declared", command: process.execPath, args: [AGENT], models: [{ id: "model-a", name: "Model A", reasoningLevels: ["low"] }] };

afterEach(() => vi.unstubAllEnvs());

describe("provider definitions", () => {
  it("rejects unknown fields, reserved and malformed ids", () => {
    expect(validateProviderDefinition(base).id).toBe("custom-agent");
    expect(() => validateProviderDefinition({ ...base, extra: 1 })).toThrow("unknown field extra");
    expect(() => validateProviderDefinition({ ...base, id: "codex" })).toThrow("reserved");
    expect(() => validateProviderDefinition({ ...base, id: "Bad Id" })).toThrow("lowercase");
    expect(() => validateProviderDefinition({ ...base, command: "" })).toThrow("command");
    expect(() => validateProviderDefinition({ ...base, capabilities: { telepathy: true } })).toThrow("unknown field telepathy");
    expect(() => validateProviderDefinition({ ...base, options: [{ id: "a", name: "A", description: "", type: "boolean", defaultValue: false }, { id: "a", name: "A", description: "", type: "boolean", defaultValue: false }] })).toThrow("duplicate option");
  });

  it("validates options strictly", () => {
    const option = { id: "mode", name: "Mode", description: "d", type: "select", defaultValue: "a", choices: [{ value: "a", name: "A" }] };
    expect(validateProviderDefinition({ ...base, options: [option] }).options).toHaveLength(1);
    for (const bad of [{ ...option, extra: 1 }, { ...option, choices: "a" }, { ...option, choices: undefined }, { ...option, type: "boolean", choices: undefined }, { ...option, permissionApproval: "yes" }]) {
      expect(() => validateProviderDefinition({ ...base, options: [bad] })).toThrow();
    }
    expect(() => validateProviderDefinition({ ...base, credentialEnv: ["X"] })).toThrow("unknown field credentialEnv");
  });

  it("skips invalid and duplicate files without failing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "provider-defs-"));
    await writeFile(path.join(directory, "a.json"), JSON.stringify(base));
    await writeFile(path.join(directory, "b.json"), JSON.stringify(base));
    await writeFile(path.join(directory, "c.json"), "{not json");
    await writeFile(path.join(directory, "d.json"), JSON.stringify({ ...base, id: "codex" }));
    const warn = vi.fn();
    expect(loadProviderDefinitions(directory, new Set(), warn).map((definition) => definition.id)).toEqual(["custom-agent"]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(loadProviderDefinitions(path.join(directory, "missing"))).toEqual([]);
  });

  it("registers a definition and runs a turn, models and permission-free usage fallback", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "provider-defs-"));
    vi.stubEnv("REMOTE_IDE_PROVIDER_DEFINITIONS_DIR", directory);
    vi.stubEnv("REMOTE_IDE_STATE_DIR", await mkdtemp(path.join(os.tmpdir(), "provider-state-")));
    await writeFile(path.join(directory, "custom.json"), JSON.stringify(base));
    const registry = createAcpRegistry(() => undefined);
    try {
      expect(registry.list().map((descriptor) => descriptor.id)).toEqual(["codex", "copilot", "claude", "custom-agent"]);
      expect(registry.defaultId).toBe("codex");
      const provider = registry.get("custom-agent");
      expect(await provider.installation()).toMatchObject({ provider: "custom-agent", status: "installed", source: "external" });
      expect((await provider.models()).map((model) => model.id)).toContain("model-a");
      const workspace = await mkdtemp(path.join(os.tmpdir(), "provider-workspace-"));
      await provider.send(workspace, { prompt: "hello", configuration: { model: "model-a" } });
      let session = await provider.get(workspace);
      for (let attempt = 0; session.status === "in_progress" && attempt < 200; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 20)); session = await provider.get(workspace); }
      expect(session.messages.some((message) => message.text.includes("Hello, world"))).toBe(true);
      expect(await provider.usage(workspace)).toMatchObject({ supported: true });
    } finally { await registry.shutdown(); }
  });
});

describe("plugin provider isolation", () => {
  it("skips a plugin factory that throws and keeps the other providers", () => {
    vi.stubEnv("REMOTE_IDE_PROVIDER_DEFINITIONS_DIR", path.join(os.tmpdir(), "no-provider-definitions"));
    const registry = createAcpRegistry(() => undefined, undefined, undefined, undefined, [() => { throw new Error("plugin exploded"); }]);
    expect(registry.list().map((descriptor) => descriptor.id)).toEqual(["codex", "copilot", "claude"]);
  });
});
