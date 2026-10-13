import { expect, it } from "vitest";
import { CoreClient } from "./client";
import type { EditorGroup, EditorTab } from "./model";
import { recoverEditorGroups, workspaceRestorationGuard } from "./workspace-recovery";

const file = (id: string, path: string, content: string, extra: Partial<EditorTab> = {}): EditorTab => ({ id, path, type: "file", title: path, content, savedContent: content, rootId: "root-a", dirty: false, loading: false, revision: { identity: "inode", version: "original" }, ...extra });

it("retains unsaved buffers, original save baselines, and active/view state across all editor groups", () => {
  const dirty = file("dirty", "a.md", "live edits", { dirty: true, savedContent: "baseline", pinned: true, markdownMode: "edit", error: "existing conflict" });
  const unpersisted = file("new", "new.txt", "unsaved new tab", { dirty: true });
  const otherRoot = file("other", "a.md", "other root edits", { rootId: "root-b", dirty: true });
  const draft = file("agent", "agent.md", "agent draft", { type: "agent", dirty: true, savedContent: "original agent" });
  const clean = file("clean", "clean.txt", "old disk", { pinned: true });
  const groups: EditorGroup[] = [{ id: "primary", tabs: [dirty, clean, otherRoot], activeTabId: dirty.id }, { id: "secondary", tabs: [unpersisted, draft], activeTabId: draft.id }];
  const restored = [file("disk-a", "a.md", "changed on disk", { revision: { identity: "inode", version: "external" } }), file("disk-clean", "clean.txt", "new disk")];
  const result = recoverEditorGroups(groups, restored, "disk-clean", "root-a");
  expect(result[0]!.tabs[0]).toBe(dirty);
  expect(result[0]!.activeTabId).toBe(dirty.id);
  expect(result[0]!.tabs[1]).toMatchObject({ id: "clean", content: "new disk", pinned: true });
  expect(result[0]!.tabs[2]).toBe(otherRoot);
  expect(result[1]!.tabs).toEqual([unpersisted, draft]);
  expect(result[1]!.activeTabId).toBe(draft.id);
  expect(result.flatMap((group) => group.tabs).filter((tab) => tab.rootId === "root-a" && tab.path === "a.md")).toHaveLength(1);
});

it("uses live edits made while a recovery read is delayed instead of the earlier clean buffer", async () => {
  const client = new CoreClient(); client.setRoot("root-a");
  const current = workspaceRestorationGuard(client, "root-a", "/task-a", () => client, () => "/task-a");
  let groups: EditorGroup[] = [{ id: "primary", tabs: [file("a", "a.txt", "baseline")], activeTabId: "a" }];
  let finish!: (tabs: EditorTab[]) => void;
  const read = new Promise<EditorTab[]>((resolve) => { finish = resolve; });
  const restoring = read.then((tabs) => { groups = recoverEditorGroups(groups, tabs, tabs[0]?.id, "root-a", current); });
  const edited = { ...groups[0]!.tabs[0]!, content: "typed while disconnected", dirty: true };
  groups = [{ ...groups[0]!, tabs: [edited] }];
  finish([file("from-disk", "a.txt", "external change")]);
  await restoring;
  expect(groups[0]!.tabs[0]).toBe(edited);
  expect(groups[0]!.tabs[0]).toMatchObject({ content: "typed while disconnected", savedContent: "baseline", revision: { version: "original" }, dirty: true });
});

it("ignores delayed snapshots after client, root, workspace replacement or shutdown", async () => {
  for (const replacement of ["client", "root", "workspace", "shutdown"]) {
    const client = new CoreClient(); client.setRoot("root-a");
    let liveClient = client;
    let workspace = "/task-a";
    const controller = new AbortController();
    const current = workspaceRestorationGuard(client, "root-a", workspace, () => liveClient, () => workspace, controller.signal);
    const before: EditorGroup[] = [{ id: "primary", tabs: [file("a", "a.txt", "live", { dirty: true })], activeTabId: "a" }];
    let groups = before;
    let finish!: (tabs: EditorTab[]) => void;
    const read = new Promise<EditorTab[]>((resolve) => { finish = resolve; });
    const restoring = read.then((tabs) => { groups = recoverEditorGroups(groups, tabs, "obsolete", "root-a", current); });
    if (replacement === "client") liveClient = new CoreClient();
    if (replacement === "root") client.setRoot("root-b");
    if (replacement === "workspace") workspace = "/task-b";
    if (replacement === "shutdown") controller.abort();
    finish([file("obsolete", "extra.txt", "obsolete snapshot")]);
    await restoring;
    expect(groups).toBe(before);
    expect(groups[0]!.tabs).toHaveLength(1);
  }
});
