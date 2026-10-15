import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const execute = promisify(execFile);

/** Create missing parents and initialize Git for empty standalone workspaces. */
export async function prepareLocalWorkspaceDirectory(directory: string): Promise<string> {
  const value = directory.trim();
  if (!path.isAbsolute(value)) throw new Error("The local project directory must be an absolute path");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("The local project directory contains unsupported control characters");
  try { await mkdir(value, { recursive: true }); }
  catch (error) {
    if (["EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error("The local project path is not a directory");
    throw error;
  }
  if (!(await stat(value)).isDirectory()) throw new Error("The local project path is not a directory");
  const directoryPath = await realpath(value);
  if ((await readdir(directoryPath)).length === 0) {
    try { await execute("git", ["-C", directoryPath, "rev-parse", "--git-dir"], { env: { ...process.env, LC_ALL: "C" } }); }
    catch (error) {
      if (!String((error as { stderr?: string }).stderr ?? error).includes("not a git repository")) throw error;
      await execute("git", ["-C", directoryPath, "init", "--quiet"]);
    }
  }
  return directoryPath;
}
