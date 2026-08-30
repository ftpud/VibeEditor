import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStateStore, validateWorkspaceOptions } from "./workspace-state.js";

describe("WorkspaceStateStore", () => {
  it("saves and restores workspace options", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    const store = new WorkspaceStateStore("/workspace/example", stateDirectory);
    const terminal = { tabs: [{ displayName: "Terminal 1", terminalId: "00000000-0000-0000-0000-000000000001" }, { displayName: "Build", terminalId: "00000000-0000-0000-0000-000000000002" }], activeTabIndex: 1, panelOpen: true };
    const fileColors = { "src/a.ts": "blue" as const, src: "green" as const };
    await store.save({ openFiles: ["src/a.ts", "README.md"], activeFile: "src/a.ts", terminal, fileColors });
    await expect(store.load()).resolves.toEqual({ openFiles: ["src/a.ts", "README.md"], activeFile: "src/a.ts", terminal, fileColors });
  });

  it("returns empty options when no state exists", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    await expect(new WorkspaceStateStore("/workspace/missing", stateDirectory).load()).resolves.toEqual({ openFiles: [] });
  });

  it("migrates legacy title-only terminal tabs to display metadata", () => {
    expect(validateWorkspaceOptions({ openFiles: [], terminal: { tabs: [{ title: "Legacy" }], activeTabIndex: 0, panelOpen: true } }).terminal).toEqual({ tabs: [{ displayName: "Legacy" }], activeTabIndex: 0, panelOpen: true });
  });

  it("keeps pinned file ordering and rejects pins for closed files", () => {
    expect(validateWorkspaceOptions({ openFiles: ["src/pinned.ts", "src/other.ts"], pinnedFiles: ["src/pinned.ts"] })).toEqual({ openFiles: ["src/pinned.ts", "src/other.ts"], pinnedFiles: ["src/pinned.ts"] });
    expect(() => validateWorkspaceOptions({ openFiles: ["src/a.ts"], pinnedFiles: ["src/missing.ts"] })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("retains only compact, bounded and deduplicated search metadata", () => {
    const search = { query: "  component ", path: "src", matchCase: true };
    expect(validateWorkspaceOptions({ openFiles: [], searchQueries: { recent: [search, search], saved: [search] } }).searchQueries).toEqual({ recent: [{ query: "component", path: "src", matchCase: true }], saved: [{ query: "component", path: "src", matchCase: true }] });
    expect(() => validateWorkspaceOptions({ openFiles: [], searchQueries: { recent: Array.from({ length: 11 }, () => search) } })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => validateWorkspaceOptions({ openFiles: [], searchQueries: { saved: [{ ...search, path: "../private" }] } })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("rejects unsafe and absolute tab paths", () => {
    expect(() => validateWorkspaceOptions({ openFiles: ["../secret"] })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => validateWorkspaceOptions({ openFiles: [path.resolve("/tmp/secret")] })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => validateWorkspaceOptions({ openFiles: [], fileColors: { "../secret": "red" } })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => validateWorkspaceOptions({ openFiles: [], fileColors: { "src/a.ts": "pink" } })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
