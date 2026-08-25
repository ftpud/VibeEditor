import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UsefulFilesStore } from "./useful-files.js";

describe("UsefulFilesStore", () => {
  it("creates, edits, renames, separates, and deletes useful files", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-useful-"));
    const first = new UsefulFilesStore("/workspace/first", state);
    const second = new UsefulFilesStore("/workspace/second", state);
    await first.create("global", "guide.md");
    await first.write("global", "guide.md", "shared");
    await first.create("local", "notes.txt");
    await first.write("local", "notes.txt", "private");
    expect(await second.read("global", "guide.md")).toBe("shared");
    expect((await second.list()).some((file) => file.scope === "local" && file.name === "notes.txt")).toBe(false);
    await first.rename("local", "notes.txt", "renamed.txt");
    expect(await first.read("local", "renamed.txt")).toBe("private");
    await first.delete("local", "renamed.txt");
    expect((await first.list()).some((file) => file.name === "renamed.txt")).toBe(false);
  });

  it("rejects paths and rename collisions", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-useful-"));
    const store = new UsefulFilesStore("/workspace", state);
    await expect(store.create("local", "../escape")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await store.create("local", "one.txt"); await store.create("local", "two.txt");
    await expect(store.rename("local", "one.txt", "two.txt")).rejects.toMatchObject({ code: "WRITE_FAILED" });
  });
});
