/** Shared by remote provisioning, Core launch, health checks and release reads.
 * Keep /usr/local/bin as a fallback so it cannot shadow an existing PATH runtime. */
export const remoteNodeEnvironment = `export PATH="$HOME/.local/bin:$HOME/.volta/bin:$HOME/.fnm:$PATH:/usr/local/bin"
export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh" --no-use
  if vibe_node_version=$(nvm version 24 2>/dev/null); then
    :
  elif vibe_node_version=$(nvm version node 2>/dev/null); then
    :
  else
    echo 'No installed NVM Node version was found. Install Node 24 with: nvm install 24' >&2
    exit 1
  fi
  nvm use --silent "$vibe_node_version" >/dev/null || { echo 'Could not select the NVM Node runtime for Vibe.' >&2; exit 1; }
fi
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || { echo 'Node.js and npm were not found on the SSH host. Install Node 24 with NVM for this user.' >&2; exit 127; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Vibe requires Node.js 22.12+ for build and runtime; selected " + process.versions.node + ". Install Node 24 with: nvm install 24"); process.exit(1); }'`;
