import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const shell = process.env.SHELL || "/bin/sh";
const shellArgs = (command: string, args: string[]) => ["-lc", "exec \"$@\"", "vibe-editor-shell", command, ...args];

export function spawnInShell(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn(shell, shellArgs(command, args), { cwd, env: process.env, stdio: "pipe" });
}

export async function execInShell(command: string, args: string[], options: ExecFileOptions & { encoding: "utf8" }): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(shell, shellArgs(command, args), { ...options, env: process.env }) as Promise<{ stdout: string; stderr: string }>;
}
