import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlugins, validateManifest } from "./loader.js";

const manifest = { id: "demo", version: "1.0.0", apiVersion: 1, contributes: { languages: ["demo-lang"] }, core: "index.mjs" };
const module = `export const apiVersion = 1;
export const languages = [{ descriptor: { id: "demo-lang", name: "Demo", extensions: ["demo"], projectMarkers: [], capabilities: { projectTree: false, build: false, run: false, debug: false, lsp: false, workspaceSymbols: false, configuration: false } }, create() { throw new Error("unused"); } }];`;

async function plugin(root: string, name: string, files: Record<string, string>) {
  await mkdir(path.join(root, name), { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, name, file), content);
}

describe("plugin loader", () => {
  it("validates manifests strictly", () => {
    expect(validateManifest(manifest).id).toBe("demo");
    expect(() => validateManifest({ ...manifest, apiVersion: 2 })).toThrow("not supported");
    expect(() => validateManifest({ ...manifest, core: "../x.js" })).toThrow("relative path");
    expect(() => validateManifest({ ...manifest, core: "/etc/x.js" })).toThrow("relative path");
    expect(() => validateManifest({ ...manifest, extra: 1 })).toThrow("unknown manifest field");
    expect(() => validateManifest({ ...manifest, contributes: { workflows: [] } })).toThrow("unknown contribution");
  });

  it("is opt-in and tolerates a missing directory", async () => {
    expect((await loadPlugins(undefined)).status).toEqual([]);
    expect((await loadPlugins(path.join(tmpdir(), "no-such-plugins-dir"))).status).toEqual([]);
  });

  it("loads good plugins and isolates failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-plugins-"));
    await plugin(root, "a-good", { "plugin.json": JSON.stringify(manifest), "index.mjs": module });
    await plugin(root, "b-throws", { "plugin.json": JSON.stringify({ ...manifest, id: "thrower" }), "index.mjs": "throw new Error('boom');" });
    await plugin(root, "c-mismatch", { "plugin.json": JSON.stringify({ ...manifest, id: "mismatch", contributes: { languages: ["other"] } }), "index.mjs": module });
    await plugin(root, "d-badjson", { "plugin.json": "{" });
    await plugin(root, "e-taken", { "plugin.json": JSON.stringify({ ...manifest, id: "taken" }), "index.mjs": module });
    const loaded = await loadPlugins(root);
    const byId = Object.fromEntries(loaded.status.map((status) => [status.id, status]));
    expect(byId.demo).toMatchObject({ state: "loaded", languages: ["demo-lang"] });
    expect(byId.thrower).toMatchObject({ state: "failed", error: "boom" });
    expect(byId.mismatch?.error).toContain("do not match");
    expect(byId["d-badjson"]?.state).toBe("failed");
    expect(byId.taken?.error).toContain("already taken");
    expect(loaded.languages.map((language) => language.descriptor.id)).toEqual(["demo-lang"]);
    const disabled = await loadPlugins(root, { disabled: new Set(["demo"]) });
    expect(disabled.status.find((status) => status.id === "demo")).toMatchObject({ state: "failed", error: "disabled" });
    expect(disabled.status.find((status) => status.id === "taken")?.state).toBe("loaded");
  });
});
