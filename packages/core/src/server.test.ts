import { describe, expect, it } from "vitest";
import { permissionTargetWorkspace, withAppTools } from "./server.js";

describe("built-in app tool access", () => {
  it("does not grant tools without an explicit agent allowlist entry", () => {
    expect(withAppTools("/workspace").servers).toEqual([]);
    expect(withAppTools("/workspace", [], { name: "No tools", instructions: "", mcpServers: [] }).servers).toEqual([]);
  });

  it("adds the Vibe Editor server when explicitly allowed", () => {
    const result = withAppTools("/workspace", [], { name: "Coordinator", instructions: "", mcpServers: ["vibe-editor"] });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({ name: "vibe-editor", transport: "stdio", env: { VIBE_EDITOR_ROOT_WORKSPACE: "/workspace" } });
    expect(result.agent?.mcpServers).toEqual(["vibe-editor"]);
  });
});

describe("permission request task routing", () => {
  const tasks = {
    list: async () => ({ tasks: [{ id: "task-a", name: "A", branch: "a", baseBranch: "main" }, { id: "task-b", name: "B", branch: "b", baseBranch: "main" }] }),
    taskPath: (taskId: string) => `/tasks/${taskId}/workspace`
  };

  it("routes root and simultaneous task requests independently of the selected task", async () => {
    await expect(permissionTargetWorkspace(tasks, "/root")).resolves.toBe("/root");
    await expect(permissionTargetWorkspace(tasks, "/root", "task-a")).resolves.toBe("/tasks/task-a/workspace");
    await expect(permissionTargetWorkspace(tasks, "/root", "task-b")).resolves.toBe("/tasks/task-b/workspace");
  });

  it("rejects stale task ownership instead of falling back to the active workspace", async () => {
    await expect(permissionTargetWorkspace(tasks, "/root", "deleted-task")).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Task does not exist" });
  });
});
