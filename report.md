# Release-readiness implementation report

Completed 15 October 2026. Branch `stb`, pushed to `origin/dev`.
Implementation commits: `0577ee1`, `962cf25`, `8e00e58`, `090713b`,
`6f5bba5`, `244efbd`, and `36181e0`. This report and the updated readiness and
operations documents form the final documentation commit.

The reproduced state, deployment, authentication, transfer, and portability
failures were addressed. All four hosted verification jobs passed. This is
substantial release hardening, not certification for stable distribution; the
remaining gates are listed below. The original review in `rediness.md` remains
historical evidence rather than a description of the current test results.

## Changes delivered

### Durable state and crash recovery

- Task registry mutations now coordinate across processes, preserve integration
  history, and atomically publish unique temporary files. Owned locks reclaim
  confirmed dead local processes while preserving unknown ownership.
- Gateway state uses serialized read/modify/write transactions, synced private
  atomic writes, validated backup recovery, single-instance protection, and quit
  flushing. Workspace options preserve last-good backups and fail diagnostically
  when both copies are unusable rather than silently resetting user state.
- Timer and schedule stores validate entire documents and records, preserve
  corrupt evidence, and use private atomic writes and cross-process state locks.
  State-lock ownership is fully written before atomic hard-link publication;
  release unlinks it atomically. This closes the empty-owner crash window found
  during destructive testing. Unknown legacy locks and abandoned recovery
  markers still require inspection.
- Schedules claim fresh due/enabled state under lock and persist private launch
  ownership before external effects. A dead owner leaves a disabled schedule
  with an unknown-outcome diagnostic, avoiding automatic replay. Shutdown drains
  admitted launches. Corrupt state cannot create a tight automatic retry loop.
- Continuation timers beyond the native timeout limit now retain their durable
  record when an early clamped wake rearms them.

### Startup, security, and shutdown

- Core requires private session credentials, compares tokens safely, restricts
  Origins, and requires authentication for non-loopback operation. Protocol
  compatibility is now **16–16**. Desktop receives credentials through Electron
  main; Gateway transfers remote credentials over SSH.
- Both Electron applications restrict navigation, popups, and IPC senders to the
  configured main renderer document. Core installs handlers after asynchronous
  initialization before admitting clients, and cleans up failed listener binds.
- SIGTERM/SIGINT stop admission and initiate a bounded 30-second drain covering
  providers and owned processes, workflow journals, scheduled launches, pending
  state writes, terminals, applications, watchers, and clients. Forced or failed
  shutdown remains observable rather than being reported as clean success.
- High-risk destructive requests validate record shapes, flags, identifiers,
  provider content/configuration, and transfer fields before side effects.
  Unknown providers do not create tasks, and unknown tasks do not cancel timers.
- Workflow bridge directories are private (0700), with exclusive private file
  publications (0600). Skill path checks use canonical ancestors. Streaming HTTP
  responses have an enforced size limit and cancellation.

### Deployment and transfers

- Gateway stages lockfile-installed builds in immutable commit/Node-ABI release
  directories, smoke-checks native imports, and preserves previous releases on
  failure. Repairs receive distinct release keys.
- Activation requires authenticated protocol health before promotion. Failed
  candidates restore and health-check the previous selection. Workspace actions
  coalesce duplicates, reject conflicts, and check process ownership before
  stopping a Core. Token validation now works on native macOS Bash, including
  the supported 32- and 256-character boundaries.
- Uploads pause during asynchronous setup, handle stream errors through closure,
  enforce exact sizes, publish atomically, and await partial-file cleanup during
  cancellation and shutdown. Late frames are ignored safely; stale tickets are
  pruned. Downloads retain correct FileHandle ownership.

### Dependencies and platform reliability

- Updated Electron, Vitest, happy-dom, and compatible transitive dependencies;
  the host Node requirement is **22.12+**. Dependency auditing reports zero
  vulnerabilities. Codex runtime updates are opt-in; the default uses the
  lockfile-installed runtime rather than an unpinned cache.
- Java debugger attachment waits for the initial suspended thread prompt before
  setting breakpoints and continuing, with bounded cancellation on stop/close.
- Corrected macOS canonical-path assumptions, bounded filesystem cleanup, large
  fixture setup, ACP turn-completion synchronization, MCP watcher lifecycle,
  concurrency barriers, and the crash-test process keepalive. These fixtures now
  synchronize on observable completion rather than short sleeps.
- Added a reproducible isolated restart probe, a four-job CI matrix with pinned
  actions, and bounded failure annotations usable when full hosted logs are
  unavailable.

## Validation completed

**Final implementation:** [`36181e0`, hosted run 38700222350](https://github.com/ftpud/VibeEditor/actions/runs/38700222350)
finished successfully on all four combinations:

| Platform | Node | Result |
| --- | --- | --- |
| Ubuntu | 22 | Passed |
| Ubuntu | 24 | Passed |
| macOS | 22 | Passed |
| macOS | 24 | Passed |

Each job performs a clean install, dependency audit, production build, root and
Gateway typechecks, full workspace tests, and twelve crash/restart cycles.
Local Node 22 and 24 checks also passed. Linux suite counts are Core 634,
Desktop renderer 443, Desktop Electron 16, Gateway renderer 11, and Gateway
Node 49: **1,153 tests**. macOS retains platform-specific skips; Linux counts
are not a claim that skipped tests executed there. Audit results were zero
vulnerabilities including development dependencies. Final documentation changes
do not alter the tested implementation.

### Longer restart probe and retained failures

The Desktop-matching **30-second request-deadline** profile passed **1,147
cycles** from 01:58:51 to 02:28:52 UTC on Linux x64 / Node 24.20.0, alternating
SIGTERM, SIGINT, and SIGKILL while options writes were pending. Acknowledged
state survived subsequent restarts. Maximum observed save acknowledgement was
8,799 ms. Peak sampled Core RSS was 150,500 KiB across fresh processes; this
is not a long-lived memory-leak measurement.

Frozen runtime SHA-256:
`cb73f0e9a40ab23ee6487e11dfd14d0df3120ed4a1f2d9f64c22d26e4dc51b17`.
This artifact predates the later schedule corruption-rearm guard and final
portability/fixture changes. Those received subsequent tests and short restart
probes; the 30-minute result must not be attributed to an identical final build.

Earlier failed probes remain part of the evidence:

| Profile | Completed cycles before failure | Finding |
| --- | --- | --- |
| Strict 10-second, original candidate | 740 | Save request timed out; root cause unproven |
| Directory state-lock candidate | 18 | SIGKILL left an empty owner directory; fixed by atomic complete-owner publication |
| Strict 10-second, atomic-owner candidate | 328 | Save request timed out with a complete lock owned by the active Core |

Raw reports remain in `/tmp/vibe-soak-30min.json`,
`/tmp/vibe-soak-durable-30min.json`, `/tmp/vibe-soak-atomic-30min.json`, and
`/tmp/vibe-soak-desktop-30min.json` on the task host, with failed private fixtures
retained for inspection. These temporary paths are not repository artifacts.
Host I/O pressure and slow fsync/rename operations were observed, but do not
prove the cause of every timeout. The strict latency failures are unresolved;
using Desktop's deadline does not erase them. Earlier local timing failures and
hosted failures were retained and investigated before the final green matrix.

## Remaining gates before stable distribution

- Produce signed/notarized, versioned release artifacts and validate installed
  GUI behavior, real SSH upgrades, rollback, and representative user workflows.
- Extend payload schemas and review consistency/live-cache behavior of Core
  stores beyond the covered transactions. Full-snapshot writes remain
  last-writer-wins, not a merge protocol.
- Measure sustained external-provider workflows, log growth, UI responsiveness,
  and long-lived memory under realistic load. Restart RSS samples and synthetic
  polling do not establish those guarantees.
- Investigate strict 10-second persistence stalls and test broader filesystem,
  host-failure, and recovery scenarios. Process-kill testing does not simulate
  hardware power loss.
- Preserve manual recovery for uncertain external effects and unknown/foreign
  locks, abandoned recovery markers, or ambiguous process ownership. These
  mechanisms do not provide exactly-once provider effects.

Operational recovery procedures are in [Release operations](docs/RELEASE_OPERATIONS.md).
The user's `todo.md` note is preserved separately and excluded from commits.
