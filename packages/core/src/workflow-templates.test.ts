import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workflowTemplate } from "./workflow-templates.js";
import { validateHarness } from "./harness-graph.js";
import { executeFlowScript } from "./workflow-script.js";

const exec = promisify(execFile);
const template = workflowTemplate("git-review-commit");
const script = (id: string) => template.blocks.find((block) => block.id === id)!;

describe("Git review and commit template", () => {
  it("validates with a button start and a user prompt before the push script", () => {
    expect(validateHarness({ ...template, id: "git", name: "Git", version: 1, createdAt: "now", updatedAt: "now" }).valid).toBe(true);
    expect(template.blocks.filter((block) => block.type === "script")).toHaveLength(8);
    expect(template.edges.filter((edge) => edge.to === "git-push")).toEqual([
      { id: "git-answer-push", from: "git-push-question", to: "git-push", type: "follow" }
    ]);
    expect(script("git-report-document").type).toBe("markdown");
    expect(template.edges).toContainEqual({ id: "git-open-report", from: "git-finished", to: "git-report-document", type: "follow" });
    expect(script("git-start").type).toBe("start_button");
  });

  it("inspects without modifying files, safely commits the message, and pushes only after approval", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-git-"));
    const git = (...args: string[]) => exec("git", args, { cwd: directory });
    await git("init", "-b", "main");
    await git("config", "user.name", "Workflow Test");
    await git("config", "user.email", "workflow@example.invalid");
    await writeFile(path.join(directory, "file.txt"), "before\n");
    await git("add", "."); await git("commit", "-m", "Initial commit");
    await writeFile(path.join(directory, "file.txt"), "after\n");
    await writeFile(path.join(directory, "new.txt"), "new\n");
    const before = (await git("status", "--porcelain")).stdout;
    for (const id of ["git-status", "git-diff", "git-history", "git-remotes", "git-check"]) {
      await executeFlowScript(script(id), "", directory, () => {});
    }
    expect((await git("status", "--porcelain")).stdout).toBe(before);
    const message = 'Update example files\n\nKeep literal $(touch injected) and `touch injected`.';
    await executeFlowScript(script("git-commit"), message, directory, () => {});
    expect((await git("log", "-1", "--format=%B")).stdout.trim()).toBe(message);
    expect((await git("status", "--porcelain")).stdout).toBe("");
    expect(await readFile(path.join(directory, "file.txt"), "utf8")).toBe("after\n");
    expect(await readFile(path.join(directory, "new.txt"), "utf8")).toBe("new\n");
    await expect(readFile(path.join(directory, "injected"))).rejects.toThrow();
    const remote = path.join(directory, "remote.git");
    await exec("git", ["init", "--bare", remote]);
    await git("remote", "add", "origin", remote);
    await git("config", "branch.main.remote", "origin");
    await git("config", "branch.main.merge", "refs/heads/main");
    for (const answer of ["no", "PUSH", "yes\n"]) {
      await executeFlowScript(script("git-push"), answer, directory, () => {});
      await expect(exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).rejects.toThrow();
    }
    await executeFlowScript(script("git-push"), "yes", directory, () => {});
    expect((await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout).toBe((await git("rev-parse", "HEAD")).stdout);
  });
});
