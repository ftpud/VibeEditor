import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { assertRequestRoot, assertSessionChangeAllowed, permissionTargetWorkspace, protocolHandshake, renameWorkspacePaths, sendWebSocketData, WorkspaceWatchBatcher } from "./server.js";

describe("protocol handshake", () => {
  it("accepts overlapping ranges and describes incompatible Desktops", () => {
    expect(protocolHandshake({ minimum: 3, maximum: 3 })).toMatchObject({ compatible: true, compatibility: { minimum: 3, maximum: 3 } });
    expect(protocolHandshake({ minimum: 2, maximum: 2 })).toEqual({ compatible: false, compatibility: { minimum: 3, maximum: 3 }, message: "Core supports protocol 3-3; this Desktop supports 2-2" });
    expect(protocolHandshake({ minimum: 3, maximum: 1 }).compatible).toBe(false);
  });
});

describe("workspace watcher batching", () => {
  it("coalesces bursts and marks bounded batches as overflowed", () => {
    const events: unknown[] = [];
    const batcher = new WorkspaceWatchBatcher((event) => events.push(event), 60_000, 2);
    batcher.change("a.ts"); batcher.change("b.ts"); batcher.change("c.ts"); batcher.degrade("overflow"); batcher.flush();
    expect(events).toEqual([{ type: "filesystem.changed", payload: { rootId: "legacy", paths: ["a.ts", "b.ts"], overflow: true, health: "degraded", message: "overflow" } }]);
  });
});

describe("workspace root request boundary", () => {
  it("accepts the selected identity and rejects missing or cross-root identities", () => {
    expect(() => assertRequestRoot({ id: "1", type: "filesystem.readFile", rootId: "root-a", payload: { path: "README.md" } }, "root-a")).not.toThrow();
    expect(() => assertRequestRoot({ id: "2", type: "filesystem.readFile", rootId: "root-b", payload: { path: "README.md" } }, "root-a")).toThrow("not the selected root");
    expect(() => assertRequestRoot({ id: "3", type: "filesystem.readFile", payload: { path: "README.md" } } as never, "root-a")).toThrow("requires an explicit rootId");
  });
});
import { withAppTools } from "./app-tools.js";
import type { WorkspaceTaskStore } from "./tasks.js";

describe("workspace paths after filesystem moves", () => {
  it("updates tabs, colors, and Java project paths under a moved directory", () => {
    const result = renameWorkspacePaths({ openFiles: ["src/App.java", "README.md"], pinnedFiles: ["src/App.java"], activeFile: "src/App.java", fileColors: { "src/App.java": "blue" }, javaProject: { type: "maven", pomPath: "src/pom.xml", mavenExecutable: "mvn", sourceRoots: ["src/main/java"], outputPath: "src/target/classes", testOutputPath: "src/target/test-classes", runConfigurations: [] } }, "src", "app");
    expect(result).toMatchObject({ openFiles: ["app/App.java", "README.md"], pinnedFiles: ["app/App.java"], activeFile: "app/App.java", fileColors: { "app/App.java": "blue" }, javaProject: { pomPath: "app/pom.xml", sourceRoots: ["app/main/java"], outputPath: "app/target/classes" } });
  });
});

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
    list: async () => ({ tasks: [{ id: "task-a", name: "A", branch: "a", baseBranch: "main", status: "active" as const, archived: false }, { id: "task-b", name: "B", branch: "b", baseBranch: "main", status: "active" as const, archived: false }] }),
    taskPath: (taskId: string) => `/tasks/${taskId}/workspace`
  } satisfies Pick<WorkspaceTaskStore, "list" | "taskPath">;

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
