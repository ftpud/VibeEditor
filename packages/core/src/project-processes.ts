import path from "node:path";
import { realpath } from "node:fs/promises";
import type { WorkspaceTask } from "@remote-ide/protocol";
import { managedProcesses, type ManagedProcesses } from "./managed-processes.js";

/** Scope by the registered project identity, never by host PID or selected task. */
export async function listProjectProcesses(rootWorkspace: string, tasks: { list(): Promise<{ tasks: WorkspaceTask[] }>; taskPath(id: string): string }, host: ManagedProcesses = managedProcesses) {
  const registry = await tasks.list();
  return Promise.all((await host.list()).filter((item) => path.resolve(item.rootWorkspace) === path.resolve(rootWorkspace)).map(async (item) => {
    const canonical = await realpath(item.workspace).catch(() => item.workspace);
    const task = registry.tasks.find((task) => path.resolve(tasks.taskPath(task.id)) === path.resolve(canonical));
    return { ...item, ...(task ? { taskId: task.id, taskName: task.name } : {}) };
  }));
}
export function killProjectProcess(rootWorkspace: string, processId: string, host: ManagedProcesses = managedProcesses) {
  return host.kill(processId, async (context) => path.resolve(context.rootWorkspace) === path.resolve(rootWorkspace));
}
