import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AppEventBridge } from "./app-events.js";

describe("AppEventBridge", () => {
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

    const pending = caller.call({ name: "task_create_and_start", args: { provider: "codex" } });
    let files: string[] = [];
    for (let attempt = 0; files.length === 0 && attempt < 100; attempt += 1) {
      files = await readdir(owner.commandsDirectory);
      if (files.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(files).toHaveLength(1);
    await owner.consumeCommand(path.join(owner.commandsDirectory, files[0]!), async (command) => ({ owner: "core", command }));

    await expect(pending).resolves.toEqual({ owner: "core", command: { name: "task_create_and_start", args: { provider: "codex" } } });
    await expect(readdir(owner.commandsDirectory)).resolves.toEqual([]);
    await expect(readdir(owner.responsesDirectory)).resolves.toEqual([]);
  });
});
