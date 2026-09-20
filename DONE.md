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
