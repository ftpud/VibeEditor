import "./plugins/languages/java/java-settings.js"; // registers the Java workspace-state validators
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceStateStore, validateWorkspaceOptions } from "./workspace-state.js";

describe("WorkspaceStateStore", () => {
  it("persists workflow document references per task without duplicating Markdown content", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "workflow-document-state-"));
    const workflowDocuments = [{ runId: "run", blockId: "report", position: 1, active: true, pinned: true, markdownMode: "preview" as const }];
    const store = new WorkspaceStateStore("/workspace/task-a", stateDirectory);
    await store.save({ openFiles: ["file.ts"], workflowDocuments });
    expect(await new WorkspaceStateStore("/workspace/task-a", stateDirectory).load()).toEqual({ openFiles: ["file.ts"], workflowDocuments });
    expect(await new WorkspaceStateStore("/workspace/task-b", stateDirectory).load()).toEqual({ openFiles: [] });
    await store.save({ openFiles: [], workflowDocuments: [] });
    expect((await store.load()).workflowDocuments).toEqual([]);
    expect(() => validateWorkspaceOptions({ openFiles: [], workflowDocuments: [{ ...workflowDocuments[0], position: -1 }] })).toThrow("Invalid workflow document tab");
  });

  it("restores the last good options after corruption and refuses an unrecoverable store", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "workspace-recovery-"));
    const store = new WorkspaceStateStore("/workspace/recovery", directory);
    await store.save({ openFiles: ["first.ts"] });
    await store.save({ openFiles: ["second.ts"] });
    const file = path.join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!);
    await writeFile(file, "{interrupted");
    expect(await store.load()).toEqual({ openFiles: ["first.ts"] });
    await store.save({ openFiles: ["restored.ts"] });
    expect(await store.load()).toEqual({ openFiles: ["restored.ts"] });
    await writeFile(file, "{broken");
    await writeFile(`${file}.bak`, "{broken too");
    await expect(store.load()).rejects.toMatchObject({ code: "READ_FAILED" });
    await expect(store.save({ openFiles: [] })).rejects.toMatchObject({ code: "WRITE_FAILED" });
  });

  it("saves and restores workspace options", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    const store = new WorkspaceStateStore("/workspace/example", stateDirectory);
    const terminal = { tabs: [{ displayName: "Terminal 1", terminalId: "00000000-0000-0000-0000-000000000001" }, { displayName: "Build", terminalId: "00000000-0000-0000-0000-000000000002" }], activeTabIndex: 1, panelOpen: true };
    const fileColors = { "src/a.ts": "blue" as const, src: "green" as const };
    await store.save({ openFiles: ["src/a.ts", "README.md"], activeFile: "src/a.ts", terminal, fileColors });
    await expect(store.load()).resolves.toEqual({ openFiles: ["src/a.ts", "README.md"], activeFile: "src/a.ts", terminal, fileColors });
  });

  it("restores breakpoints for closed files after reopening the store and isolates workspaces", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-breakpoints-"));
    const javaBreakpoints = [{ path: "src/main/java/App.java", className: "App", line: 8 }];
    const store = new WorkspaceStateStore("/workspace/debug", stateDirectory);
    await store.save({ openFiles: [], javaBreakpoints });
    await expect(new WorkspaceStateStore("/workspace/debug", stateDirectory).load()).resolves.toEqual({ openFiles: [], javaBreakpoints });
    await expect(new WorkspaceStateStore("/workspace/other", stateDirectory).load()).resolves.toEqual({ openFiles: [] });
    await store.save({ openFiles: [], javaBreakpoints: [] });
    await expect(store.load()).resolves.toEqual({ openFiles: [], javaBreakpoints: [] });
  });

  it("rejects malformed breakpoints and deduplicates file locations", () => {
    const breakpoint = { path: "src/App.java", className: "example.App$Inner", line: 8 };
    expect(validateWorkspaceOptions({ openFiles: [], javaBreakpoints: [breakpoint, breakpoint] }).javaBreakpoints).toEqual([breakpoint]);
    for (const invalid of [null, { ...breakpoint, path: "../App.java" }, { ...breakpoint, line: 0 }, { ...breakpoint, line: 1.5 }, { ...breakpoint, className: "App\ncont" }]) {
      expect(() => validateWorkspaceOptions({ openFiles: [], javaBreakpoints: [invalid] })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    }
  });

  it("returns empty options when no state exists", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    await expect(new WorkspaceStateStore("/workspace/missing", stateDirectory).load()).resolves.toEqual({ openFiles: [] });
  });

  it("serializes rapid saves and retains the latest options", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    const store = new WorkspaceStateStore("/workspace/rapid-edits", stateDirectory);
    const messages = Array.from({ length: 50 }, (_, index) => `Commit message ${index}`);
    await expect(Promise.all(messages.map((gitCommitMessage) => store.save({ openFiles: [], gitCommitMessage })))).resolves.toHaveLength(messages.length);
    await expect(store.load()).resolves.toEqual({ openFiles: [], gitCommitMessage: messages.at(-1) });
  });

  it("does not collide when stores for the same workspace save concurrently", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "remote-ide-state-"));
    const first = new WorkspaceStateStore("/workspace/shared", stateDirectory);
    const second = new WorkspaceStateStore("/workspace/shared", stateDirectory);
    const messages = Array.from({ length: 50 }, (_, index) => `Commit message ${index}`);
    await expect(Promise.all(messages.map((gitCommitMessage, index) => (index % 2 ? first : second).save({ openFiles: [], gitCommitMessage })))).resolves.toHaveLength(messages.length);
    expect(messages).toContain((await first.load()).gitCommitMessage);
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
