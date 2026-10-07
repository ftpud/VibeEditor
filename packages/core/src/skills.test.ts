import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SkillsStore } from "./skills.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-skills-")); roots.push(root);
  const workspace = path.join(root, "project"); await mkdir(workspace);
  return { root, workspace, store: new SkillsStore(path.join(root, "state")) };
}
const review = "---\nname: Reviewer\ndescription: Review changes\n---\n\nCheck regressions and tests.\n";

describe("project skills", () => {
  it("discovers separate global/local skills and persists a project allowlist with defaults", async () => {
    const { workspace, store } = await setup();
    expect(await store.list(workspace)).toEqual({ skills: [], policy: { allowed: [], defaults: [] } });
    await store.write("global/review", workspace, review);
    await store.write("local/review", workspace, "Local instructions");
    const catalog = await store.list(workspace);
    expect(catalog.skills.map((skill) => skill.id)).toEqual(["global/review", "local/review"]);
    expect(catalog.skills[0]).toMatchObject({ title: "Reviewer", description: "Review changes" });
    await store.writePolicy(workspace, { allowed: ["local/review"], defaults: ["local/review"] });
    expect(await store.defaults(workspace)).toEqual(["local/review"]);
    await expect(store.validateSelection(workspace, ["global/review"])).rejects.toThrow("not allowed");
    expect(await store.validateSelection(workspace, ["local/review", "local/review"])).toEqual(["local/review"]);
    expect(JSON.parse(await readFile(path.join(workspace, ".agents/skills.json"), "utf8"))).toEqual({ allowed: ["local/review"], defaults: ["local/review"] });
  });

  it("reloads edited instructions and enforces revoked policy on every turn", async () => {
    const { workspace, store } = await setup();
    await store.write("local/review", workspace, review);
    expect(await store.instructions(workspace, ["local/review"])).toContain("Check regressions");
    await store.write("local/review", workspace, "Updated workflow");
    expect(await store.instructions(workspace, ["local/review"])).toContain("Updated workflow");
    await store.writePolicy(workspace, { allowed: [], defaults: [] });
    const instructions = await store.instructions(workspace, ["local/review"]);
    expect(instructions).not.toContain("Updated workflow");
    expect(instructions).toContain("No Vibe skills are enabled");
  });

  it("keeps global skills shared and project-local skills/defaults isolated", async () => {
    const { root, workspace, store } = await setup();
    const other = path.join(root, "other"); await mkdir(other);
    await store.write("global/review", workspace, review);
    await store.write("local/custom", workspace, "Project-specific");
    await store.writePolicy(workspace, { allowed: ["local/custom"], defaults: ["local/custom"] });
    expect((await store.list(other)).skills.map((skill) => skill.id)).toEqual(["global/review"]);
    expect(await store.defaults(other)).toEqual([]);
  });

  it("rejects invalid policies, traversal, oversized instructions and symlink escapes", async () => {
    const { root, workspace, store } = await setup();
    await expect(store.writePolicy(workspace, { allowed: [], defaults: ["local/review"] })).rejects.toThrow("defaults must be allowed");
    await expect(store.write("local/../../escape", workspace, review)).rejects.toThrow("Skill ID");
    await expect(store.write("local/review", workspace, "x".repeat(256 * 1024 + 1))).rejects.toThrow("256 KB");
    const outside = path.join(root, "outside"); await mkdir(outside);
    await symlink(outside, path.join(workspace, ".agents"));
    await expect(store.write("local/review", workspace, review)).rejects.toThrow("escapes");
    await expect(store.writePolicy(workspace, { allowed: [], defaults: [] })).rejects.toThrow("escapes");
  });

  it("enforces exact agent scopes and explicit no-agent access, retaining restrictions when saved", async () => {
    const { workspace, store } = await setup();
    await store.write("local/review", workspace, review);
    const reviewer = { scope: "workspace" as const, name: "reviewer.md" };
    await store.writePolicy(workspace, { allowed: ["local/review"], defaults: [], agents: { "local/review": [reviewer] } });
    await expect(store.validateSelection(workspace, ["local/review"])).rejects.toThrow("selected agent");
    await expect(store.validateSelection(workspace, ["local/review"], { ...reviewer, scope: "global" })).rejects.toThrow("selected agent");
    expect(await store.validateSelection(workspace, ["local/review"], reviewer)).toEqual(["local/review"]);
    expect(await store.instructions(workspace, ["local/review"], reviewer)).toContain("Check regressions");
    expect(await store.instructions(workspace, ["local/review"], null)).not.toContain("Check regressions");
    await store.writePolicy(workspace, { allowed: ["local/review"], defaults: [], agents: { "local/review": [null] } });
    expect(await store.validateSelection(workspace, ["local/review"], null)).toEqual(["local/review"]);
    await expect(store.validateSelection(workspace, ["local/review"], reviewer)).rejects.toThrow("selected agent");
    expect((await store.list(workspace)).policy.agents).toEqual({ "local/review": [null] });
    await expect(store.writePolicy(workspace, { allowed: [], defaults: [], agents: { "local/review": [{ scope: "workspace", name: "../escape.md" }] } })).rejects.toThrow("agent choices");
  });

  it("reports malformed project policy and retains supporting files when deleting", async () => {
    const { workspace, store } = await setup();
    await store.write("local/review", workspace, review);
    const supporting = path.join(workspace, ".agents/skills/review/example.md"); await writeFile(supporting, "Keep me");
    await store.delete("local/review", workspace);
    expect(await readFile(supporting, "utf8")).toBe("Keep me");
    expect((await store.list(workspace)).skills).toEqual([]);
    await writeFile(path.join(workspace, ".agents/skills.json"), "{broken");
    await expect(store.list(workspace)).rejects.toThrow("Invalid .agents/skills.json");
  });
});
