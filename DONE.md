# Workflow pause routing

Implemented and committed as `91addd6 Route workflow pauses to desktop`.

Changes include:

- Persisted workflow pause states safely.
- Desktop controls for permission approval/rejection and provider questions.
- Exact run/block/session ownership validation to reject stale responses.
- Restart recovery for paused runs.
- Protocol compatibility bumped to version 6.
- Updated `TODO.md`.

Validation passed:

- Full test suite: 504 tests.
- Full build.
- Full typecheck.
- Clean worktree; branch is one commit ahead of `origin/dev`.

# Typed workflow failure recovery

Implemented and committed typed workflow failure recovery.

- Added normalized provider/runtime failure types.
- Added jittered exponential backoff and elapsed retry budgets.
- Persisted retry timing and attempt state.
- Added actionable retry exhaustion handling and tests.
- Bumped protocol compatibility to version 8.
- Marked the TODO item complete.

Validation passed: full build, typecheck, and all package tests.

Commit: `cc9e1a9 Add typed workflow failure recovery`

The pre-existing `DONE.md` modification remains uncommitted and untouched.

# Unified workflow scheduler

Implemented and committed the unified workflow scheduler.

Key changes:

- Shared concurrency limit across graph blocks, stack launches, retries, appended input, and timers.
- Serialized writes to persistent sessions.
- Added reentrant scheduling for loops and paused provider controls.
- Ignored stale turn completions using claim IDs.
- Tracked asynchronous appended input through run termination.
- Added concurrency and hot-input regression tests.
- Updated `TODO.md`.

Validation passed: Core build, typecheck, and all 267 Core tests.

Commit: `64046ef Unify workflow turn scheduling`

Worktree is clean.

# Crash-recovery acceptance coverage

Implemented and committed the next outstanding TODO item: crash-recovery acceptance coverage.

Changes include:

- Safe replay when reconciliation proves an operation never started.
- Exactly-once recovery tests for task creation, prompt delivery, timer firing, and merge.
- Durable timers remain persisted until their journal outcome commits.
- Timer restart reconciliation prevents duplicate continuation delivery.
- Existing block-snapshot recovery coverage completes the fault matrix.
- Marked the acceptance item complete in `TODO.md`.

Validation passed:

- Core build and typecheck.
- All 272 Core tests.
- Focused 44 recovery and timer tests after the final adjustment.

Commit: `ca269e5 Test workflow crash recovery`

`DONE.md` remains modified and uncommitted as requested workspace-owned content.

# Workflow continuation

`TODO.md` still contains unfinished work. The next assigned downstream workflow task is to complete the remaining P0 acceptance coverage: run parallel fan-out with hot input at the configured concurrency limit, proving there is no duplicate dispatch or concurrent write to a persistent session. Existing tests cover fan-out concurrency and hot-input session serialization separately; the downstream coder must add their combined scenario and explicitly assert duplicate-dispatch prevention before checking this item off.

# Combined scheduler acceptance coverage

Completed and committed as `b7cf599 Test workflow fan-out hot input scheduling`.

- The combined test verifies the configured concurrency limit, exactly one initial dispatch per block, exactly one hot-input delivery, and serialized writes to the persistent root session.
- `TODO.md` marks the acceptance item complete.
- Core build, typecheck, and all 276 Core tests passed.

The next unfinished P0 acceptance task is state-file corruption recovery: corrupt or truncate stored state while proving valid definitions and runs remain recoverable with a visible diagnostic.
