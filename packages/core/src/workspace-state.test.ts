import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStateStore, validateWorkspaceOptions } from "./workspace-state.js";

describe("WorkspaceStateStore", () => {
  it("saves and restores workspace options", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    const store = new WorkspaceStateStore("/workspace/example", stateDirectory);
    await store.save({ openFiles: ["src/a.ts", "README.md"], activeFile: "src/a.ts" });
    await expect(store.load()).resolves.toEqual({ openFiles: ["src/a.ts", "README.md"], activeFile: "src/a.ts" });
  });

  it("returns empty options when no state exists", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    await expect(new WorkspaceStateStore("/workspace/missing", stateDirectory).load()).resolves.toEqual({ openFiles: [] });
  });

  it("rejects unsafe and absolute tab paths", () => {
    expect(() => validateWorkspaceOptions({ openFiles: ["../secret"] })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => validateWorkspaceOptions({ openFiles: [path.resolve("/tmp/secret")] })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
