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

export function provisionCommand(settings: RepositorySettings, remoteNodeEnvironment: string, repair = false, preferredRelease?: string): string {
  const { repository, branch, autoUpdate } = normalizeRepositorySettings(settings);
  if (preferredRelease && !/^[0-9a-f]{40,64}-node[0-9]+(?:-repair-[a-zA-Z0-9]+)?$/.test(preferredRelease)) throw new Error("Invalid preferred release identity");
  const lines = [
    "set -eu",
    "umask 077",
    "echo 'VIBE_STAGE:checkout'",
    remoteNodeEnvironment,
    `REPOSITORY=${shell(repository)}`,
    `BRANCH=${shell(branch)}`,
    `AUTO_UPDATE=${autoUpdate ? "1" : "0"}`,
    `REPAIR=${repair ? "1" : "0"}`,
    `PREFERRED_RELEASE=${shell(preferredRelease ?? "")}`,
    'ROOT="$HOME/.vibe-deploy"',
    'SOURCES="$ROOT/sources"',
    'RELEASES="$ROOT/releases"',
    'LOCK="$ROOT/provision.lock"',
    'LOCK_OWNER=""',
    'STAGING=""',
    'mkdir -p "$SOURCES" "$RELEASES"',
    'HOST=$(hostname 2>/dev/null || uname -n)',
    'LOCK_TOKEN=$(node -e "process.stdout.write(require(\'node:crypto\').randomBytes(16).toString(\'hex\'))")',
    'LOCK_OWNER="$$|$HOST|$LOCK_TOKEN"',
    'release_lock() { if [ -n "$LOCK_OWNER" ] && [ -f "$LOCK/owner" ] && [ "$(cat "$LOCK/owner" 2>/dev/null || true)" = "$LOCK_OWNER" ]; then rm -rf "$LOCK"; fi; if [ -n "$STAGING" ]; then rm -rf "$STAGING"; fi; }',
    'trap release_lock EXIT',
    "trap 'exit 130' INT",
    "trap 'exit 129' HUP",
    "trap 'exit 143' TERM",
    'owner_is_alive() { if kill -0 "$1" 2>/dev/null; then return 0; fi; if command -v ps >/dev/null 2>&1 && ps -p "$1" >/dev/null 2>&1; then return 0; fi; return 1; }',
    'lock_started=$SECONDS',
    'while ! mkdir "$LOCK" 2>/dev/null; do',
    '  owner_line=$(cat "$LOCK/owner" 2>/dev/null || true)',
    '  owner_pid=${owner_line%%|*}',
    '  owner_tail=${owner_line#*|}',
    '  owner_host=${owner_tail%%|*}',
    '  owner_token=${owner_tail#*|}',
    '  case "$owner_pid" in \'\'|*[!0-9]*) owner_pid="" ;; esac',
    '  if [ -n "$owner_pid" ] && [ -n "$owner_token" ] && [ "$owner_host" = "$HOST" ] && ! owner_is_alive "$owner_pid"; then',
    '    if mkdir "$LOCK/recovery" 2>/dev/null; then',
    '      current_owner=$(cat "$LOCK/owner" 2>/dev/null || true)',
    '      if [ "$current_owner" = "$owner_line" ] && ! owner_is_alive "$owner_pid"; then rm -rf "$LOCK"; continue; fi',
    '      if [ "$(cat "$LOCK/owner" 2>/dev/null || true)" = "$owner_line" ]; then rmdir "$LOCK/recovery" 2>/dev/null || true; fi',
    '    fi',
    '  fi',
    '  if [ $((SECONDS - lock_started)) -ge 300 ]; then',
    '    if [ -n "$owner_pid" ] && [ -n "$owner_host" ]; then echo "Timed out waiting for provisioning lock held by PID $owner_pid on $owner_host ($LOCK)." >&2; else echo "Timed out waiting for provisioning lock with unknown owner ($LOCK); inspect it before removing it." >&2; fi',
    '    exit 1',
    '  fi',
    '  sleep 0.25',
    'done',
    'owner_tmp="$LOCK/owner.tmp.$$"',
    'printf \'%s\\n\' "$LOCK_OWNER" > "$owner_tmp"',
    'mv "$owner_tmp" "$LOCK/owner"',
    'SOURCE_KEY=$(node -e "const c=require(\'node:crypto\'); const [r,b]=process.argv.slice(1); process.stdout.write(c.createHash(\'sha256\').update(r+\'\\0\'+b).digest(\'hex\'))" "$REPOSITORY" "$BRANCH")',
    'SOURCE_CACHE="$SOURCES/$SOURCE_KEY"',
    'if [ ! -d "$SOURCE_CACHE/.git" ]; then mkdir -p "$SOURCE_CACHE"; git -C "$SOURCE_CACHE" init; fi',
    'if git -C "$SOURCE_CACHE" remote get-url origin >/dev/null 2>&1; then git -C "$SOURCE_CACHE" remote set-url origin "$REPOSITORY"; else git -C "$SOURCE_CACHE" remote add origin "$REPOSITORY"; fi',
    'SELECTED_UPDATE=0',
    'if [ "$AUTO_UPDATE" = 1 ] || [ ! -f "$SOURCE_CACHE/selected" ]; then',
    '  echo \'VIBE_STAGE:fetch\'',
    '  git -C "$SOURCE_CACHE" fetch --no-tags origin "$BRANCH:refs/remotes/origin/$BRANCH"',
    '  COMMIT=$(git -C "$SOURCE_CACHE" rev-parse --verify "refs/remotes/origin/$BRANCH^{commit}")',
    '  SELECTED_UPDATE=1',
    'else',
    '  COMMIT=$(cat "$SOURCE_CACHE/selected")',
    '  git -C "$SOURCE_CACHE" cat-file -e "$COMMIT^{commit}"',
    'fi',
    'case "$COMMIT" in \'\'|*[!a-f0-9]*) echo "Resolved source revision is not a hexadecimal Git commit." >&2; exit 1 ;; esac',
    'git -C "$SOURCE_CACHE" update-ref refs/heads/vibe-selected "$COMMIT"',
    'NODE_ABI=$(node -p "process.versions.modules")',
    'PLATFORM=$(node -p "process.platform")',
    'ARCH=$(node -p "process.arch")',
    'BUILD_MARKER="$COMMIT:node$NODE_ABI:$PLATFORM:$ARCH"',
    'if [ "$REPAIR" = 1 ]; then',
    '  REPAIR_NONCE=$(node -e "process.stdout.write(require(\'node:crypto\').randomBytes(8).toString(\'hex\'))")',
    '  RELEASE_KEY="$COMMIT-node$NODE_ABI-repair-$REPAIR_NONCE"',
    'else',
    '  RELEASE_KEY="$COMMIT-node$NODE_ABI"',
    'fi',
    'if [ "$REPAIR" != 1 ] && [[ "$PREFERRED_RELEASE" =~ ^$COMMIT-node$NODE_ABI(-repair-[a-zA-Z0-9]+)?$ ]]; then RELEASE_KEY="$PREFERRED_RELEASE"; fi',
    'RELEASE_PATH="$RELEASES/$RELEASE_KEY"',
    'release_is_valid() { local directory="$1"; [ -f "$directory/.vibe-build" ] && [ "$(cat "$directory/.vibe-build")" = "$BUILD_MARKER" ] && [ -f "$directory/packages/core/dist/index.js" ] && [ -f "$directory/packages/desktop/dist-electron/main.js" ] && [ -f "$directory/packages/desktop/dist-renderer/index.html" ] && (cd "$directory" && node -e "require(\'node-pty\')" >/dev/null 2>&1 && node --input-type=module -e "await import(\'./packages/protocol/dist/index.js\')" && node --input-type=module -e "await import(\'./packages/core/dist/server.js\')"); }',
    'rebuilt=0',
    'if [ "$REPAIR" = 1 ]; then',
    '  echo \'VIBE_STAGE:repair\'',
    '  rebuilt=1',
    'elif [ -e "$RELEASE_PATH" ] || [ -L "$RELEASE_PATH" ]; then',
    '  if ! release_is_valid "$RELEASE_PATH"; then echo "Immutable release $RELEASE_KEY exists but failed validation; use Repair to build a separate release." >&2; exit 1; fi',
    'else',
    '  rebuilt=1',
    'fi',
    'if [ "$rebuilt" = 1 ]; then',
    '  STAGING=$(mktemp -d "$RELEASES/.staging-$RELEASE_KEY.XXXXXXXXXX")',
    '  echo \'VIBE_STAGE:checkout-commit\'',
    '  git clone --no-checkout --branch vibe-selected "$SOURCE_CACHE" "$STAGING"',
    '  git -C "$STAGING" remote set-url origin "$REPOSITORY"',
    '  git -C "$STAGING" checkout --detach "$COMMIT"',
    '  cd "$STAGING"',
    '  echo \'VIBE_STAGE:install\'',
    '  VIBE_SKIP_JDTLS=1 npm ci',
    '  if ! node -e "require(\'node-pty\')" >/dev/null 2>&1; then',
    '    echo \'VIBE_STAGE:repair-node-pty\'',
    '    if ! npm rebuild node-pty; then echo "node-pty could not be built. Install a C/C++ compiler, make, and Python 3 on the SSH host, then try Repair." >&2; exit 1; fi',
    '  fi',
    '  node -e "require(\'node-pty\')" >/dev/null 2>&1 || { echo "node-pty is unavailable after rebuilding it." >&2; exit 1; }',
    '  echo \'VIBE_STAGE:build\'',
    '  npm run build -w @remote-ide/acp',
    '  npm run build -w @remote-ide/protocol',
    '  npm run build -w @remote-ide/core',
    '  npm run build -w @remote-ide/desktop',
    '  test -f packages/core/dist/index.js',
    '  test -f packages/desktop/dist-electron/main.js',
    '  test -f packages/desktop/dist-renderer/index.html',
    '  echo \'VIBE_STAGE:smoke-check\'',
    '  node --input-type=module -e "await import(\'./packages/protocol/dist/index.js\')"',
    '  node --input-type=module -e "await import(\'./packages/core/dist/server.js\')"',
    '  printf \'%s\\n\' "$BUILD_MARKER" > .vibe-build',
    '  release_is_valid "$STAGING" || { echo "Staged release failed its smoke checks." >&2; exit 1; }',
    '  if [ -e "$RELEASE_PATH" ] || [ -L "$RELEASE_PATH" ]; then echo "Release path $RELEASE_KEY already exists; refusing to replace an immutable release." >&2; exit 1; fi',
    '  mv "$STAGING" "$RELEASE_PATH"',
    '  STAGING=""',
    'fi',
    'release_is_valid "$RELEASE_PATH" || { echo "Final release failed validation." >&2; exit 1; }',
    'if [ "$SELECTED_UPDATE" = 1 ]; then',
    '  selected_tmp="$SOURCE_CACHE/selected.tmp.$$.$LOCK_TOKEN"',
    '  printf \'%s\\n\' "$COMMIT" > "$selected_tmp"',
    '  mv "$selected_tmp" "$SOURCE_CACHE/selected"',
    'fi',
    'printf \'\\nVIBE_RESULT:%s:%s:%s\\n\' "$COMMIT" "$rebuilt" "$RELEASE_KEY"'
  ];
  return lines.join("\n");
}
