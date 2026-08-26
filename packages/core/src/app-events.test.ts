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
});
