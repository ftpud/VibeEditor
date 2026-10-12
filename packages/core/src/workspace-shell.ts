import os from "node:os";

/** Terminals, Useful Scripts and workflow commands use the same shell setup. */
export function workspaceShell(): string {
  return process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/bash");
}

export function workspaceShellCommand(command: string): { shell: string; args: string[] } {
  const shell = workspaceShell();
  // Interactive startup loads the same PATH, functions and aliases as terminals.
  // Keep descendants in the detached process group so stop/cancel reaches them.
  const args = os.platform() === "win32" ? ["-Command", command] : ["-ic", `set +m\n${command}`];
  return { shell, args };
}
