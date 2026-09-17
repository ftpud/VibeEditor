# AI Workflows implementation plan

AI Workflows provide a visual, observable alternative to a single AI chat. Definitions and run state belong to Core; Desktop edits and displays them through the typed protocol. Execution must reuse the existing provider-neutral ACP registry, provider adapters, agent files/presets, MCP assembly (`withAppTools`), permission flow, and provider descriptor metadata used by the AI tab. The internal harness implementation may add isolated session ownership and orchestration around that path, but must not fork or replace it.

## Phase 1 — durable definitions and visual editor (in progress)

- [x] Define provider-neutral harness, block, edge, and run snapshot types in the protocol.
- [x] Add Core-owned, workspace-scoped persistence with list/create/update/delete operations.
- [x] Add a Workflows tool-window tab in both Classic and AI-focused layouts.
- [x] Add create, select, rename, and delete controls.
- [x] Add a visual block canvas with draggable prompt blocks and dependency connectors.
- [x] Add block editing for label, provider, model, agent preset, and prompt template.
- [x] Add an initial prompt entry point and explicit save/run controls.
- [x] Add Core-store tests for persistence, workspace isolation, versioning, and basic CRUD conflicts.
- [ ] Add focused component tests and graph-validation tests once execution validation lands.

## Phase 2 — execution engine

- [x] Validate graphs before a run: unique IDs, existing edge endpoints, duplicate/self edges, acyclic dependencies, and at least one entry block.
- [x] Compile the graph into a dependency-aware execution plan; run independent ready blocks concurrently with a configurable limit.
- [x] Resolve `{{input}}` and `{{blocks.<id>.output}}` variables without executing arbitrary templates.
- [x] Start each workflow block in an isolated, persistent provider session that can receive later upstream prompts.
- [ ] Resolve each block's provider, model, reasoning level, agent preset, MCP set, timeout, and retry policy from descriptor metadata.
- [ ] Route block dispatch through the same ACP `send` request shape and `withAppTools` agent/MCP setup as the AI tab; cover compatibility with shared fake-provider integration tests.
- [x] Persist bounded run snapshots separately from editable definitions and stream block/run changes to Desktop.
- [ ] Extend the implemented start/cancel operations with retry-block, resume, and rerun-from-block.
- [x] Stream run/block state events for queued, running, succeeded, failed, and cancelled states with bounded persisted history.
- [ ] Handle permission and user-input pauses with ownership tied to harness run and block IDs.

## Phase 3 — richer orchestration

- [x] Add fan-out and AI-selected conditional paths. Transform, human-approval, and reusable sub-harness blocks remain.
- [x] Define `all` and `any` join semantics. Failure tolerance and richer typed ports remain.
- [x] Allow an agent block to launch one or more child paths and wait for their result through downstream joins.
- [x] Allow an upstream AI block to create a dynamic stack of distinct downstream inputs and release later paths only after every stack item completes.
- [x] Expose `workflow_run_stack` through MCP so a running block can launch and await any dynamically sized downstream stack, inspect its results, and continue the same response.
- [x] Add visible task-orchestrator blocks backed by the same persistent AI runtime; task creation and merging remain explicit MCP operations.
- [x] Allow hot-added prompts to steer or append to the active dispatcher session while existing downstream work continues.
- [x] Preserve workflow identity through MCP continuation timers so an agent can wait, resume its existing session, trigger downstream blocks, and continue.
- [ ] Add per-block input/output inspection, token/cost/timing metrics, and an execution timeline.
- [ ] Add run history, comparison, export/import, duplication, and version migration.
- [ ] Add canvas pan/zoom, keyboard navigation, multi-select, copy/paste, auto-layout, and accessible non-canvas editing.

## Phase 4 — reliability and safety

- [ ] Add restart recovery and reconciliation for interrupted Core processes.
- [ ] Bound concurrency, output size, run duration, retries, and recursive sub-harness depth.
- [ ] Redact secrets from persisted prompts, outputs, logs, and exports.
- [ ] Add graph/executor unit tests, fake-provider integration tests, protocol compatibility tests, and Desktop interaction/accessibility tests.
- [ ] Document the file format, execution semantics, failure behavior, and extension points.

### Current vertical-slice boundary

AI Workflows execute dependency-aware graphs with fan-out, joins, persistent block sessions, and MCP-created task worktrees. The example delivery pipeline is experimental: its review/test gates and correction loop are prompt instructions, not enforced execution guarantees. Independent watchdog startup and failed-block continuation have focused test coverage; complete delivery, child-task recovery, and Core restart recovery are not yet established. Checked items above describe available primitives, not end-to-end reliability.

## Reliability backlog — required before unattended delivery

Preserve the visible multi-block workflow. AI performs planning, implementation, and review; Core owns durable state, scheduling, retries, dependency tracking, and verification gates. Implement P0 before treating the example as an unattended development workflow.

### P0 — correct execution and recovery

- [ ] Replace model-dependent watchdog recovery with a Core-managed scheduler, exposed as a visible watchdog block. Start the main flow independently; reset signals must never block it or replay completed work. Schedule recovery even when the watchdog's provider cannot execute any AI turn.
- [ ] Classify quota exhaustion, transient transport failures, permission/input pauses, cancelled work, and permanent errors. Retry only eligible failures with bounded attempts/backoff; surface exhausted retries and actionable blockers. Use the reset of the actually exhausted quota window, accounting for multiple windows, stale timestamps, and unavailable usage data.
- [ ] Persist a versioned execution plan, feature/task registry, stage attempts, session IDs, timer ownership, checkpoints, and pending commands. On Core restart, reconcile running providers and existing worktrees before resuming; do not recreate completed tasks or merges.
- [ ] Add idempotency keys and durable operation records for task creation, prompt delivery, timers, and merges. Recover safely when a tool succeeds but its reply or the next checkpoint is lost. Session memory and instructions to avoid duplicates are insufficient.
- [ ] Implement dependency scheduling for feature tasks, not just graph blocks. Revisit deferred features as prerequisites complete, launch every newly ready feature, and prevent completion while any planned feature remains undispatched. Give dependent workspaces the required prerequisite commits.
- [ ] Implement an explicit review/test correction loop. Findings route back to the responsible task; await corrections and rerun review/tests against the updated commit before releasing later stages. A stage returning a BLOCKED report must not count as successful delivery.
- [ ] Validate typed handoffs in Core. Preserve original request, acceptance criteria, feature IDs, task/worktree IDs, dependencies, integration order, commit SHAs, findings, and test evidence across every stage. Reject malformed or incomplete outputs instead of silently forwarding them.
- [ ] Recover child-task sessions as well as workflow blocks. Track ownership and distinguish actively working, waiting on a timer, quota-blocked, awaiting user input, failed, and unresponsive sessions. Detect stalls with explicit deadlines/liveness evidence; never steer a healthy task repeatedly on reset signals.
- [ ] Use one scheduler for automatic graph execution, MCP-started descendants, retries, and appended prompts. Enforce concurrency limits consistently and prevent duplicate dispatch, competing session writers, and downstream execution before joins are satisfied.
- [ ] Make cancellation authoritative across blocks, child tasks, in-flight tool commands, and timers. A timer firing concurrently with Stop must not resurrect work. Separate main-flow completion from watchdog-service lifetime so a completed delivery is visible while monitoring remains active.

### P0 — verified changes and safe integration

- [ ] Make review inspect actual task diffs and repository context, not only assistant response tails. Bind findings and approval to exact commit SHAs; invalidate approval after any correction.
- [ ] Run verification commands through Core-owned execution and retain command, working directory, commit SHA, exit code, and output references. Enforce pass/fail gates from recorded results rather than a model-generated tests_passed flag. Report unavailable tests as unverified.
- [ ] Assemble approved feature commits in an isolated integration worktree and run the combined build/test suite there. Route integration failures back through correction and re-review. Update the root only after the integrated revision passes; detect root changes since validation.
- [ ] Serialize every root-mutating integration operation across UI and MCP callers. Track conflicts, stash ownership, and partially completed merges durably; preserve unrelated user edits and expose recovery steps without automatic destructive cleanup.

### P1 — usable and economical operation

- [ ] Provide a complete execution timeline with streamed provider/tool activity, inputs/results, timer deadlines and revivals, retry reasons, handoffs, and child-task links. Current prompt/final-answer logs are not a full transcript. Persist paginated history with explicit retention/redaction and export support.
- [ ] Show why each block is waiting and its next scheduled action. Expose retry, resume, permission resolution, cancellation, and recovery failures in View mode.
- [ ] Make hot-added requests durable and route them to main-flow intake rather than the watchdog. Update the feature plan without resetting active sessions, losing task ownership, or silently dropping new work after intake completes.
- [ ] Validate model availability against the live ACP provider before execution. Select role-specific models and reasoning through provider metadata; a local model cache is not proof of availability. Avoid using AI calls for deterministic scheduling or formatting.
- [ ] Add run budgets for model usage, active tasks, retries, polling, and elapsed time. Keep the watchdog inexpensive and make its post-delivery lifetime configurable.

### Acceptance scenarios and effectiveness checks

- [ ] Prove with deterministic fake-provider tests that main work starts immediately while the watchdog sleeps, repeated reset signals do not duplicate work, and failed child sessions resume without rerunning successful stages.
- [ ] Inject crashes before and after task creation, tool replies, checkpoint writes, timer firing, and merge completion; verify restart reconciliation and cancellation races.
- [ ] Exercise a dependent multi-feature plan through review rejection, fixes, failing tests, re-review, integration conflicts, and successful delivery. Assert no missing features and no merge of an unverified revision.
- [ ] Exercise unavailable models, exhausted primary/secondary quota windows, malformed handoffs, blocked permissions, and unresponsive agents. Verify useful UI state and bounded recovery.
- [ ] Run a small real-provider end-to-end delivery in a disposable repository after deterministic checks. Existing isolated unit tests do not establish full pipeline reliability.
- [ ] Compare representative small fixes and independent multi-feature work against a single implementation agent plus reviewer. Record elapsed time, model usage, intervention count, defects, and merge failures; use the larger workflow only where measured benefits justify its overhead.
