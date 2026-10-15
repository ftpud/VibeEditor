# Stable release readiness

Original review: 14 October 2026, at commit `ecce9e2`.
Implementation progress is tracked below; the original findings and check counts
are retained as historical evidence.

**Verdict: suitable for continued experimental use; not ready for a stable release.**
The architecture and test coverage provide a substantial foundation. The main
blockers are durable-state races, unreliable recovery after crashes, failing
Core tests, mutable deployment, and unresolved dependency/security findings.
This assessment is based on source tracing and local checks, not a completed
Linux/macOS release certification or a security penetration test.

## Hardening progress — 14 October 2026

The first implementation batch addresses the reproduced task-registry race,
crashed-owner repository locks, atomic Gateway state transactions, workspace
options recovery, streaming HTTP limits, and dependency advisories. Task
registry operations now share a cross-process repository lock; every mutation
preserves integration history and uses unique atomic temporary files. Locks
record PID, host, and identity, reclaim confirmed dead local owners, and fail
with a diagnostic after 30 seconds for live or unknown ownership. Unknown legacy
locks and locks abandoned during reclamation require inspection rather than
unsafe automatic deletion.

Gateway uses one serialized state store for reads, mutations, and recovery, with
atomic promotion, synced private temporary files, and last-good backups. A
single-instance guard prevents separate Gateway writers for the same user data.
Core workspace options preserve a last-good backup, report unrecoverable
corruption instead of silently resetting state, and serialize saves across
store instances within one process. Cross-process coordination of Core stores
other than task registries remains a release gate.

Startup uses lockfile-installed Codex runtimes by default. Latest-runtime
updates now require `REMOTE_IDE_CODEX_AUTO_UPDATE=1`; disabling updates also
ignores previously cached, unpinned runtimes. HTTP responses are bounded during
streaming and oversized streams are cancelled. Skill scope checks resolve
missing paths through canonical ancestors, and platform fixtures no longer
assume Linux path aliases or case-sensitive rename semantics.

The dependency migration uses Electron 44, Vitest 4, and happy-dom 20; the host
Node requirement is now **22.12+**. A fresh audit after compatible transitive
updates reports **zero vulnerabilities**. Linux/macOS CI covers Node 22 and 24,
clean installs, production builds, both typechecks, dependency auditing, and
all workspace tests. These jobs have been configured, not certified on macOS
from this Linux environment. The verification table below records the original
assessment; it is not the result of these later fixes.

## Hardening progress — 15 October 2026

Gateway provisioning now stages lockfile-installed builds in immutable
commit/Node-ABI release directories, smoke-checks native and application
imports, and preserves installed releases on failed builds. Repair creates a
separate release. Per-workspace activation checks the authenticated Core
protocol before promoting its selection; failed candidates restore and
health-check the prior release. Duplicate workspace actions are coalesced and
conflicting actions rejected. PID checks avoid stopping unrelated processes.

Core's production entry point now loads an exclusive, private session token.
Protocol 16 carries handshake authentication; exact Origin checks reject
untrusted web pages before workspace session initialization. Desktop obtains
its credential from the Electron main process, with Gateway transferring remote
credentials through SSH and the child environment. Both Electron apps restrict
navigation, popups, and IPC senders to their configured main renderer document.
Core binds its listener after asynchronous initialization so early clients do
not lose their handshake before the connection handler is installed.

SIGTERM/SIGINT initiate a bounded 30-second drain: stop new requests and timer
delivery, suspend workflow journals for restart reconciliation, stop owned
provider processes, close terminals/apps/watchers, and await admitted requests
and state writes. Pending timer records survive graceful shutdown. Ambiguous
provider outcomes pause for explicit recovery rather than replaying prompts.
Regression coverage includes signal subprocesses, gated writes, orphaned
workflow recovery, authentication, release rollback, and concurrent actions.
See [release operations](docs/RELEASE_OPERATIONS.md) for credentials, layouts,
repair, lock diagnosis, and shutdown semantics.

Targeted runtime payload validation now rejects malformed destructive transfer
and task flags, unsafe task IDs, and malformed ACP prompt/configuration records
before dispatch. Attachment-only prompts remain supported. Unknown providers
are resolved before task worktrees are created, and unknown tasks cannot cancel
another workspace's timers. Rejection responses retain their request IDs.

Binary uploads pause input during asynchronous setup, handle file-stream errors,
ignore late frames after finalization, and drain partial-file cleanup during
Core shutdown. Download streams now retain correct FileHandle ownership.
Expired unused tickets no longer block workspace operations indefinitely.

Continuation timers and user schedules now validate complete stored documents,
recover only from valid last-good backups, and use private synced atomic writes.
Timer, schedule, and workspace-options transactions share conservative owned
state-file locks across processes. Regression tests exercise independent writers
and recovery from SIGKILL. Schedule firing rechecks fresh due/enabled state while
claiming under that lock, and persists launch ownership before external effects.
A dead local launch owner produces a paused schedule with an unknown-outcome
message; automatic recovery does not repeat the action. Graceful shutdown drains
scheduled background launches and their final writes.

A repeatable isolated restart soak now snapshots built Core/ACP/Protocol code,
uses a separate Git workspace and credentials, interrupts pending options writes
with SIGTERM/SIGINT/SIGKILL, and verifies acknowledged state on restart. Its RSS
samples describe separate short-lived Core processes, not long-running workflow
memory stability. Current run results are recorded in the final implementation
report when the run completes.

Crash testing exposed an empty-owner window in directory-based state locks.
State-file locks now publish a complete private ownership record with an atomic
hard link and release it with an atomic unlink. Unknown legacy locks and
abandoned recovery markers still require conservative manual inspection.
Continuation timers beyond the native timeout limit retain their durable record
when an early clamped timeout re-arms them.

Core's local workflow bridge now restricts command/response/event directories to
0700 and new files to 0600, including temporary publications. Java debugger
startup waits for its suspended thread prompt before installing breakpoints and
continuing; this addresses a startup race seen on the hosted macOS runner.

The hosted matrix for `962cf25` passed on Linux with Node 22 and 24 but failed on
macOS. Its annotations identified a canonical-path assertion and ACP/MCP fixture
completion races as well as the debugger race. Those failures are being fixed
and revalidated; the final report records the resulting hosted status. Strict
ten-second restart probes have also failed on slow state saves under variable
host I/O pressure. The soak now reports its selected request deadline, with a
thirty-second default matching Desktop and an explicit ten-second probe option.
These profiles and their failures must remain distinct in release evidence.

The application is still not certified for stable distribution. Hosted macOS
checks, the remaining cross-process Core-store review, runtime payload
validation, signed artifacts, extended crash/restart tests, and overnight
workflow measurement remain release gates.

## Original review verification (before hardening)

| Check | Result |
| --- | --- |
| Full production build | Passed |
| Root typecheck and separate Gateway typecheck | Passed |
| Core tests, outside sandbox restrictions | 498 passed, 30 failed, 8 skipped; two unhandled errors |
| Desktop renderer tests | 430 passed, one skipped |
| Desktop Electron tests | Six passed |
| Gateway tests | 11 renderer tests and 33 Electron tests passed |
| npm audit | 17 findings: three critical, seven high, seven moderate |

The first test run encountered sandbox socket/process restrictions. The counts
above come from the unrestricted rerun; its failures cannot be dismissed as
sandbox failures. The audit includes development dependencies: the critical
findings include Vitest, tinypool, and happy-dom. Electron appears among the
high-severity findings. These are advisory matches, not demonstrated exploits.

## Original findings to resolve before a stable release

### 1. Prevent task registry races and recover stale repository locks

**Priority: release blocker.** `WorkspaceTaskStore.save()` uses the same
`tasks.json.<pid>.tmp` filename for concurrent writes. Methods such as `rename()`
read, modify, and save without the repository mutation queue. An isolated
reproduction forced two concurrent rename calls to start from the same registry:
one rejected with `ENOENT`, and the persisted names did not match the successful
call's requested update.

Use unique temporary files and serialize the entire read/modify/write operation,
including calls from multiple clients and Core processes. Test overlapping
create, rename, selection, archive, and metadata operations.

`acquireRepositoryLock()` waits indefinitely while its lock directory exists;
the lock has no ownership record or stale-owner recovery. A killed Core can
leave later Git mutations waiting forever. Add ownership and safe stale-lock
recovery, with a useful diagnostic for a live conflicting owner.

Sources: `packages/core/src/tasks.ts:127`, `tasks.ts:463`,
`packages/core/src/root-mutation.ts:33`.

### 2. Make the supported-platform test suite green

**Priority: release blocker.** Core failures include skills scope checks,
workflow/task binding, root selection, reconnect/terminal tests, and path alias
comparisons. Several reveal `/var/...` versus `/private/var/...` assumptions on
macOS. The case-only rename assertion assumes a case-sensitive filesystem.
Another fixture assumes `/root` exists. Some failures may be fixture defects;
others need runtime investigation. Classify and fix them rather than skipping
the affected features.

Define the first supported release matrix, then run clean-install builds and
tests on those platforms in CI. No `.github` CI workflow was present in this
checkout. Optional Java tests also need a CI environment with the required JDK
and tooling if Java is included in the supported release scope.

Sources: `packages/core/src/skills.ts:45`,
`packages/core/src/workflow-binding*.test.ts`, `workspace-roots.test.ts`,
`websocket-concurrency.test.ts`, `websocket-output.integration.test.ts`.

### 3. Replace mutable deployment with reproducible, reversible releases

**Priority: release blocker.** Gateway provisions every workspace into the same
remote `~/.vibe` checkout. It force-updates a branch, installs dependencies, and
removes build directories in place. Concurrent workspace launches can modify
that shared installation. A failed update can also leave the previous usable
installation damaged. Core additionally checks and installs latest Codex/ACP
versions at startup by default, so a tested application commit does not fully
pin its provider runtime.

Build immutable installations keyed by release/commit, use lockfile installs,
serialize provisioning per host, verify health before promotion, and retain a
working rollback target. Pin provider runtimes in the stable channel; offer
updates separately. Produce versioned Desktop/Gateway artifacts with the
signing/notarization required by the supported platforms. The project currently
ships from source and has no package/distribution release scripts.

Sources: `packages/gateway/src/electron/repository-settings.ts:33`,
`packages/gateway/src/electron/main.ts:212`,
`packages/core/src/ai/providers/codex-runtime.ts:49`, root `package.json`.

### 4. Resolve advisories and define the Core trust boundary

**Priority: release blocker for supported distribution/security scope.** Upgrade
affected dependencies through controlled compatibility testing. Do not treat
`npm audit fix --force` as release validation: several suggested fixes require
major upgrades, and a proposed version still needs a fresh audit.

Core binds to loopback by default and Gateway uses SSH, which limits exposure.
However, the WebSocket handshake only checks protocol compatibility; it does
not authenticate a client. The server has no explicit Origin check. Any client
able to reach the listener can attempt the privileged filesystem, terminal,
and Git operations after that handshake. This is a reachability/trust issue;
browser exploitation was not tested.

Define whether other local processes/users and browser origins are trusted.
Add session authentication and Origin checks where they are outside that trust
boundary, and refuse unauthenticated non-loopback deployment. Electron already
uses context isolation and disables Node integration in the renderer; audit
navigation/window creation and IPC sender checks before distribution.

Sources: `packages/core/src/server.ts:187`, `server.ts:544`,
`packages/desktop/src/electron/main.ts:60`,
`packages/gateway/src/electron/main.ts:511`.

### 5. Harden durable state and shutdown

**Priority: release blocker for data preservation.** Gateway writes its
connection/workspace configuration directly, without atomic promotion or a
serialized state mutation. Concurrent read/modify/write handlers can lose
updates; an interrupted write can corrupt the file. Other stores have varying
levels of validation and recovery. Workflow state has backups/quarantine, but
workspace options log load errors and fall back to empty options.

Use atomic, serialized writes consistently, preserve last-good state, expose
corruption to the user, and test schema upgrades and restoration. Decide how
multiple Core processes coordinate shared workspace state. Add explicit
SIGTERM/SIGINT shutdown behavior: Core's entry point currently does not install
signal handlers to drain state writes and close services. Document which
terminals, apps, timers, and workflows survive or stop on each shutdown mode.

Sources: `packages/gateway/src/electron/main.ts:53`,
`packages/core/src/workspace-state.ts:19`, `packages/core/src/index.ts`,
`packages/core/src/harnesses.ts`.

## Next stability work

- **Validate protocol payloads at runtime.** `parseRequest()` validates the
  envelope and casts the payload to the TypeScript request union. Add
  operation-specific schemas and malformed-input tests before service dispatch.
- **Bound memory while streaming.** The HTTP service reads the entire response
  before checking its 2 MB limit. Reject oversized streams while receiving them.
  Keep unlimited tree/concurrency behavior available, but use chunking,
  cancellation, backpressure, and optional operational budgets so large workspaces
  and bursts do not exhaust Core or exceed the outbound frame budget.
- **Measure long-running workflows.** Context duplication was reduced, and
  history summaries/live-run refreshes exist. Durable run journals still grow
  with actual actions, and explicit log tails can repeat content. Run extended
  workflow/app-log tests with realistic output and measure memory, disk writes,
  UI latency, reconnect behavior, and cancellation.
- **Add release observability.** Include running commit/protocol/provider runtime
  versions in diagnostics, structured errors with request/run IDs, and tested
  log rotation/redaction. Define a supportable recovery path for failed upgrades.
- **Reduce change risk.** Split the large server router, workflow runner, and
  renderer App into service boundaries with integration coverage. This is lower
  priority than the correctness and release blockers above.

Sources: `packages/core/src/server.ts:703`, `packages/core/src/http.ts:15`,
`packages/core/src/filesystem.ts`, `packages/core/src/request-admission.ts`,
`docs/WORKFLOW-CONTEXT.md`.

## Suggested release gate

1. Fix registry races, stale locks, and platform/path failures.
2. Establish required CI checks on the supported platform matrix.
3. Resolve or explicitly assess advisories and complete the trust-boundary review.
4. Implement immutable deployment, pinned runtimes, and tested rollback.
5. Pass crash/restart, corruption recovery, concurrent-client, large-workspace,
   and overnight workflow tests without data loss or unrecoverable hangs.
6. Distribute a versioned release candidate; fix regressions found in real use
   before marking the same tested artifact stable.

Build and typecheck success are useful gates. Resolving the original failures
and state race requires the broader release certification above before a
stable-release recommendation.

consider todo.md