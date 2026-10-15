import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ChokidarOptions } from "chokidar";

const execute = promisify(execFile);

/** Prune ignored directory trees before chokidar allocates watches for them. */
export async function workspaceWatchOptions(workspace: string): Promise<ChokidarOptions> {
  const ignoredDirectories = new Set<string>();
  try {
    const { stdout } = await execute("git", ["-C", workspace, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const relative of stdout.split("\0")) if (relative.endsWith("/")) ignoredDirectories.add(path.resolve(workspace, relative));
  } catch { /* Non-Git workspaces still support filesystem watching. */ }
  return {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (target) => {
      const relative = path.relative(workspace, target);
      if (relative.split(path.sep).some((part) => part === ".git" || part === "node_modules")) return true;
      for (let current = path.resolve(target); current !== workspace && current !== path.dirname(current); current = path.dirname(current)) {
        if (ignoredDirectories.has(current)) return true;
      }
      return false;
    },
    // Polling avoids macOS's descriptor-per-file watcher cost. Other hosts can
    // opt in when their native watch limits are too small for the repository.
    usePolling: process.platform === "darwin" || process.env.VIBE_WATCH_POLLING === "1",
    interval: 1000,
    binaryInterval: 1500,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  };
}
