import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { AiSession, HarnessBlock, HarnessRun } from "@remote-ide/protocol";
import { SkillsStore } from "./skills.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { HarnessStore } from "./harnesses.js";
import { HarnessRunner } from "./harness-runner.js";
import { WorkflowAppService } from "./workflow-app.js";
import { AiTimerService, AiTimerStore } from "./ai-timers.js";
import { resolveWorkflowBinding, startWorkflow, validateWorkflowTarget, workflowRunWorkspace } from "./server.js";

const exec = promisify(execFile);
let directory: string;
let apps: WorkflowAppService;
let timers: AiTimerService;
afterEach(async () => {
  await timers?.cancelAll(); await apps?.closeAll(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const block = (id: string, type: HarnessBlock["type"], extra: Partial<HarnessBlock> = {}): HarnessBlock => ({ id, type, label: id, prompt: "{{input}}", position: { x: 0, y: 0 }, ...extra });
async function setup() {
  directory = await mkdtemp(path.join(os.tmpdir(), "workflow-binding-"));
  const root = path.join(directory, "root"); await mkdir(root);
  vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
  const tasks = new WorkspaceTaskStore(root);
  const a = await tasks.create("task-a"), b = await tasks.create("task-b");
  const wa = tasks.taskPath(a.id), wb = tasks.taskPath(b.id);
  const store = new HarnessStore(root), runner = new HarnessRunner(store, () => {});
  apps = new WorkflowAppService();
  const sessions = new Map<string, AiSession>();
  const deliver = async (workspace: string, input: { prompt: string }) => {
    // An actual subprocess follows the agent session alias and writes in its cwd.
    const result = await exec(process.execPath, ["-e", 'require("node:fs").appendFileSync("agent-effects.txt",process.cwd()+"\\n");process.stdout.write(process.cwd())'], { cwd: workspace });
    const session = { id: "session", model: "test", reasoning: "", status: "done", messages: [{ id: "reply", role: "assistant", text: `${input.prompt}|${result.stdout}`, timestamp: "now" }] } as AiSession;
    sessions.set(workspace, session); return session;
  };
  const provider = { descriptor: { id: "test", options: [] }, get: async (workspace: string) => sessions.get(workspace)!, startFreshSession: vi.fn(deliver), send: vi.fn(deliver), steer: vi.fn(async (workspace: string, prompt: string) => deliver(workspace, { prompt })) };
  const acp = { get: () => provider };
  timers = new AiTimerService(new AiTimerStore(root), acp as never, root, () => {}, async (timer, effect) => {
    const run = await runner.readRun(timer.workflowRunId!); if (!run) throw new Error("Missing run");
    await validateWorkflowTarget(run, timer.workspace, { tasks, rootWorkspace: root, workspacePath: wb });
    return effect();
  });
  const context = { tasks, rootWorkspace: root, bridgeWorkspace: root, workspacePath: wb, harnessRunner: runner, workflowApps: apps, acp, agents: { list: async () => [] }, aiTimers: timers } as unknown as Parameters<typeof startWorkflow>[1];
  return { root, tasks, a, b, wa, wb, store, runner, context, provider };
}

it("captures task A while selection is B, preserves agent cwd, script/app effects and reruns across switches", async () => {
  const f = await setup(); const created = await f.store.create("Binding");
  const definition = await f.store.update({ ...created, blocks: [block("agent", "ai"), block("script", "script", { command: 'pwd > script-effects.txt; sleep 0.1' }), block("app", "run_app", { command: 'pwd > app-effects.txt; exec sleep 300', app: { name: "bound", actions: ["start"] } })], edges: [{ id: "one", from: "agent", to: "script", type: "follow" }, { id: "two", from: "script", to: "app", type: "follow" }] });
  const run = await startWorkflow({ harnessId: definition.id, input: "run", target: { taskId: f.a.id }, provider: "test" }, f.context);
  await f.tasks.select(f.b.id);
  await vi.waitFor(async () => expect((await f.runner.readRun(run.id))?.status).toBe("succeeded"));
  expect(run.binding).toMatchObject({ taskId: f.a.id, taskName: "task-a", workspace: f.wa, rootWorkspace: f.root });
  expect(await realpath(f.provider.startFreshSession.mock.calls[0]![0])).toBe(f.wa);
  for (const file of ["agent-effects.txt", "script-effects.txt", "app-effects.txt"]) {
    await vi.waitFor(async () => expect(await readFile(path.join(f.wa, file), "utf8")).toContain(f.wa));
    await expect(readFile(path.join(f.wb, file))).rejects.toThrow();
    await expect(readFile(path.join(f.root, file))).rejects.toThrow();
  }
  const rerun = await startWorkflow({ harnessId: definition.id, input: "ignored", rerunRunId: run.id, target: { taskId: f.b.id }, provider: "test" }, { ...f.context, workspacePath: f.root });
  await vi.waitFor(async () => expect((await f.runner.readRun(rerun.id))?.status).toBe("succeeded"));
  expect(rerun.binding).toEqual(run.binding);
  const legacy = { ...(await f.runner.readRun(run.id))!, id: "legacy-alias-run", binding: undefined, workspace: undefined };
  await f.store.saveRun(legacy);
  const legacyRerun = await startWorkflow({ harnessId: definition.id, input: "legacy", rerunRunId: legacy.id, target: { taskId: f.b.id }, provider: "test" }, f.context);
  await vi.waitFor(async () => expect((await f.runner.readRun(legacyRerun.id))?.status).toBe("succeeded"));
  expect(legacyRerun.binding?.taskId).toBe(f.a.id);
  const rootRun = await startWorkflow({ harnessId: definition.id, input: "root", target: {}, provider: "test" }, f.context);
  await vi.waitFor(async () => expect((await f.runner.readRun(rootRun.id))?.status).toBe("succeeded"));
  expect(rootRun.binding?.workspace).toBe(f.root); expect(rootRun.binding?.taskId).toBeUndefined();
});

it("continues a Chatbox and fires its delayed timer in A after switching to B and rebuilding the runner", async () => {
  const f = await setup(); const created = await f.store.create("Chat");
  const definition = await f.store.update({ ...created, blocks: [block("chat", "chatbox")], edges: [] });
  const run = await startWorkflow({ harnessId: definition.id, input: "first", startBlockId: "chat", target: { taskId: f.a.id }, provider: "test" }, f.context);
  await vi.waitFor(async () => expect((await f.runner.readRun(run.id))?.status).toBe("succeeded"));
  const saved = (await f.runner.readRun(run.id))!; const alias = saved.blocks[0]!.workspace!;
  const timer = await timers.schedule(alias, "test", "delayed", 3600, { runId: run.id, blockId: "chat" });
  await f.tasks.select(f.b.id);
  await timers.fireById(timer.id);
  const reconnected = new HarnessRunner(new HarnessStore(f.root), () => {});
  const continued = await startWorkflow({ harnessId: definition.id, input: "continued", startBlockId: "chat", chatRunId: run.id, target: { taskId: f.b.id }, provider: "test" }, { ...f.context, harnessRunner: reconnected });
  await vi.waitFor(async () => expect((await reconnected.readRun(run.id))?.status).toBe("succeeded"));
  expect(continued.binding).toEqual(run.binding);
  expect(f.provider.send.mock.calls.every(([workspace]) => workspace === alias)).toBe(true);
  expect((await readFile(path.join(f.wa, "agent-effects.txt"), "utf8")).trim().split("\n")).toEqual([f.wa, f.wa, f.wa]);
  await expect(readFile(path.join(f.wb, "agent-effects.txt"))).rejects.toThrow();
});

it("rejects deleted worktrees and unbound legacy runs, and permits only registered recorded child targets", async () => {
  const f = await setup(); const binding = await resolveWorkflowBinding(undefined, { taskId: f.a.id }, f.context);
  const run = { id: "legacy", binding, workspace: f.wa, blocks: [], children: [{ taskId: f.b.id, workspace: f.wb }] } as unknown as HarnessRun;
  await expect(validateWorkflowTarget(run, f.wb, f.context)).resolves.toBeUndefined();
  await expect(validateWorkflowTarget({ ...run, children: [] }, f.wb, f.context)).rejects.toThrow("different worktree");
  const redirected = path.join(directory, "redirected-session"); await symlink(f.wb, redirected, "dir");
  await expect(validateWorkflowTarget({ ...run, children: [] }, redirected, f.context)).rejects.toThrow("different worktree");
  await expect(workflowRunWorkspace({ ...run, binding: undefined, workspace: undefined, blocks: [{ blockId: "child", status: "succeeded", workspace: f.wb }] }, f.root)).rejects.toThrow("no recorded workspace");
  await expect(workflowRunWorkspace({ blocks: [] } as unknown as HarnessRun, f.wb)).rejects.toThrow("no recorded workspace");
  await expect(resolveWorkflowBinding(undefined, { taskId: "deleted" }, f.context)).rejects.toThrow("does not exist");
  await rm(f.wa, { recursive: true, force: true });
  await expect(resolveWorkflowBinding(run, { taskId: f.b.id }, f.context)).rejects.toThrow("unavailable");
  await expect(workflowRunWorkspace({ workspace: f.wa, blocks: [] } as unknown as HarnessRun, f.wb)).rejects.toThrow("unavailable");
});

it("loads skills and verifies and reviews the selected task's actual files and commit", async () => {
  const f = await setup();
  const skills = new SkillsStore(undefined, f.root);
  for (const [workspace, text] of [[f.wa, "Instructions from A"], [f.wb, "Instructions from B"]]) {
    await skills.write("workspace/check", workspace!, `---\nname: Check\ndescription: Check files\n---\n${text}`);
    await skills.writePolicy(workspace!, { allowed: ["workspace/check"], defaults: [] });
  }
  await writeFile(path.join(f.wa, "review-only.txt"), "Only A has this change");
  await exec("git", ["-C", f.wa, "add", "review-only.txt"]);
  await exec("git", ["-C", f.wa, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Task A change"]);
  const revision = (await exec("git", ["-C", f.wa, "rev-parse", "HEAD"])).stdout.trim();
  const created = await f.store.create("Gates");
  const definition = await f.store.update({ ...created, blocks: [block("skill", "skill", { skillId: "workspace/check" }), block("verify", "verification", { verification: { command: "pwd > verification-effects.txt; cat review-only.txt", revision } }), block("review", "review", { review: { revision } })], edges: [{ id: "verify", from: "skill", to: "verify", type: "follow" }, { id: "review", from: "verify", to: "review", type: "follow" }] });
  const run = await startWorkflow({ harnessId: definition.id, input: "check", provider: "test", target: { taskId: f.a.id } }, f.context);
  await vi.waitFor(async () => expect((await f.runner.readRun(run.id))?.status).toBe("succeeded"));
  const saved = (await f.runner.readRun(run.id))!;
  expect(saved.blocks.find((block) => block.blockId === "skill")?.output).toContain("Instructions from A");
  expect(saved.blocks.find((block) => block.blockId === "skill")?.output).toContain(f.wa);
  expect(await readFile(path.join(f.wa, "verification-effects.txt"), "utf8")).toBe(`${f.wa}\n`);
  await expect(readFile(path.join(f.wb, "verification-effects.txt"))).rejects.toThrow();
  expect(f.provider.startFreshSession.mock.calls[0]![1].prompt).toContain(revision);
  expect(f.provider.startFreshSession.mock.calls[0]![1].prompt).toContain("Only A has this change");
});
