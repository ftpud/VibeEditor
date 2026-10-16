import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import chokidar from "chokidar";

const execFileAsync = promisify(execFile);
/** Repository state that changes on commit, checkout, push, fetch, merge or rebase, wherever Git runs. */
const STATE_FILES = new Set(["index", "HEAD", "packed-refs", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD", "refs"]);

/**
 * Watches a workspace's Git state (including task worktrees, whose refs live in
 * the common directory) and reports changes in batches. `objects/` and lock
 * files are never watched.
 */
export async function watchGitState(workspace: string, onChange: () => void, delayMs = 250): Promise<ReturnType<typeof chokidar.watch>> {
  const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "--git-path", "index", "--git-path", "packed-refs"], { encoding: "utf8" });
  const [index, packedRefs] = stdout.trim().split("\n").map((value) => path.resolve(workspace, value.trim()));
  const gitDirectory = path.dirname(index!); const commonDirectory = path.dirname(packedRefs!); const refs = path.join(commonDirectory, "refs");
  const ignored = (file: string) => {
    if (file === gitDirectory || file === commonDirectory) return false;
    if (file.startsWith(`${refs}${path.sep}`)) return file.endsWith(".lock");
    const parent = path.dirname(file);
    return !((parent === gitDirectory || parent === commonDirectory) && STATE_FILES.has(path.basename(file)));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = chokidar.watch([...new Set([gitDirectory, commonDirectory])], { ignoreInitial: true, ignored });
  watcher.on("all", () => { clearTimeout(timer); timer = setTimeout(onChange, delayMs); });
  const close = watcher.close.bind(watcher);
  watcher.close = () => { clearTimeout(timer); return close(); };
  return watcher;
}
