# Release operations

This guide describes the implemented Core and Gateway deployment behavior. The
project is still in release hardening: passing focused tests or CI jobs does not
certify a stable release. Review [release readiness](../rediness.md) before
promoting a build.

## Runtime and protocol compatibility

Core and Gateway hosts require Node.js **22.12 or newer**. Gateway checks the
remote SSH user's Node version before provisioning. CI is configured for Node
22 and 24 on Linux and macOS; use `npm ci`, build, both typechecks, dependency
audit, and the full tests when validating a candidate.

The current Core wire compatibility range is **protocol 16–16**. A client is
accepted only when its declared range overlaps Core's range. A protocol 15-only
Desktop therefore cannot connect. Gateway reads the remote compatibility
metadata and uses a compatible cached Desktop when possible; otherwise it
downloads and verifies the Desktop artifacts from the selected release. If a
verified compatible cached Desktop is available, Gateway can offer it as a
rollback choice when the current client is incompatible.

## Core session credentials and origins

Core starts with a session token. Set `REMOTE_IDE_SESSION_TOKEN` to provide one
directly, or set `REMOTE_IDE_SESSION_TOKEN_FILE` to choose the token file. If
neither is set, Core stores a token at
`~/.remote-ide/core-tokens/<port>.token`. It creates the containing directory
with mode `0700`, publishes a complete token file exclusively, and checks that
the file is regular, private, and owned by the current user. Tokens must contain
32–256 URL-safe characters. Keep token files private; never paste tokens into
logs, tickets, or source control.

Gateway uses a per-workspace token file in its local application data directory
for a locally launched Core. For a remote workspace, the remote token is kept
in `~/.vibe-server-<workspace-id>.token` on the SSH host. The activation script
creates it under a restrictive umask, rejects a symlink, and validates its
format. Gateway reads that file over the authenticated SSH connection and
passes the token to the local Desktop process for its authenticated Core
connection. When Desktop receives a complete launch host and port, it refuses
to reuse an explicit credential for another target. Protect both the Gateway
application data and the SSH account.

Core defaults to a loopback listener and refuses a non-loopback listener unless
authentication is configured. The entry point always loads a token before it
starts the listener. Native clients that omit the HTTP `Origin` header are
allowed through the origin check but still need the token at the protocol
handshake. Opaque Electron origins (`null` or `file://`) are accepted only when
a token is configured. Browser origins must be explicitly listed in
`REMOTE_IDE_ALLOWED_ORIGINS` as comma-separated, exact origins, for example:

```sh
REMOTE_IDE_ALLOWED_ORIGINS='https://editor.example.test,http://localhost:5173'
```

Do not add broad or untrusted origins. Restart Core after changing the
environment.

## Remote release provisioning and activation

Gateway keeps remote source caches and installed builds below
`~/.vibe-deploy/`. Installed builds live in `~/.vibe-deploy/releases/` and are
keyed by Git commit and Node module ABI, with the target platform and
architecture recorded in the build marker. Provisioning stages a fresh
directory, runs `npm ci`, builds the required workspaces, performs import and
artifact smoke checks, and only then renames the staged directory into its
final release path. Existing release directories are immutable: a failed or
partial build does not overwrite the selected or previously installed build.

With repository auto-update enabled, provisioning fetches the configured
branch and selects its resolved commit. With auto-update disabled, it reuses
the commit recorded in the source cache; the first provision still needs to
fetch. Gateway reports the verified commit and release key after provisioning.

Starting a remote server stops the old per-workspace server, starts Core from
the candidate release on loopback, then performs an authenticated protocol
handshake health check. Gateway updates
`~/.vibe-server-<workspace-id>.release` only after the candidate passes. The
previous selection is saved as a `.previous` sidecar. If candidate health
verification fails, the activation script stops it and restores the previous
release selection, then attempts to start and health-check the previous
release. If rollback health also fails, inspect the remote log before trying
again. The legacy `~/.vibe` installation is considered as a fallback only when
there is no prior selection.

### Repairing a release

Use Gateway's **Repair server** action when provisioning reports that an
existing immutable release failed validation, or when a native dependency such
as `node-pty` needs rebuilding. Repair creates a new release directory with a
unique repair suffix; it does not modify the failed release in place. It uses
the configured repository and branch settings and repeats install, build, and
smoke checks. If repair fails, the previous release directories and selection
remain available. Resolve the reported host toolchain or install error before
retrying. For `node-pty` build errors, the SSH host needs a C/C++ compiler,
`make`, and Python 3.

Useful remote diagnostics are:

- `~/.vibe-server-<workspace-id>.log` — current server startup/runtime output.
- `~/.vibe-server-<workspace-id>.log.previous` — log copied before activation.
- `~/.vibe-server-<workspace-id>.pid` — selected server process ID.
- `~/.vibe-server-<workspace-id>.release` and `.previous` — current and prior
  release selections.
- `~/.vibe-deploy/releases/` — immutable normal and repair builds.
- `~/.vibe-deploy/sources/` — repository and branch keyed source caches.

Treat logs and state as operational data. Review them before removing anything;
do not delete a release directory that is currently selected by a workspace.

## Lock diagnosis and recovery

Provisioning serializes remote builds with
`~/.vibe-deploy/provision.lock`. Its owner record contains a PID, host name, and
random identity. A waiting provisioner can reclaim the lock only when the owner
is on the same host and the process is confirmed dead, with a second ownership
check to avoid removing a lock that changed during recovery. Otherwise it waits
up to five minutes and reports the PID/host. If the owner is missing or
unrecognized, the timeout says the owner is unknown and asks for inspection.

Activation uses a separate
`~/.vibe-deploy/activate-<workspace-id>.lock`. A live PID is reported
immediately; a dead local PID can be reclaimed after checking the recorded PID
again. An empty or malformed owner is reported as unknown and is not removed
automatically.

For either lock, inspect its owner record, verify the corresponding process on
the named host, and check the Gateway operation state before taking action. An
unknown owner can be a provisioning process that has not finished writing its
owner record. Wait and inspect again. Remove a stale lock only after confirming
that no matching provision or activation is running and that no host is still
using it; preserve the owner contents for diagnosis when uncertain. Do not
remove a live lock to unblock another launch, since that permits concurrent
writers or server activations.

## Signals, durable timers, and workflow recovery

On `SIGTERM` or `SIGINT`, Core stops accepting new work, closes schedules and
timer delivery, suspends active workflow runners, and sends WebSocket close code
1001 to connected clients. It waits for admitted WebSocket requests and MCP bridge commands, provider shutdown,
service cleanup, workflow drains, and queued workspace-state writes. Remaining
WebSockets are forcibly terminated after 500 ms. The process allows up to **30
seconds** for graceful shutdown; success exits with code 0, while a rejected or
timed-out shutdown is logged and exits with code 1. Further termination signals
do not start a second shutdown attempt.

Scheduled continuation timers are persisted separately from their in-memory
timeouts. Graceful shutdown clears the in-memory timeout handles without
deleting pending timer records. On the next Core startup, persisted timers are
loaded and armed again; overdue timers become eligible for delivery. Workflow
runs and operation journals are also persisted. Startup recovery examines
interrupted runs and resumes eligible work using the existing workflow and
provider sessions, subject to its recovery policy and available workspace,
provider, and task state. Inspect workflow history and timer state after a
restart to confirm the result. This recovery is not an exactly-once guarantee
for external side effects, and a forced process kill or host crash may interrupt
an operation before its result is journaled.

Core shutdown also closes managed terminals and workflow apps. Active binary
file transfers are interrupted; incomplete uploads are removed after closing
their file streams. Uploads become visible through atomic publication only
after their approved byte count is received. Restart an interrupted transfer
from Desktop; transfer resumption is not implemented. Do not assume
terminal or app processes survive a graceful Core shutdown. Restart Core before
expecting scheduled or recovered work to continue.

## Verification and remaining release gates

Automated coverage currently exercises Core token/origin checks, signal-handler
success, failure and timeout behavior, workspace writes draining during
shutdown, SIGTERM/SIGINT child-process shutdown, and persistence after those
signals. Gateway tests exercise release identity validation, generated Bash
syntax, provisioning into immutable release directories, reuse and repair,
failure preservation, authenticated protocol health checks, successful
activation, rollback after failed health checks, and lock contention/unknown
owner diagnostics. The CI workflow is configured to run clean installs, builds,
typechecks, audit, and workspace tests on Linux and macOS with Node 22 and 24.

Treat those tests as automated regression coverage, not release certification.
The configured macOS jobs still need to pass on the hosted platform. Signed and
platform-appropriate packaged artifacts, signing/notarization checks, and
extended crash/restart and workflow/timer soak tests remain release gates. The
project has not certified a stable release; see the readiness document for the
current status and broader outstanding work.
