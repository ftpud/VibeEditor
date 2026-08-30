import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { assertSessionChangeAllowed, permissionTargetWorkspace, sendWebSocketData } from "./server.js";
import { withAppTools } from "./app-tools.js";

describe("built-in app tool access", () => {
  it("does not grant tools without an explicit agent allowlist entry", () => {
    expect(withAppTools("/workspace", "/workspace").servers).toEqual([]);
    expect(withAppTools("/workspace", "/workspace/task", [], { name: "No tools", instructions: "", mcpServers: [] }).servers).toEqual([]);
  });

  it("adds the Vibe Editor server when explicitly allowed", () => {
    const result = withAppTools("/workspace", "/workspace/task", [], { name: "Coordinator", instructions: "", mcpServers: ["vibe-editor"] }, "codex");
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({ name: "vibe-editor", transport: "stdio", env: { VIBE_EDITOR_ROOT_WORKSPACE: "/workspace", VIBE_EDITOR_CURRENT_WORKSPACE: "/workspace/task", VIBE_EDITOR_CURRENT_PROVIDER: "codex" } });
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

describe("timer session ownership", () => {
  it("rejects session changes for the provider owning an active timer", async () => {
    const timers = { next: async (_workspace: string, provider?: string) => provider === "codex" ? { id: "timer" } : undefined };
    await expect(assertSessionChangeAllowed(timers as never, "/tasks/a/workspace", "codex")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(assertSessionChangeAllowed(timers as never, "/tasks/a/workspace", "copilot")).resolves.toBeUndefined();
  });
});

describe("WebSocket stream delivery", () => {
  it("drops a response that completes after the client disconnected", async () => {
    let readyState: number = WebSocket.OPEN;
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const socket = {
      get readyState() { return readyState; },
      send: () => { throw new Error("WebSocket is not open"); }
    } as unknown as WebSocket;

    const lateResponse = operation.then(() => sendWebSocketData(socket, JSON.stringify({ id: "ai-send", ok: true, result: {} })));
    readyState = WebSocket.CLOSED;
    finish();

    await expect(lateResponse).resolves.toBe(false);
  });

  it("contains a close race between the ready-state check and send", () => {
    const socket = {
      readyState: WebSocket.OPEN,
      send: () => { throw new Error("WebSocket is not open: readyState 2 (CLOSING)"); }
    } as unknown as WebSocket;

    expect(() => sendWebSocketData(socket, "late event")).not.toThrow();
    expect(sendWebSocketData(socket, "late event")).toBe(false);
  });
});
