import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AiConfiguration, AiModel, AiProviderDescriptor } from "@remote-ide/acp";
import type { HarnessBlock, WorkspaceTask } from "@remote-ide/protocol";
import { StdioAcpProvider } from "./ai/stdio-provider.js";
import { WorkflowAppService } from "./workflow-app.js";
import { managedProcesses } from "./managed-processes.js";
import { killProjectApp, listProjectApps, killProjectProcess, listProjectProcesses } from "./project-processes.js";

class TestProvider extends StdioAcpProvider {
  readonly descriptor: AiProviderDescriptor = { id: "test-neutral", name: "Test", description: "test", settings: { title: "Test", description: "test", sections: [] }, options: [], capabilities: { models: true, usage: false, mcp: false, agents: false, contextWindow: false } };
  constructor(state: string, root: string) { super({ onChanged: () => {}, stateDirectory: state, projectRoot: async () => root }); }
  protected command(_configuration: AiConfiguration) { return { command: "python3", args: [fileURLToPath(new URL("./ai/providers/fake-acp-agent.py", import.meta.url))] }; }
  protected async fallbackModels(): Promise<AiModel[]> { return []; }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await pause(25); } throw new Error("Launch did not settle"); }

describe.skipIf(process.platform !== "linux")("project process operations through real launch hooks", () => {
  it("lists root, task and workflow ACP sessions plus Run App; rejects another root's kill and cleans app descendants", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-proc-integration-"));
    const root = path.join(directory, "project"); const task = path.join(directory, "task");
    const workflow = path.join(directory, "workflow-chat"); const otherRoot = path.join(directory, "other-project");
    await Promise.all([root, task, otherRoot].map((target) => mkdir(target))); await symlink(task, workflow, "dir");
    const tasks = { list: async () => ({ tasks: [{ id: "task-a", name: "Task A" } as WorkspaceTask] }), taskPath: () => task };
    const provider = new TestProvider(path.join(directory, "sessions"), root);
    const otherProvider = new TestProvider(path.join(directory, "other-sessions"), otherRoot);
    const apps = new WorkflowAppService();
    try {
      for (const workspace of [root, task, workflow]) await provider.send(workspace, { prompt: "hello", configuration: {} });
      managedProcesses.setWorkspaceContext(workflow, { workflowRunId: "workflow-run", workflowBlockId: "chat" });
      await otherProvider.send(otherRoot, { prompt: "hello", configuration: {} });
      expect(await listProjectApps(root, tasks)).toEqual([]); // Three real ACP hosts are not apps.
      const block: HarnessBlock = { id: "app", type: "run_app", label: "Server", prompt: "", position: { x: 0, y: 0 }, app: { name: "Server", actions: ["start"] }, command: "sleep 300 & sleep 300 & wait" };
      await apps.execute(block, "", task, () => {}, { rootWorkspace: root, workflowRunId: "workflow-run", workflowBlockId: "app" });
      await apps.execute({ ...block, app: { name: "Portal", actions: ["start"] }, command: "exec sleep 300" }, "", workflow, () => {}, { rootWorkspace: root, workflowRunId: "other-run", workflowBlockId: "portal" });
      await apps.execute(block, "", otherRoot, () => {}, { rootWorkspace: otherRoot, workflowRunId: "other-project-run", workflowBlockId: "app" });
      await eventually(async () => (await listProjectProcesses(root, tasks)).filter((item) => item.kind === "agent").length === 3);
      const list = await listProjectProcesses(root, tasks);
      await eventually(async () => (await listProjectApps(root, tasks)).find((item) => item.name === "Server")?.processCount === 3);
      const appRows = await listProjectApps(root, tasks);
      expect(appRows).toHaveLength(2);
      expect(appRows.find((item) => item.name === "Server")).toMatchObject({ taskId: "task-a", workflowRunId: "workflow-run", workflowBlockId: "app", processCount: 3 });
      expect(appRows.find((item) => item.name === "Portal")).toMatchObject({ taskId: "task-a", workspace: workflow, workflowRunId: "other-run", workflowBlockId: "portal" });
      const [foreignApp] = await listProjectApps(otherRoot, tasks);
      await expect(killProjectApp(root, foreignApp!.id)).rejects.toThrow("another project");
      await expect(async () => killProjectApp(root, list.find((item) => item.kind === "agent")!.id)).rejects.toThrow("Choose a workflow app");

      expect(list.find((item) => item.workspace === root)?.taskId).toBeUndefined();
      expect(list.find((item) => item.workspace === task && item.kind === "agent")).toMatchObject({ taskId: "task-a", taskName: "Task A", provider: "test-neutral", sessionId: (await provider.get(task)).threadId });
      expect(list.find((item) => item.workspace === workflow)).toMatchObject({ taskId: "task-a", workflowRunId: "workflow-run", workflowBlockId: "chat" });
      expect(list.some((item) => item.rootWorkspace === otherRoot)).toBe(false);
      const [other] = await listProjectProcesses(otherRoot, tasks); expect(other).toBeDefined();
      await expect(killProjectProcess(root, other!.id)).rejects.toThrow("another project");
      expect((await listProjectProcesses(otherRoot, tasks)).some((item) => item.id === other!.id)).toBe(true);
      const app = list.find((item) => item.kind === "workflow-app")!; expect(app).toMatchObject({ workflowBlockId: "app", taskName: "Task A" });
      await eventually(async () => (await listProjectProcesses(root, tasks)).some((item) => item.parentPid === app.pid));
      const descendantIds = (await listProjectProcesses(root, tasks)).filter((item) => item.parentPid === app.pid).map((item) => item.id);
      const appId = appRows.find((item) => item.name === "Server")!.id;
      expect(await killProjectApp(root, appId)).toBe(true);
      await eventually(async () => apps.read("Server", task).status === "exited");
      expect((await listProjectProcesses(root, tasks)).some((item) => item.id === app.id || descendantIds.includes(item.id))).toBe(false);
      expect((await listProjectProcesses(root, tasks)).filter((item) => item.kind === "agent")).toHaveLength(3);
      expect(await killProjectApp(root, appId)).toBe(false);
      expect((await listProjectApps(root, tasks)).map((item) => item.name)).toEqual(["Portal"]);
      expect(await listProjectApps(otherRoot, tasks)).toHaveLength(1);
    } finally {
      await apps.closeAll();
      for (const workspace of [root, otherRoot]) for (const entry of await listProjectProcesses(workspace, tasks)) await killProjectProcess(workspace, entry.id);
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
