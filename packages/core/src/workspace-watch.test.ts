import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import chokidar from "chokidar";
import { expect, it } from "vitest";
import { workspaceWatchOptions } from "./workspace-watch.js";

it("prunes ignored build trees while watching tracked files under an ignore rule", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-large-watch-"));
  let watcher: ReturnType<typeof chokidar.watch> | undefined;
  try {
    await promisify(execFile)("git", ["init", "-q", root]);
    await writeFile(path.join(root, ".gitignore"), "build/\npartial/\n");
    for (const directory of ["build/large/cache", "partial", "src"]) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, "build/large/cache/log"), "generated");
    await writeFile(path.join(root, "partial/tracked.txt"), "tracked");
    await writeFile(path.join(root, "src/main.ts"), "source");
    await promisify(execFile)("git", ["-C", root, "add", "-f", "partial/tracked.txt"]);
    const options = await workspaceWatchOptions(root);
    expect(options.followSymlinks).toBe(false);
    watcher = chokidar.watch(root, options);
    await new Promise<void>((resolve, reject) => { watcher!.once("ready", resolve); watcher!.once("error", reject); });
    const watched = watcher.getWatched();
    expect(watched[path.join(root, "src")]).toContain("main.ts");
    expect(watched[path.join(root, "partial")]).toContain("tracked.txt");
    expect(Object.keys(watched).some((directory) => directory.startsWith(path.join(root, "build")))).toBe(false);
  } finally { await watcher?.close(); await rm(root, { recursive: true, force: true }); }
});
