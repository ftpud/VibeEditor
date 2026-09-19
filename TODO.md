# Workflows reliability and usability TODO

This plan is based on the current workflow implementation in `packages/core/src/harnesses.ts`, `packages/core/src/harness-graph.ts`, `packages/core/src/harness-runner.ts`, `packages/core/src/server.ts`, `packages/core/src/app-tools.ts`, `packages/protocol/src/index.ts`, and `packages/desktop/src/renderer/HarnessPanel.tsx`.

The current vertical slice is useful: definitions and run snapshots are Core-owned, graphs support fan-out, joins, AI-selected routes, loops, persistent block sessions, timers, watchdog recovery, and task orchestration, while Desktop provides a visual editor and basic run inspection. It is not yet safe to describe as unattended delivery: process restart loses the live scheduler, several side effects are not idempotent, AI text is trusted as a gate, and important pause/recovery states have no user workflow.

## P0 — make execution correct and recoverable

- [ ] Replace the JSON read/modify/write store with a serialized, transactional repository.
  - [x] Prevent concurrent definition updates and run updates from overwriting each other.
  - [x] Use optimistic concurrency (the submitted definition `version`) for definition saves and return a conflict that Desktop can resolve.
  - [x] Persist definitions and runs separately, validate a schema version on read, quarantine corrupt records, and retain an atomic backup.
  - [x] Make retention explicit per workspace and per workflow instead of silently keeping the newest 100 runs globally.
- [ ] Persist a versioned execution plan and operation journal for each run.
  - Record block attempts, dependency decisions, selected routes, session/workspace IDs, timers, child tasks, tool commands, and terminal outcomes.
  - Give task creation, prompt delivery, timer creation/firing, child registration, and merge operations stable idempotency keys.
  - Commit intent before an external side effect and reconcile its result afterward so a lost reply cannot duplicate work.
- [ ] Reconcile incomplete runs when Core starts.
  - Load `queued`, `running`, and `waiting` runs; inspect provider sessions, timers, task worktrees, and recorded operations before deciding to resume, pause, fail, or complete them.
  - Never recreate a task, resend a completed prompt, rerun a successful block, or repeat a merge during recovery.
  - Mark unrecoverable orphaned state with a specific reason and offer Resume or Cancel; do not leave a persisted run that only looks active.
- [ ] Use one scheduler for graph blocks, `workflow_run_stack`, appended input, retries, and timer continuations.
  - Enforce the concurrency limit across every launch path, not only the initial graph loop.
  - Serialize writes to a persistent block session so two upstream blocks cannot steer/send concurrently.
  - Make block claiming atomic and use attempt IDs to ignore stale completions.
  - Define async-edge completion precisely and ensure background work cannot outlive a terminal run unnoticed.
- [ ] Make cancellation authoritative and race-safe.
  - [x] Persist cancellation intent first, invalidate scheduled attempts/timers, interrupt sessions and child tasks, then record cleanup results.
  - Check cancellation immediately before and after every provider/tool side effect.
  - [x] Report partial cancellation failures instead of swallowing all interrupt errors.
  - Add a distinct state for a completed main flow with a still-running watchdog, or stop the watchdog automatically when delivery is terminal.
- [ ] Model pauses instead of converting them into generic failure.
  - Add block/run states for `awaiting_permission`, `awaiting_user_input`, `waiting_timer`, and `retry_scheduled`.
  - Route permission requests and provider questions to Desktop with run/block/session ownership.
  - Allow the user to answer, approve, reject, resume, retry, or cancel the exact paused attempt.
- [ ] Replace regex-only error recovery with typed provider/runtime failures.
  - Normalize quota, transport, permission, user-input, cancellation, and permanent failures at the provider boundary.
  - Persist attempt count and backoff deadline before sleeping; add jitter and a maximum elapsed retry budget.
  - Retry only the failed attempt in its existing session and surface retry exhaustion as an actionable terminal state.

### P0 acceptance tests

- [ ] Inject a crash before and after task creation, prompt send, timer fire, block snapshot, and merge; restarting Core produces exactly one side effect and the correct terminal state.
- [ ] Race Stop against provider completion, timer delivery, retry wake-up, and `workflow_run_stack`; no new work starts after cancellation intent is durable.
- [ ] Run parallel fan-out plus hot input at the configured concurrency limit; assert no duplicate dispatch and no concurrent writes to one session.
- [ ] Corrupt or truncate the state file and prove valid definitions/runs remain recoverable with a visible diagnostic.

## P0 — enforce trustworthy delivery gates

- [ ] Add typed, schema-validated block outputs and inputs.
  - Let a block declare an output schema and validate it before releasing downstream dependencies.
  - Preserve the original request, feature/task IDs, dependency IDs, commit SHAs, findings, and test evidence as structured data rather than prompt-only JSON conventions.
  - Treat missing or malformed required fields as a visible blocked state with a repair/retry action.
- [ ] Move review and verification gates into Core.
  - Review the actual diff for an exact commit SHA, not only the assistant response tail.
  - Run verification through Core and retain command, working directory, revision, exit code, duration, and bounded output/artifact references.
  - Invalidate approval and test evidence whenever the reviewed revision changes.
  - A model saying `review_passed` or `tests_passed` must not release a gated edge without recorded evidence.
- [ ] Make feature dependencies executable state.
  - Store the planned feature registry and prerequisites, dispatch every newly ready feature, and block completion while a planned feature is missing or undispatched.
  - Ensure dependent workspaces contain prerequisite commits before work begins.
- [ ] Add an explicit correction loop.
  - Bind each finding to an owning task/revision, request a correction, wait for a new revision, and rerun review and tests.
  - Cap correction cycles and finish as Blocked with remaining findings when the cap is reached.
- [ ] Integrate safely.
  - Assemble approved commits in an isolated integration worktree, run the combined suite, and update the root only if the tested revision still matches expectations.
  - Serialize root-mutating operations across UI and MCP callers and durably record conflict/stash recovery information.

## P1 — make workflow authoring understandable

- [ ] Validate continuously in the editor and before Save/Run.
  - [x] Show issues on the affected block/edge and provide a summary with focus actions.
  - Validate empty labels/prompts, duplicate block and edge IDs, route labels, loop targets, unreachable blocks, unsupported template variables, provider/model/agent availability, and invalid watchdog layouts.
  - Preview rendered inputs and explain `all`, `any`, sync, async, loop, and AI-route behavior in plain language.
- [ ] Protect editing work.
  - Warn before switching workflow, mode, root, or closing with unsaved changes.
  - Resolve optimistic-save conflicts with Reload, Compare, and Save as copy.
  - Add undo/redo, duplicate workflow/block, copy/paste, and import/export with schema migration and secret redaction.
- [ ] Improve canvas navigation and accessibility.
  - Add pan/zoom, fit-to-content, auto-layout, minimap for large graphs, multi-select, alignment, and keyboard connection editing.
  - Provide an equivalent ordered/list editor so the feature is usable without pointer drag or SVG interaction.
  - Keep focus visible and announce validation and run-state changes to assistive technology.
- [ ] Make configuration explicit.
  - Expose reasoning, timeout, retry policy, concurrency, run duration, token/cost budget, and output/log limits.
  - Resolve defaults from provider descriptor metadata and verify model availability at run time.
  - Warn when a workflow depends on an unavailable provider, agent preset, MCP server, or model.

## P1 — make runs observable and controllable

- [ ] Add a real run-history selector instead of implicitly displaying the first matching run.
  - [x] Provide a run-history selector, pin active runs first, and make multiple active runs explicit.
  - Show run ID/version, input summary, start/end/duration, status, definition revision, and resource usage.
  - Pin active runs above completed runs and make multiple simultaneous runs explicit.
  - Support compare, duplicate/rerun, delete/export, and rerun from a selected block using a frozen definition snapshot.
- [ ] Add a chronological execution timeline.
  - Stream block attempts, dependency decisions, prompts/responses, provider/tool activity, timers, retries, permission/input pauses, child-task links, and cancellation.
  - Paginate large logs; store bounded artifact references rather than up to 500 entries of 200 KB each.
  - Show why a block is waiting, what it is waiting on, and its next scheduled action.
- [ ] Add safe manual controls.
  - Retry failed block, resume paused block, cancel block/subtree/run, answer a question, resolve permission, and open the owned task/session.
  - Disable actions that are stale or unsafe and explain why.
  - Confirm destructive actions with the affected active runs and retained history clearly listed.
- [ ] Make appended input deterministic.
  - Persist an inbox entry before acknowledging it, show which dispatcher(s) will receive it, and retain delivery status.
  - Do not silently send to every active root block; require a configured intake block when the choice is ambiguous.

## P1 — resource and data safety

- [ ] Enforce limits on active runs, block attempts, dynamic stack size, loop count, child tasks, wall-clock duration, prompt/output bytes, logs, and total tokens/cost.
- [ ] Keep full provider responses out of in-memory aggregation when only a bounded handoff is allowed; store large outputs as artifacts with size/type metadata.
- [ ] Redact secrets and sensitive tool content before persisting prompts, outputs, logs, handoffs, and exports; document retention and deletion behavior.
- [x] Validate all persisted nested fields instead of accepting structurally incomplete blocks, edges, runs, or agent references.
- [ ] Add audit fields for actor/source (`user`, scheduler, timer, model tool call), request ID, attempt ID, and definition version to every state transition.

## P2 — harden the product surface

- [ ] Add reusable sub-workflows with version pinning and bounded nesting after restart/idempotency guarantees are complete.
- [ ] Add deterministic transform and approval blocks so formatting and human gates do not consume model calls.
- [ ] Add workflow templates and a guided first-run example that avoids hard-coded provider/model IDs.
- [ ] Add metrics for completion rate, intervention count, retries, duplicate-prevention events, elapsed time, token/cost use, and failures by category.
- [ ] Document the file format, scheduler and join semantics, async/loop behavior, recovery guarantees, limits, security model, and extension points in `docs/`.
- [ ] Rename internal `Harness*` concepts to `Workflow*` at protocol/UI boundaries, with a compatibility migration, so product and code terminology do not diverge.

## Test plan required for completion

- [ ] Expand graph tests into table-driven coverage for validation, routing, all/any joins, loops, unreachable paths, async edges, malformed templates, and stable ordering.
- [ ] Add store tests for concurrent writers, stale versions, partial writes, backups, migrations, retention, corruption, and large-state limits.
- [ ] Add scheduler property/state-machine tests asserting legal transitions, dependency safety, exactly-once claims, bounded concurrency, and terminal-state invariants.
- [ ] Add fake-provider integration tests for permission and user-input pauses, quota reset, transient retry, timer continuation, append/steer, child-task recovery, and cancellation races.
- [ ] Add protocol compatibility tests for old definitions/runs and migration failures.
- [ ] Add Desktop tests for validation, dirty-state protection, save conflicts, run selection, multiple active runs, pause resolution, keyboard-only editing, and screen-reader status announcements.
- [ ] Run a disposable-repository end-to-end scenario covering plan, parallel implementation, rejected review, correction, failed then passing tests, integration conflict, successful merge, restart, and cancellation.

## Definition of done

A workflow is reliable enough for unattended use only when Core can restart at any persisted transition without duplicating an external side effect; every active or paused run has an honest, actionable UI state; cancellation prevents resurrection; concurrency and budgets are enforced across all launch paths; and review/test/merge gates are based on recorded repository evidence rather than model assertions. Until then, the examples in `examples/workflows/` should remain labeled experimental.
