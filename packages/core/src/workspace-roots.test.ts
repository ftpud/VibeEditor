import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRootRegistry } from "./workspace-roots.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-roots-")); cleanup.push(directory);
  const primary = path.join(directory, "primary"), related = path.join(directory, "related"), state = path.join(directory, "state");
  await Promise.all([mkdir(primary), mkdir(related), mkdir(state)]);
  return { directory, primary, related, state };
}

describe("WorkspaceRootRegistry", () => {
  it("keeps a stable primary identity and migrates a legacy single-root workspace", async () => {
    const { primary, state } = await fixture();
    const first = await WorkspaceRootRegistry.open(primary, state);
    expect(first.list()).toEqual([{ id: expect.stringMatching(/^root_/), alias: "primary", path: primary, primary: true }]);
    expect((await WorkspaceRootRegistry.open(primary, state)).primary().id).toBe(first.primary().id);
  });

  it("persists related roots without reinterpreting paths", async () => {
    const { primary, related, state } = await fixture();
    const registry = await WorkspaceRootRegistry.open(primary, state);
    const added = await registry.add(related, "api");
    const reopened = await WorkspaceRootRegistry.open(primary, state);
    expect(reopened.get(added.id)).toMatchObject({ alias: "api", path: related, primary: false });
  });

  it("rejects duplicate aliases, duplicate directories, relative paths, and primary removal", async () => {
    const { primary, related, state } = await fixture();
    const registry = await WorkspaceRootRegistry.open(primary, state);
    await registry.add(related, "api");
    await expect(registry.add(related, "other")).rejects.toThrow("already registered");
    await expect(registry.add(primary, "API")).rejects.toThrow();
    await expect(registry.add("relative", "other")).rejects.toThrow("absolute");
    await expect(registry.remove(registry.primary().id)).rejects.toThrow("primary root");
  });

  it("unregisters without deleting the underlying directory", async () => {
    const { primary, related, state } = await fixture();
    const registry = await WorkspaceRootRegistry.open(primary, state);
    const root = await registry.add(related, "api"); await registry.remove(root.id);
    expect(registry.list()).toHaveLength(1);
    await expect(mkdir(path.join(related, "still-here"))).resolves.toBeUndefined();
  });
});
