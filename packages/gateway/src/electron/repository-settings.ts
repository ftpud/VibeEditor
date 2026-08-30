export type RepositorySettings = { repository: string; branch: string; autoUpdate: boolean };

export const defaultRepositorySettings: RepositorySettings = {
  repository: "https://github.com/ftpud/VibeEditor",
  branch: "main",
  autoUpdate: true
};

function shell(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export function normalizeRepositorySettings(value: Partial<RepositorySettings> | undefined): RepositorySettings {
  const repository = value?.repository?.trim() || defaultRepositorySettings.repository;
  const branch = value?.branch?.trim() || defaultRepositorySettings.branch;
  if (/\s|[\u0000-\u001f;'"`\\]/.test(repository) || !/^(?:https?|ssh|git):\/\/[^/\s]+\/.+|^[^@\s/:]+@[^\s:]+:.+$/.test(repository)) {
    throw new Error("Repository must be a valid HTTPS, SSH, Git, or SCP-style Git URL");
  }
  if (!/^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || /(?:\.|\/|\.lock)$/.test(branch)) {
    throw new Error("Branch must be a valid Git branch name");
  }
  return { repository, branch, autoUpdate: value?.autoUpdate !== false };
}

export function repositorySettingsOrDefault(value: Partial<RepositorySettings> | undefined): RepositorySettings {
  try { return normalizeRepositorySettings(value); }
  catch { return defaultRepositorySettings; }
}

export function provisionCommand(settings: RepositorySettings, remoteNodeEnvironment: string): string {
  const { repository, branch, autoUpdate } = normalizeRepositorySettings(settings);
  const quotedRepository = shell(repository);
  const quotedBranch = shell(branch);
  const update = autoUpdate ? `git -C ~/.vibe remote set-url origin ${quotedRepository}; git -C ~/.vibe fetch origin ${quotedBranch}; git -C ~/.vibe checkout --force -B ${quotedBranch} origin/${quotedBranch};` : "";
  return `set -e; ${remoteNodeEnvironment}; if [ -d ~/.vibe/.git ]; then ${update} else rm -rf ~/.vibe; git clone --branch ${quotedBranch} --single-branch ${quotedRepository} ~/.vibe; fi; cd ~/.vibe; head=$(git rev-parse HEAD); rebuilt=0; if [ ! -f ~/.vibe-build ] || [ "$(cat ~/.vibe-build)" != "$head" ] || [ ! -f packages/core/dist/index.js ] || [ ! -f packages/desktop/dist-electron/main.js ] || [ ! -f packages/desktop/dist-renderer/index.html ] || [ ! -d node_modules ] || ! node -e "require('node-pty')" >/dev/null 2>&1; then VIBE_SKIP_JDTLS=1 npm install; if ! node -e "require('node-pty')" >/dev/null 2>&1; then echo "Repairing the node-pty native module for $(uname -s)-$(uname -m)..."; if ! npm rebuild node-pty; then echo "node-pty could not be built. Install a C/C++ compiler, make, and Python 3 on the SSH host, then try again." >&2; exit 1; fi; fi; node -e "require('node-pty')" >/dev/null 2>&1 || { echo "node-pty is still unavailable after rebuilding it." >&2; exit 1; }; rm -rf packages/acp/dist packages/protocol/dist packages/core/dist packages/desktop/dist-electron packages/desktop/dist-renderer; npm run build -w @remote-ide/acp; npm run build -w @remote-ide/protocol; npm run build -w @remote-ide/core; npm run build -w @remote-ide/desktop; printf '%s' "$head" > ~/.vibe-build; rebuilt=1; fi; printf '\nVIBE_RESULT:%s:%s\n' "$head" "$rebuilt"`;
}
