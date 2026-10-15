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

## Isolated restart soak

Build the application first, then run the restart check against a private fixture:

```sh
npm run build
npm run test:release-soak -- --cycles 20 --output /tmp/vibe-soak.json
npm run test:release-soak -- --minutes 30 --pause-ms 1000 --output /tmp/vibe-soak-30min.json
```

The check snapshots built Core, ACP, and Protocol code and uses a separate Git
workspace, state directory, and session token. It alternates SIGTERM, SIGINT,
and SIGKILL while options writes are pending, then verifies that acknowledged
state survives each restart. Third-party dependencies are linked from the
installed repository; leave dependency installations unchanged during a run.

The JSON report records the artifact hash, protocol range, Node/platform,
completed cycles, request latency, and sampled Core RSS. Each cycle starts a
fresh Core process,
so these memory samples do not measure leaks in a long-lived Core or workflow.
The check does not exercise external AI providers, signing, GUI interaction, or
host power loss. Successful runs remove their temporary fixture. Failed runs
retain a private diagnostic directory and identify its location in the report.
On Linux, failures also capture the test Core process status, I/O counters, and
wait channel before cleanup. The default request deadline is thirty seconds, matching Desktop. Use
`--request-timeout-ms 10000` for the stricter latency probe. The report records
the selected deadline, and a timeout fails that run even when previous cycles
preserved their acknowledged writes. CI
runs twelve cycles on each configured Linux/macOS and Node 22/24 combination.

## Timer and schedule state recovery

Continuation timers, user schedules, and workspace options now coordinate their
writes across Core processes with owned state-file locks. Their read/modify/write
transactions preserve a validated last-good `.bak` and promote private synced
files atomically. A malformed timer collection or record fails as a whole;
invalid entries are not silently dropped. If the primary is missing or corrupt,
a valid backup is used with a diagnostic. When both copies are unusable, the
operation fails and preserves the original files for inspection.

State locks use a private `<state-file>.lock` file with PID, host, and random
ownership identity. A fully written candidate is published with an atomic hard
link, and release unlinks it atomically; a killed writer cannot leave a partially
created owner record. Confirmed dead local owners can be reclaimed under an
exclusive `<state-file>.lock.recovery` marker. Live, foreign, or unknown owners,
legacy directory locks, and abandoned recovery markers are preserved, with a
bounded wait and diagnostic. Use the same inspection procedure described above
before manually removing an unknown lock or recovery marker. Orphaned candidate
`.tmp` files do not own the lock and do not block later writers.

Schedule launches persist an ownership record before contacting a provider or
starting a workflow. If that local owner dies before the outcome is recorded,
recovery disables the schedule and explains that its outcome is unknown. Inspect
existing tasks, sessions, and workflows before choosing Run now or re-enabling
it. Recovery does not repeat uncertain external effects automatically. Foreign
owners require inspection on their recorded host. Graceful shutdown waits for
admitted launches and their state writes; forced kills can leave an outcome
requiring this manual decision.

These locks protect the covered state transactions; they do not establish
exactly-once external provider effects, live cache synchronization across Core
instances, or a complete consistency guarantee for every Core store.

Local workflow event, command, and response directories are restricted to the
Core user (0700); new publications use exclusive private files (0600), including
temporary files. Core and its MCP processes must run as that same user.
