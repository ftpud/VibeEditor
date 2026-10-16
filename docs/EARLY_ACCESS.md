# Early Access bundles

Run **Actions → Bundle Create → Run workflow** on the commit or branch you want
packaged. The workflow uploads two artifact sets, `vibe-early-access-macos-15`
and `vibe-early-access-windows-2025`. Download and extract the artifact wrapper;
each contains separate Gateway and Desktop ZIP downloads and JSON manifests
with their version, source commit and SHA-256 checksum. No GitHub release is
published automatically. Change the root `package.json` version before a release.

The applications are portable: macOS ZIPs contain an Apple Silicon `.app`;
Windows ZIPs contain the x64 application and its supporting files. Extract the
entire ZIP before launching. Keep the Windows application's files together.
Start with **Vibe Gateway** to configure connections and workspaces. Gateway
contains its own complete Desktop application; users can also download Desktop
separately to connect to an existing Core.

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
production dependencies (including provider adapters/CLIs and native PTY
support), a matching Node binary and npm, JDT LS and a platform-specific JRE.
The archive is built and smoke-tested on its own target architecture. The smoke
check starts a native PTY and starts, authenticates to, stops and restarts Core
with its staged Node runtime. CI also launches both packaged applications and
Gateway’s nested Desktop with `--bundle-smoke-test` to check renderer/preload
loading and bundled mode before archiving. Applications only accept Core artifacts from the
same source commit and validate their SHA-256 digests before packaging.

Packaged Gateway is identified by Electron's `app.isPackaged`, and requires a
valid bundled manifest. There is no environment switch that silently falls back
to Git provisioning. Repository/branch/auto-update controls are hidden and their
IPC handler is disabled. Saved repository preferences have no effect on bundled
provisioning. Provider auto-update is disabled for bundled Core; the adapters
and CLIs installed from the release lockfile are used.

On a Mac, local connections unpack the matching bundled Core into Gateway's
application-data cache and launch it with its own Node runtime. Gateway launches
the included Desktop executable, including for SSH connections. It never
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
  archive and metadata to `artifacts/cores/`. Java resources must already be
  installed with `npm run install:jdtls`; missing resources fail the bundle.
- Collect all three Core archives **and** JSON metadata from the same commit
  into `artifacts/cores/` on macOS ARM64 or Windows x64.
- `npm run build && npm run bundle:apps` creates both application downloads
  under `artifacts/downloads/` using the lockfile's Electron version.

`artifacts/` is ignored by Git. CI does not publish, commit generated files or
read local provider/MCP credentials. Workflow permissions are read-only.
