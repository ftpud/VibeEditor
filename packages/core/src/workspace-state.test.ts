import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStateStore, validateWorkspaceOptions } from "./workspace-state.js";

describe("WorkspaceStateStore", () => {
  it("saves and restores workspace options", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    const store = new WorkspaceStateStore("/workspace/example", stateDirectory);
    const terminal = { tabs: [{ title: "Terminal 1", terminalId: "00000000-0000-0000-0000-000000000001" }, { title: "Build", terminalId: "00000000-0000-0000-0000-000000000002" }], activeTabIndex: 1, panelOpen: true };
    const fileColors = { "src/a.ts": "blue" as const, src: "green" as const };
    await store.save({ openFiles: ["src/a.ts", "README.md"], activeFile: "src/a.ts", terminal, fileColors });
    await expect(store.load()).resolves.toEqual({ openFiles: ["src/a.ts", "README.md"], activeFile: "src/a.ts", terminal, fileColors });
  });

  it("returns empty options when no state exists", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    await expect(new WorkspaceStateStore("/workspace/missing", stateDirectory).load()).resolves.toEqual({ openFiles: [] });
  });

  it("keeps legacy title-only terminal tabs valid", () => {
    expect(validateWorkspaceOptions({ openFiles: [], terminal: { tabs: [{ title: "Legacy" }], activeTabIndex: 0, panelOpen: true } }).terminal).toEqual({ tabs: [{ title: "Legacy" }], activeTabIndex: 0, panelOpen: true });
  });

  it("rejects unsafe and absolute tab paths", () => {
    expect(() => validateWorkspaceOptions({ openFiles: ["../secret"] })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => validateWorkspaceOptions({ openFiles: [path.resolve("/tmp/secret")] })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => validateWorkspaceOptions({ openFiles: [], fileColors: { "../secret": "red" } })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => validateWorkspaceOptions({ openFiles: [], fileColors: { "src/a.ts": "pink" } })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
