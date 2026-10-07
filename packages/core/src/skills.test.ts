import crypto from "node:crypto";
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
  return { root, workspace, store: new SkillsStore(path.join(root, "state"), workspace) };
}
const review = "---\nname: Reviewer\ndescription: Review changes\n---\n\nCheck regressions and tests.\n";

describe("project skills", () => {
  it("discovers separate global/local skills and persists a project allowlist with defaults", async () => {
    const { root, workspace, store } = await setup();
    expect(await store.list(workspace)).toEqual({ skills: [], policy: { allowed: [], defaults: [] }, policyStorage: "local" });
    await store.write("global/review", workspace, review);
    await store.write("local/review", workspace, "Local instructions");
    const catalog = await store.list(workspace);
    expect(catalog.skills.map((skill) => skill.id)).toEqual(["global/review", "local/review"]);
    expect(catalog.skills[0]).toMatchObject({ title: "Reviewer", description: "Review changes" });
    await store.writePolicy(workspace, { allowed: ["local/review"], defaults: ["local/review"] });
    expect(await store.defaults(workspace)).toEqual(["local/review"]);
    await expect(store.validateSelection(workspace, ["global/review"])).rejects.toThrow("not allowed");
    expect(await store.validateSelection(workspace, ["local/review", "local/review"])).toEqual(["local/review"]);
    expect(JSON.parse(await readFile(path.join(root, "state/skills/local", crypto.createHash("sha256").update(workspace).digest("hex"), "skills.json"), "utf8"))).toEqual({ allowed: ["local/review"], defaults: ["local/review"], scopeVersion: 2 });
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
    expect((await new SkillsStore(path.join(root, "state"), other).list(other)).skills.map((skill) => skill.id)).toEqual(["global/review"]);
    expect(await new SkillsStore(path.join(root, "state"), other).defaults(other)).toEqual([]);
  });

  it("shares local skills across task checkouts, isolates projects and preserves workspace skills", async () => {
    const { root, workspace, store } = await setup();
    const task = path.join(root, "task"); const other = path.join(root, "other");
    await Promise.all([mkdir(task), mkdir(other)]);
    await store.write("local/review", workspace, "Shared project instructions");
    await store.write("workspace/review", workspace, "Checkout instructions");
    const taskStore = new SkillsStore(path.join(root, "state"), workspace);
    expect(await taskStore.read("local/review", task)).toBe("Shared project instructions");
    expect((await taskStore.list(task)).skills.map((skill) => skill.id)).toEqual(["local/review"]);
    expect((await store.list(workspace)).skills.map((skill) => skill.id)).toEqual(["local/review", "workspace/review"]);
    await taskStore.write("local/review", task, "Edited from task");
    expect(await store.read("local/review", workspace)).toBe("Edited from task");
    expect(await store.read("workspace/review", workspace)).toBe("Checkout instructions");
    expect((await new SkillsStore(path.join(root, "state"), other).list(other)).skills).toEqual([]);
    expect((await taskStore.list(task)).skills[0]!.path).toContain(`${path.sep}state${path.sep}skills${path.sep}local${path.sep}`);
    await expect(readFile(path.join(task, ".agents/skills/review/SKILL.md"))).rejects.toThrow();
  });

  it("retains checkout policy, agent restrictions and old chat selections across the scope upgrade", async () => {
    const { workspace, store } = await setup();
    await store.write("workspace/review", workspace, review);
    await writeFile(path.join(workspace, ".agents/skills.json"), JSON.stringify({ allowed: ["local/review"], defaults: ["local/review"], agents: { "local/review": [null] } }));
    const catalog = await store.list(workspace);
    expect(catalog.policy).toEqual({ allowed: ["workspace/review"], defaults: ["workspace/review"], agents: { "workspace/review": [null] } });
    expect(await store.validateSelection(workspace, ["local/review"])).toEqual(["workspace/review"]);
    expect(await store.instructions(workspace, ["local/review"])).toContain("Check regressions");
    await store.writePolicy(workspace, catalog.policy);
    expect((await store.list(workspace)).policy).toEqual(catalog.policy);
    await store.write("local/review", workspace, "New project-local instructions");
    await store.writePolicy(workspace, { allowed: ["local/review", "workspace/review"], defaults: ["local/review"] });
    expect(await store.validateSelection(workspace, ["local/review"])).toEqual(["local/review"]);
    expect(await store.instructions(workspace, ["local/review"])).toContain("New project-local instructions");
    expect(await store.instructions(workspace, ["local/review"])).not.toContain("Check regressions");
  });

  it("moves legacy policy outside Git, shares it with tasks and gives local policy precedence", async () => {
    const { root, workspace, store } = await setup();
    const task = path.join(root, "task"); await mkdir(task);
    await store.write("local/review", workspace, review);
    const policy = { allowed: ["local/review"], defaults: ["local/review"], agents: { "local/review": [null] }, scopeVersion: 2 };
    await mkdir(path.join(workspace, ".agents"));
    const legacy = path.join(workspace, ".agents/skills.json");
    await writeFile(legacy, JSON.stringify(policy));
    expect((await store.list(task)).policyStorage).toBe("workspace");
    await store.movePolicyToLocal(task);
    await expect(readFile(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.list(workspace)).policyStorage).toBe("local");
    expect(await store.defaults(task)).toEqual(["local/review"]);
    expect((await store.list(task)).policy.agents).toEqual(policy.agents);
    await expect(store.validateSelection(task, ["local/review"], { scope: "global", name: "review.md" })).rejects.toThrow("selected agent");
    await mkdir(path.join(task, ".agents"));
    await writeFile(path.join(task, ".agents/skills.json"), "{broken");
    expect(await store.defaults(task)).toEqual(["local/review"]);
    await store.writePolicy(task, { allowed: [], defaults: [] });
    expect(await store.defaults(workspace)).toEqual([]);
    await store.movePolicyToLocal(task);
    expect(await readFile(path.join(task, ".agents/skills.json"), "utf8")).toBe("{broken");
  });

  it("saves new policies outside the checkout without creating a .agents directory", async () => {
    const { root, workspace, store } = await setup();
    await store.writePolicy(workspace, { allowed: [], defaults: [] });
    await expect(readFile(path.join(workspace, ".agents/skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const other = path.join(root, "other"); await mkdir(other);
    expect((await new SkillsStore(path.join(root, "state"), other).list(other)).policy).toEqual({ allowed: [], defaults: [] });
    expect((await store.list(workspace)).policyStorage).toBe("local");
  });

  it("rejects invalid policies, traversal, oversized instructions and symlink escapes", async () => {
    const { root, workspace, store } = await setup();
    await expect(store.writePolicy(workspace, { allowed: [], defaults: ["local/review"] })).rejects.toThrow("defaults must be allowed");
    await expect(store.write("local/../../escape", workspace, review)).rejects.toThrow("Skill ID");
    await expect(store.write("local/review", workspace, "x".repeat(256 * 1024 + 1))).rejects.toThrow("256 KB");
    const outside = path.join(root, "outside"); await mkdir(outside);
    await symlink(outside, path.join(workspace, ".agents"));
    await expect(store.write("workspace/review", workspace, review)).rejects.toThrow("escapes");
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
    await store.write("workspace/review", workspace, review);
    const supporting = path.join(workspace, ".agents/skills/review/example.md"); await writeFile(supporting, "Keep me");
    await store.delete("workspace/review", workspace);
    expect(await readFile(supporting, "utf8")).toBe("Keep me");
    expect((await store.list(workspace)).skills).toEqual([]);
    await writeFile(path.join(workspace, ".agents/skills.json"), "{broken");
    await expect(store.list(workspace)).rejects.toThrow("Invalid skill policy");
  });
});
