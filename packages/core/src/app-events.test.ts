import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AppEventBridge, appBridgeInstanceId } from "./app-events.js";
import { appToolServer } from "./app-tools.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

describe("AppEventBridge", () => {
  it("keeps partial status commands and responses hidden from readers", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-editor-status-publication-"));
    const bridge = new AppEventBridge("/workspace", state);
    await bridge.ready();
    let releaseCommand!: () => void, releaseResponse!: () => void;
    let commandWritten!: () => void, responseWritten!: () => void;
    const commandGate = new Promise<void>((resolve) => { releaseCommand = resolve; });
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const commandPartial = new Promise<void>((resolve) => { commandWritten = resolve; });
    const responsePartial = new Promise<void>((resolve) => { responseWritten = resolve; });
    const slowWrite = (written: () => void, gate: Promise<void>): typeof writeFile => async (file, data, options) => {
      await actual.writeFile(file, String(data).slice(0, 10), options);
      written(); await gate;
      await actual.writeFile(file, data, options);
    };
    vi.mocked(writeFile).mockImplementationOnce(slowWrite(commandWritten, commandGate)).mockImplementationOnce(slowWrite(responseWritten, responseGate));
    let settled = false;
    const pending = bridge.call({ name: "workflow_use_block", args: { block_id: "child", action: "status" }, workflowRunId: "run", workflowBlockId: "parent" }, 2000);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    let consumed: Promise<void> | undefined;
    try {
      await commandPartial;
      expect((await readdir(bridge.commandsDirectory)).filter((file) => file.endsWith(".json"))).toEqual([]);
      releaseCommand();
      let files: string[] = [];
      await vi.waitFor(async () => { files = (await readdir(bridge.commandsDirectory)).filter((file) => file.endsWith(".json")); expect(files).toHaveLength(1); });
      const result = { blockId: "child", status: "running", completed: false, output: "" };
      consumed = bridge.consumeCommand(path.join(bridge.commandsDirectory, files[0]!), async (command) => { expect(command.args.action).toBe("status"); return result; });
      await responsePartial;
      expect((await readdir(bridge.responsesDirectory)).filter((file) => file.endsWith(".json"))).toEqual([]);
      // Let the caller poll several times while the response is incomplete.
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      releaseResponse();
      await consumed;
      await expect(pending).resolves.toEqual(result);
      expect(await readdir(bridge.commandsDirectory)).toEqual([]);
      expect(await readdir(bridge.responsesDirectory)).toEqual([]);
    } finally {
      releaseCommand(); releaseResponse();
      await consumed?.catch(() => {}); await pending.catch(() => {});
      vi.mocked(writeFile).mockImplementation(actual.writeFile);
    }
  });

  it("isolates workflow commands from other Core processes for the same workspace", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-editor-command-owners-"));
    const server = appToolServer("/workspace", "/workflow/session", "codex", "/workspace", { runId: "run", blockId: "agent", flow: true });
    if (!("command" in server)) throw new Error("Expected a stdio MCP server");
    expect(server.env?.VIBE_EDITOR_BRIDGE_INSTANCE_ID).toBe(appBridgeInstanceId);
    const caller = new AppEventBridge("/workspace", state, server.env?.VIBE_EDITOR_BRIDGE_INSTANCE_ID);
    const owner = new AppEventBridge("/workspace", state, appBridgeInstanceId);
    const other = new AppEventBridge("/workspace", state, "other-core");
    const legacy = new AppEventBridge("/workspace", state, "");
    await Promise.all([owner.ready(), other.ready(), legacy.ready()]);
    const command = { name: "workflow_use_block", args: { block_id: "git-status", input: "" }, workflowRunId: "run", workflowBlockId: "agent" };
    const pending = caller.call(command);
    let files: string[] = [];
    for (let attempt = 0; files.length === 0 && attempt < 100; attempt += 1) {
      files = await readdir(owner.commandsDirectory);
      if (!files.length) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(files).toHaveLength(1);
    expect(await readdir(other.commandsDirectory)).toEqual([]);
    expect(await readdir(legacy.commandsDirectory)).toEqual([]);
    await owner.consumeCommand(path.join(owner.commandsDirectory, files[0]!), async (received) => {
      expect(received).toEqual(command);
      return { blockId: "git-status", output: "main" };
    });
    await expect(pending).resolves.toEqual({ blockId: "git-status", output: "main" });
  });

  it("passes an event between processes and consumes its marker", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-editor-events-"));
    const writer = new AppEventBridge("/workspace", state);
    const reader = new AppEventBridge("/workspace", state);
    await writer.emit({ type: "ai.changed", workspace: "/workspace/task" });
    const [file] = await readdir(reader.directory);

    await expect(reader.consume(path.join(reader.directory, file!))).resolves.toEqual({ type: "ai.changed", workspace: "/workspace/task" });
    await expect(readdir(reader.directory)).resolves.toEqual([]);
  });

  it("routes a command to the process that owns the live services", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-editor-commands-"));
    const caller = new AppEventBridge("/workspace", state);
    const owner = new AppEventBridge("/workspace", state);
    await owner.ready();

    const pending = caller.call({ name: "task_create_and_start", args: { provider: "codex" }, currentWorkspace: "/workspace/task", currentProvider: "codex" });
    let files: string[] = [];
    for (let attempt = 0; files.length === 0 && attempt < 100; attempt += 1) {
      files = await readdir(owner.commandsDirectory);
      if (files.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(files).toHaveLength(1);
    await owner.consumeCommand(path.join(owner.commandsDirectory, files[0]!), async (command) => ({ owner: "core", command }));

    await expect(pending).resolves.toEqual({ owner: "core", command: { name: "task_create_and_start", args: { provider: "codex" }, currentWorkspace: "/workspace/task", currentProvider: "codex" } });
    await expect(readdir(owner.commandsDirectory)).resolves.toEqual([]);
    await expect(readdir(owner.responsesDirectory)).resolves.toEqual([]);
  });

  it("passes commit message changes with their task workspace", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "vibe-editor-events-"));
    const bridge = new AppEventBridge("/workspace", state);
    await bridge.emit({ type: "commit-message.changed", workspace: "/workspace/task", message: "Subject\n\nBody" });
    const [file] = await readdir(bridge.directory);
    await expect(bridge.consume(path.join(bridge.directory, file!))).resolves.toEqual({ type: "commit-message.changed", workspace: "/workspace/task", message: "Subject\n\nBody" });
  });
});
