import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { HarnessStore } from "./harnesses.js";

describe("HarnessStore", () => {
  it("persists workspace-isolated definitions and increments versions", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const first = new HarnessStore("/workspace/first", state);
    const second = new HarnessStore("/workspace/second", state);
    const created = await first.create("Review flow");
    const updated = await first.update({
      ...created,
      blocks: [{ id: "review", type: "prompt", label: "Review", prompt: "Review {{input}}", position: { x: 20, y: 30 } }],
      edges: []
    });

    expect(updated.version).toBe(2);
    expect((await first.list())[0]?.blocks[0]?.label).toBe("Review");
    expect(await second.list()).toEqual([]);

    await first.delete(created.id);
    expect(await first.list()).toEqual([]);
  });

  it("rejects invalid names and stale identifiers", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const store = new HarnessStore("/workspace", state);
    await expect(store.create("   ")).rejects.toThrow("1–120");
    await expect(store.delete("missing")).rejects.toThrow("does not exist");
  });
});
