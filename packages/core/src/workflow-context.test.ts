import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessBlock, HarnessRun } from "@remote-ide/protocol";
import { HarnessRunner } from "./harness-runner.js";
import { HarnessStore } from "./harnesses.js";
import { WorkflowAppService } from "./workflow-app.js";
import { startWorkflow, workflowRunWorkspace } from "./server.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const services: WorkflowAppService[] = [];
afterEach(async () => {
  services.splice(0).forEach((service) => service.closeAll());
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("runs apps and scripts with terminal shell initialization in the same Git worktree, including reruns", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-context-")); directories.push(directory);
  const root = path.join(directory, "root"), worktree = path.join(directory, "task");
  await mkdir(root);
  await execFileAsync("git", ["init", root]);
  await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
  await execFileAsync("git", ["-C", root, "worktree", "add", "--detach", worktree]);
  await writeFile(path.join(worktree, "marker.txt"), "task-files");
  // A configured shell supplies its own rcfile without changing the user's home.
  const shell = path.join(directory, "shell");
  await writeFile(shell, '#!/bin/bash\nexec /bin/bash --rcfile "$(dirname "$0")/rcfile" "$@"\n', { mode: 0o755 });
  await writeFile(path.join(directory, "rcfile"), 'workflow_tool() { printf "initialized|%s|" "$PWD"; cat marker.txt; }\n');
  vi.stubEnv("SHELL", shell);
  const store = new HarnessStore(root, path.join(directory, "state"));
  const runner = new HarnessRunner(store, () => {});
  const apps = new WorkflowAppService(); services.push(apps);
  const created = await store.create("Shell context");
  const block = (id: string, type: HarnessBlock["type"], extra: Partial<HarnessBlock> = {}): HarnessBlock => ({ id, type, label: id, prompt: "", position: { x: 0, y: 0 }, ...extra });
  const definition = await store.update({ ...created, blocks: [
    block("script", "script", { command: '[[ -n "$BASH_VERSION" ]] && workflow_tool' }),
    block("app", "run_app", { command: '[[ -n "$BASH_VERSION" ]] && workflow_tool; exec sleep 300', app: { name: "server", actions: ["start"] } }),
  ], edges: [{ id: "next", from: "script", to: "app", type: "follow" }] });
  const context = { harnessRunner: runner, workflowApps: apps, rootWorkspace: root, bridgeWorkspace: root, workspacePath: worktree } as Parameters<typeof startWorkflow>[1];
  const run = await startWorkflow({ harnessId: definition.id, input: "start", provider: "codex" }, context);
  await vi.waitFor(async () => expect((await runner.readRun(run.id))?.status).toBe("succeeded"));
  expect((await runner.readRun(run.id))?.workspace).toBe(worktree);
  expect((await runner.readRun(run.id))?.blocks.find((block) => block.blockId === "script")?.output).toBe(`initialized|${worktree}|task-files`);
  await vi.waitFor(() => expect(apps.read("server", worktree).output).toContain(`initialized|${worktree}|task-files`));
  expect(apps.read("server", root).status).toBe("not_found");
  const rerun = await startWorkflow({ harnessId: definition.id, input: "rerun", provider: "codex", rerunRunId: run.id }, { ...context, workspacePath: root });
  await vi.waitFor(async () => expect((await runner.readRun(rerun.id))?.status).toBe("succeeded"));
  expect(rerun.workspace).toBe(worktree);
  expect((await runner.readRun(rerun.id))?.blocks.find((block) => block.blockId === "script")?.output).toBe(`initialized|${worktree}|task-files`);
});

it("recovers the worktree from older workflow session aliases", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-alias-")); directories.push(directory);
  const worktree = path.join(directory, "task"), alias = path.join(directory, "session");
  await mkdir(worktree); await symlink(worktree, alias, "dir");
  const run = { blocks: [{ blockId: "chat", workspace: alias }] } as HarnessRun;
  expect(await workflowRunWorkspace(run, "/selected-root")).toBe(worktree);
  expect(await workflowRunWorkspace({ ...run, workspace: worktree }, "/selected-root")).toBe(worktree);
});
