# Early Access bundles

Run **Actions → Bundle Create → Run workflow** on the commit or branch you want
packaged. The workflow uploads two artifact sets, `vibe-early-access-macos-15`
and `vibe-early-access-windows-2025`. Download and extract the artifact wrapper;
each contains a Gateway installer, a standalone Desktop ZIP, and JSON manifests
with their version, source commit and SHA-256 checksum. No GitHub release is
published automatically. Change the root `package.json` version before building
bundles for a new version.

## Promote a build to a GitHub release

Once the **Bundle Release** workflow is on the default branch:

1. Open a successful **Bundle Create** run and copy its numeric run ID from the
   Actions URL (`.../actions/runs/123456789`). Existing builds can be promoted.
2. Open **Actions → Bundle Release → Run workflow**. Enter that run ID and a
   new tag matching the bundle version, for example `v0.1.0`, then run the workflow.

The action publishes full GitHub releases and marks them **Latest**. The tag must
match the version in both Gateway bundle manifests (taken from the root
`package.json` when built). For each new release, bump the root `package.json`
version (for example from `0.1.0` to `0.1.1`), build again, and publish `v0.1.1`.
The applications remain Early Access; release notes retain that label and the
signing information. Promoting a build preserves its embedded version and filenames.

The action verifies the macOS Gateway DMG and Windows Gateway setup EXE against their manifests
and source commit, creates the tag at the build's commit, and publishes only
those two Gateway installers and their JSON manifests on the repository's **Releases**
page. Gateway includes the embedded Desktop; standalone Desktop bundles remain
available as build artifacts. It promotes the existing files
without rebuilding. The built-in GitHub token supplies the required permissions;
no additional secret is needed. Existing tags and releases are refused.

Promote before the application artifacts expire (30 days after the build).
Expired or deleted artifacts require another **Bundle Create** run. Release
assets remain available independently of workflow artifact retention. If an
upload fails after draft creation, inspect and remove the incomplete draft and
its tag before retrying with the same tag, or use a new tag.

Gateway downloads use native installation formats: open the Apple Silicon macOS
`.dmg` and drag **Vibe Gateway** to **Applications**, or run the Windows x64
`-setup.exe`. Windows installs for the current user without administrator access,
adds a Start menu shortcut, and supports uninstalling from Windows Settings.
Close Gateway and its embedded Editor before reinstalling or upgrading.
Standalone Desktop downloads remain portable ZIPs; extract the entire ZIP before
launching and keep the Windows application's files together.
Start with **Vibe Gateway** to configure connections and workspaces. Gateway
contains its own complete Desktop application; users can also download Desktop
separately to connect to an existing Core.

Existing ZIP-only build runs cannot be promoted by the installer release action;
run **Bundle Create** again after this packaging change.

These are unsigned Early Access distributions (macOS uses ad-hoc signing).
Developer ID signing/notarization and Windows certificate signing are not
configured. Test the resulting downloads on clean macOS and Windows machines
before distributing them outside the Early Access group.

## Bundled runtime behavior

Every Gateway and Desktop download includes all three portable Core archives:

| Target | Core host |
| --- | --- |
| `linux-x64` | Linux x64, including x64 WSL2 distributions |
| `linux-arm64` | Linux ARM64, including ARM64 WSL2 distributions |
| `darwin-arm64` | Apple Silicon Mac |

Each Core archive contains compiled ACP, protocol and Core packages, locked
production dependencies (including native PTY support), and a matching Node
binary and npm. AI provider agents are installed from Settings → AI providers,
and the Java runtime and language server from Settings → Tools, on the Core host.
The archive is built and smoke-tested on its own target architecture. The smoke
check starts a native PTY and starts, authenticates to, stops and restarts Core
with its staged Node runtime. CI also launches both packaged applications and
Gateway’s embedded Editor (`--vibe-editor`) with `--bundle-smoke-test` to check renderer/preload
loading and bundled mode before archiving. Applications only accept Core artifacts from the
same source commit and validate their SHA-256 digests before packaging.

Packaged Gateway is identified by Electron's `app.isPackaged`, and requires a
valid bundled manifest. There is no environment switch that silently falls back
to Git provisioning. Repository/branch/auto-update controls are hidden and their
IPC handler is disabled. Saved repository preferences have no effect on bundled
provisioning.

On a Mac, local connections unpack the matching bundled Core into Gateway's
application-data cache and launch it with its own Node runtime. Gateway ships the
Editor's application files, not a second Electron runtime, and starts the Editor
by running its own executable with `--vibe-editor`, including for SSH connections.
The Editor keeps the standalone Vibe Editor's settings directory. It never
fetches Desktop code from the Core host in this mode.

For SSH hosts, Gateway detects the target OS/architecture, uploads the matching
archive over SFTP into a private temporary directory, verifies the checksum
again on the host, smoke-checks the extracted runtime, and atomically installs
it under `~/.vibe-deploy/releases/`. Release names include the source commit,
Node ABI, workflow build/attempt and target. Repeated builds and source builds
do not overwrite each other. Existing activation, authenticated health checks,
rollback and stop behavior are reused. Repair installs another immutable copy
of the shipped Core rather than rebuilding or fetching source.

Windows Gateway uses SSH connections to Linux/WSL hosts. Automatic startup in a
local WSL distribution is not implemented. Enable SSH in the intended WSL2
distribution and configure it as an SSH connection. Windows-native Core and
Intel macOS Core are not shipped. Desktop remains a client; its included Core
archives do not automatically start a server when Desktop opens.

Core hosts still need Git and the tools required by users' projects. SSH hosts
need Bash, tar and either `sha256sum` or `shasum`, and writable application-data
and workspace directories. No system Node/npm, source checkout, compiler or
application dependency installation is needed to deploy a bundled Core. Linux
builds target Ubuntu 22.04 or compatible glibc distributions; Alpine/musl is not
supported. AI account login and user-configured external tools remain host
configuration, and are not included in artifacts.

## Source edition

`npm run gateway`, development scripts and the open-source checkout retain the
existing repository settings, remote Git/install/build provisioning and
remote-built Desktop download behavior. Packaging does not change that flow.

## Local build commands

After `npm ci` and building the relevant workspaces:

- `npm run bundle:core` on each supported Core host architecture writes its
  archive and metadata to `artifacts/cores/`.
- Collect all three Core archives **and** JSON metadata from the same commit
  into `artifacts/cores/` on macOS ARM64 or Windows x64.
- `npm run build && npm run bundle:apps` creates both application downloads
  under `artifacts/downloads/` using the lockfile's Electron version. On Windows,
  install NSIS 3.11 first (`choco install nsis --version=3.11 --yes`); set
  `VIBE_MAKENSIS` to use a compiler outside its default Program Files location.
  macOS uses its built-in `hdiutil`. The Windows build silently installs Gateway
  into a temporary directory and smoke-tests Gateway and its embedded Editor
  before uninstalling; macOS verifies the resulting disk image. Chromium
  UI translations other than English are removed from both applications.

`artifacts/` is ignored by Git. Build workflows do not publish, commit generated
files or read local provider/MCP credentials, and have read-only permissions.
Only the manually triggered **Bundle Release** workflow has release write access.
