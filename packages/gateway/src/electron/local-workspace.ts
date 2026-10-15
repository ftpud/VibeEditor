import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Create missing parents before saving a local workspace; preserve existing contents. */
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
  return realpath(value);
}
