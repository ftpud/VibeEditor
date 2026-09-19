# Workflow state corruption recovery

Implemented and committed as `ee62516 Harden workflow state corruption recovery`.

- Quarantines malformed workflow definitions and runs.
- Recovers from corrupt or unsupported current state using atomic backups.
- Preserves valid records when neighboring records are malformed.
- Added three recovery tests and updated `TODO.md`.
- Worktree is clean.

Validation:

- Store tests: 8 passed.
- Repository typecheck: passed.
- Full suite: all 528 tests passed, but npm exited nonzero because of a pre-existing late `Cancelled` rejection in `harness-runner.test.ts`.
