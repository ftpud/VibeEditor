const maximumDirectoryLength = 4_096;
const maximumDiscoveredDirectories = 64;

export function validateWorkspaceDirectoryInput(directory: string): string {
  const value = directory.trim();
  if (!value) throw new Error("A remote directory is required");
  if (value.length > maximumDirectoryLength) throw new Error("The remote directory path is too long");
  if (!value.startsWith("/")) throw new Error("The remote directory must be an absolute path (for example /home/user/projects/api)");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("The remote directory contains unsupported control characters");
  return value;
}

export function quoteWorkspaceShellArgument(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

/** Lists direct home folders plus one level below conventional project folders. */
export function workspaceDiscoveryCommand(): string {
  return "bash -lc 'set -eu; count=0; emit() { printf \"%s\\n\" \"$1\"; count=$((count + 1)); }; emit \"$HOME\"; for child in \"$HOME\"/*; do [ -d \"$child\" ] || continue; emit \"$child\"; [ \"$count\" -ge 64 ] && break; done; [ \"$count\" -ge 64 ] || for name in projects Projects workspace workspaces code Code src repos repositories; do root=\"$HOME/$name\"; [ -d \"$root\" ] || continue; for child in \"$root\"/*; do [ -d \"$child\" ] || continue; emit \"$child\"; [ \"$count\" -ge 64 ] && break 2; done; done'";
}

/** Checks one manually entered directory without enumerating any parent or sibling paths. */
export function workspaceValidationCommand(directory: string): string {
  const value = validateWorkspaceDirectoryInput(directory);
  return `bash -lc ${quoteWorkspaceShellArgument(`set -eu; directory=${quoteWorkspaceShellArgument(value)}; [ -d "$directory" ] || { echo "Remote directory does not exist or is not a directory" >&2; exit 1; }; [ -r "$directory" ] && [ -x "$directory" ] || { echo "Remote directory is not accessible to this SSH user" >&2; exit 1; }; cd -- "$directory"; pwd -P`)}`;
}

export function parseDiscoveredWorkspaceDirectories(output: string): string[] {
  const directories: string[] = [];
  for (const line of output.split("\n")) {
    const value = line.trim();
    if (!value || directories.length >= maximumDiscoveredDirectories) continue;
    try { if (!directories.includes(validateWorkspaceDirectoryInput(value))) directories.push(value); }
    catch { /* Remote filenames outside the strict UI contract are not shown. */ }
  }
  return directories;
}

export function parseValidatedWorkspaceDirectory(output: string): string {
  const lines = output.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error("Could not validate the remote directory");
  return validateWorkspaceDirectoryInput(lines[0]!);
}
