import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppEventBridge, appBridgeInstanceId } from "./app-events.js";
import { appToolServer } from "./app-tools.js";

const writes = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }));
const fixtures: string[] = [];
async function createState(prefix: string): Promise<string> {
  const state = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(state);
  return state;
}

afterEach(async () => {
  writes.wait = undefined;
  writes.entered = undefined;
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    await actual.writeFile(...args);
    if (writes.wait && String(args[0]).endsWith(".tmp")) { writes.entered?.(); await writes.wait; }
  } };
});

describe("AppEventBridge", () => {
  it("hides incomplete command and response writes from readers", async () => {
    const state = await createState("vibe-atomic-bridge-");
    const bridge = new AppEventBridge("/workspace", state);
    let release!: () => void;
    const hold = () => {
      writes.wait = new Promise<void>((resolve) => { release = resolve; });
      return new Promise<void>((resolve) => { writes.entered = resolve; });
    };
    const entered = hold();
    const pending = bridge.call({ name: "workflow_use_block", args: { block_id: "git-check" } });
    try {
      await entered;
      expect((await readdir(bridge.commandsDirectory)).filter((file) => file.endsWith(".json"))).toEqual([]);
      const commandTemp = (await readdir(bridge.commandsDirectory)).find((file) => file.endsWith(".tmp"));
      expect(commandTemp).toBeDefined();
      expect((await stat(path.join(bridge.commandsDirectory, commandTemp!))).mode & 0o777).toBe(0o600);
      writes.wait = undefined; release();
      await vi.waitFor(async () => expect((await readdir(bridge.commandsDirectory)).some((file) => file.endsWith(".json"))).toBe(true));
      const file = (await readdir(bridge.commandsDirectory)).find((file) => file.endsWith(".json"))!;
      const responseEntered = hold();
      const consume = bridge.consumeCommand(path.join(bridge.commandsDirectory, file), async () => ({ output: "Unmerged paths:\nOK\n" }));
      await responseEntered;
      expect((await readdir(bridge.responsesDirectory)).filter((file) => file.endsWith(".json"))).toEqual([]);
      const responseTemp = (await readdir(bridge.responsesDirectory)).find((file) => file.endsWith(".tmp"));
      expect(responseTemp).toBeDefined();
      expect((await stat(path.join(bridge.responsesDirectory, responseTemp!))).mode & 0o777).toBe(0o600);
      writes.wait = undefined; release();
      await consume;
      await expect(pending).resolves.toEqual({ output: "Unmerged paths:\nOK\n" });
    } finally { writes.wait = undefined; writes.entered = undefined; release(); }
  });

  it("restricts legacy directories and published event files to the owner", async () => {
    const state = await createState("vibe-private-events-");
    const bridge = new AppEventBridge("/workspace", state);
    const directories = [bridge.directory, bridge.commandsDirectory, bridge.responsesDirectory];
    await Promise.all(directories.map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o755 });
      await chmod(directory, 0o755);
    }));

    await bridge.ready();
    for (const directory of directories) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }

    await bridge.emit({ type: "tasks.changed" });
    const [file] = await readdir(bridge.directory);
    expect(file).toBeDefined();
    expect((await stat(path.join(bridge.directory, file!))).mode & 0o777).toBe(0o600);
  });

  it("isolates workflow commands from other Core processes for the same workspace", async () => {
    const state = await createState("vibe-editor-command-owners-");
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
      files = (await readdir(owner.commandsDirectory)).filter((file) => file.endsWith(".json"));
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
    const state = await createState("vibe-editor-events-");
    const writer = new AppEventBridge("/workspace", state);
    const reader = new AppEventBridge("/workspace", state);
    await writer.emit({ type: "ai.changed", workspace: "/workspace/task" });
    const [file] = await readdir(reader.directory);

    await expect(reader.consume(path.join(reader.directory, file!))).resolves.toEqual({ type: "ai.changed", workspace: "/workspace/task" });
    await expect(readdir(reader.directory)).resolves.toEqual([]);
  });

  it("routes a command to the process that owns the live services", async () => {
    const state = await createState("vibe-editor-commands-");
    const caller = new AppEventBridge("/workspace", state);
    const owner = new AppEventBridge("/workspace", state);
    await owner.ready();

    const pending = caller.call({ name: "task_create_and_start", args: { provider: "codex" }, currentWorkspace: "/workspace/task", currentProvider: "codex" });
    let files: string[] = [];
    for (let attempt = 0; files.length === 0 && attempt < 100; attempt += 1) {
      files = (await readdir(owner.commandsDirectory)).filter((file) => file.endsWith(".json"));
      if (files.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(files).toHaveLength(1);
    await owner.consumeCommand(path.join(owner.commandsDirectory, files[0]!), async (command) => ({ owner: "core", command }));

    await expect(pending).resolves.toEqual({ owner: "core", command: { name: "task_create_and_start", args: { provider: "codex" }, currentWorkspace: "/workspace/task", currentProvider: "codex" } });
    await expect(readdir(owner.commandsDirectory)).resolves.toEqual([]);
    await expect(readdir(owner.responsesDirectory)).resolves.toEqual([]);
  });

  it("passes commit message changes with their task workspace", async () => {
    const state = await createState("vibe-editor-events-");
    const bridge = new AppEventBridge("/workspace", state);
    await bridge.emit({ type: "commit-message.changed", workspace: "/workspace/task", message: "Subject\n\nBody" });
    const [file] = await readdir(bridge.directory);
    await expect(bridge.consume(path.join(bridge.directory, file!))).resolves.toEqual({ type: "commit-message.changed", workspace: "/workspace/task", message: "Subject\n\nBody" });
  });
});
