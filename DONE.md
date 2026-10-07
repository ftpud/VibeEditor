# Completed

Implemented and committed workflow canvas auto-layout.

- Added an Edit-mode “Layout” control that arranges workflow paths left-to-right.
- Ignores tool and loop links for rank calculation while keeping disconnected blocks stable.
- Added unit and UI coverage.
- Validation passed: `npm run typecheck -w @remote-ide/desktop`.
- Validation passed: `npm test -w @remote-ide/desktop` — 286 tests passed.
- Commit: `8d55947 Add workflow canvas auto layout`.

`TODO.md` is absent from the current checkout. Its last committed roadmap still has unfinished items, beginning with continuous editor validation, editing safeguards, and remaining canvas navigation/accessibility work.

Implemented and committed workflow canvas minimap.

- Shows block locations and the current viewport for oversized graphs.
- Supports click and keyboard activation to move the canvas viewport.
- Updates on scrolling, zooming, workflow selection, and window resize.
- Added minimap geometry and interaction tests.
- Validation passed: `npm run typecheck -w @remote-ide/desktop`.
- Validation passed: `npm test -w @remote-ide/desktop` — 288 tests passed.
- Focused `HarnessPanel` suite passed after the final lifecycle adjustment — 43 tests.
- Commit: `560343b Add workflow canvas minimap`.

Implemented and committed workflow canvas multi-select.

- Ctrl/Cmd-click adds or removes blocks from the selection.
- Dragging any selected block moves the selected group together.
- Added a clear-selection control.
- Preserved click-based inspector selection.
- Validation passed: `npm run typecheck -w @remote-ide/desktop`.
- Validation passed: `npm test -w @remote-ide/desktop` — 289 tests passed.
- Commit: `4cb73d6 Add workflow canvas multi-select`.

Implemented and committed workflow block alignment controls.

- Multi-selected blocks can align left, center, right, top, middle, or bottom.
- Alignment updates only the selected blocks and remains an unsaved draft edit.
- Added renderer coverage for control behavior and alignment geometry.
- Validation passed: `npm run typecheck -w @remote-ide/desktop`.
- Validation passed: `npm test -w @remote-ide/desktop` — 290 tests passed.
- Commit: `abaed80 Add workflow block alignment controls`.

Implemented and committed keyboard workflow connection editing.

- Focus an output port and press Enter or Space to start or cancel a connection.
- Focus an enabled input port and press Enter or Space to complete a connection.
- Ports expose `aria-keyshortcuts` for assistive technology.
- Added focused interaction coverage.
- Validation passed: `npm run typecheck -w @remote-ide/desktop`.
- Validation passed: `npm test -w @remote-ide/desktop` — 291 tests passed.
- Commit: `95238de Add keyboard workflow connection editing`.

Implemented and committed the workflow list editor.

- Added an Edit-mode Canvas/List switch.
- The list supports keyboard-accessible block selection, editing, and removal.
- Added a form for creating connections without canvas or SVG interaction.
- Existing connection settings and removal controls work from the list.
- Validation passed: `npm run typecheck -w @remote-ide/desktop`.
- Validation passed: `npm test -w @remote-ide/desktop` — 292 tests passed.
- Commit: `5646af2 Add workflow list editor`.

Implemented and committed workflow accessibility feedback.

- Added separate polite live regions for validation changes and selected run-state changes.
- Added visible focus styling for workflow connection edges and list-editor rows.
- Added coverage for validation and run-status announcements.
- Validation passed: `npm run typecheck -w @remote-ide/desktop`.
- Validation passed: `npm test -w @remote-ide/desktop` — 293 tests passed.
- Commit: `234e562 Announce workflow validation and run changes`.

Implemented and committed workflow-level concurrency settings.

- Persisted typed `settings.concurrency`, validated from 1–32.
- Applied the saved limit to graph and async stack scheduling.
- Added a Desktop execution-settings control and tests.
- Validation passed: Protocol build; Core typecheck and 362 tests; Desktop typecheck and 294 tests.
- Commit: `96919ae Add workflow concurrency settings`.

Implemented and committed workflow block reasoning configuration.

- Uses the model-advertised default reasoning when a model is selected.
- Lets authors choose a supported reasoning level for each AI block.
- Persists and applies the selected level for normal and recovery provider sessions.
- Validation passed: Protocol build; Core and Desktop typechecks; Core 362 tests; Desktop/Electron 294 tests.
- Commit: `ce6f7d5 Add workflow reasoning configuration`.

Implemented and committed workflow retry-policy settings.

- Added persisted, validated retry-attempt limits from 1–10.
- Applied the limit to retries, watchdog resumes, child recovery, manual retry, and terminal detection.
- Added editor controls and scheduler coverage.
- Validation passed: Protocol build; Core/Desktop typechecks; Core 363 tests; Desktop/Electron 294 tests.
- Commit: `472ec95 Add workflow retry policy settings`.

Implemented and committed workflow output limits.

- Added persisted, validated limits from 1,000–200,000 characters.
- Bounds retained block output and downstream handoffs.
- Added editor controls and graph, scheduler, and editor tests.
- Validation passed: Protocol build; Core and Desktop typechecks; targeted workflow tests; Desktop/Electron 294 tests.
- Core’s full suite had one transient live-JVM debugger timeout; its isolated rerun passed.
- Commit: `d7f1731 Add workflow output limits`.

Implemented and committed workflow log limits.

- Added persisted, validated per-block log-entry limits from 10–500.
- Enforces the configured limit before each Core run snapshot is stored.
- Added editor controls and validation coverage.
- Validation passed: Protocol build; Core/Desktop typechecks; Core 364 tests; Desktop/Electron 294 tests.
- Commit: `9beb711 Add workflow log limits`.

Implemented and committed workflow run-duration limits.

- Added a persisted duration setting from 1 minute to 24 hours.
- Enforces expiry through runner activity guards and records a failed terminal run.
- Added editor controls and validation coverage.
- Validation passed: Protocol build; Core/Desktop typechecks; Core 364 tests; Desktop/Electron 294 tests.
- Commit: `7a3a59f Add workflow run duration limits`.

Implemented and committed runtime workflow model availability checks.

- Core checks the provider’s live model catalogue before normal and recovered workflow sessions start.
- Unavailable or retired models now fail with an actionable message.
- Added Core server coverage.
- Validation passed: Core typecheck and 17 focused server tests.
- Commit: `e00acbd Verify workflow models at runtime`.

Implemented and committed token-budget enforcement.

- Added persisted workflow token budgets, validated from 1,000–10,000,000 tokens.
- Stores provider-reported per-block token usage.
- Fails runs once aggregate reported usage exceeds the saved budget.
- Validation passed: Protocol build, Core typecheck, and 55 focused graph/scheduler tests.
- Commit: `b8ad26a Enforce workflow token budgets`.

Implemented and committed the token-budget authoring control.

- Added an editable workflow token budget in Execution settings.
- Persists the configured value through Save.
- Validation passed: Protocol build, Desktop typecheck, and 49 HarnessPanel tests.
- Commit: `5b971b9 Expose workflow token budgets`.

Implemented and committed workflow token-usage visibility.

- Shows provider-reported per-block token totals in run details.
- Added formatting coverage in HarnessPanel tests.
- Validation passed: Desktop typecheck and 49 HarnessPanel tests.
- Commit: `bdd24b2 Show workflow token usage`.

Added end-to-end scheduler coverage for workflow token budgets.

- Verifies that an over-budget provider result fails the run.
- Verifies reported token usage remains persisted for inspection.
- Validation passed: Core typecheck and 46 HarnessRunner tests.
- Commit: `e472cee Test workflow token budget enforcement`.

Added scheduler coverage for workflow run-duration limits.

- Simulates expiry after provider dispatch begins.
- Verifies the workflow reaches a failed terminal state with the duration error.
- Validation passed: Core typecheck and 47 HarnessRunner tests.
- Commit: `6caab10 Test workflow run duration limits`.

Extended token-budget enforcement across all workflow execution paths.

- Applies to appended flow input, nested flow turns, and script-dispatched flow blocks.
- Persists the latest provider token usage before enforcing the aggregate cap.
- Validation passed: Core typecheck and 47 HarnessRunner tests.
- Commit: `660baeb Enforce token budgets across workflow paths`.

Implemented and committed runtime validation for workflow reasoning settings.

- Rejects saved reasoning efforts unsupported by the selected live model.
- Applies during normal and recovered workflow startup.
- Validation passed: Core typecheck and 17 focused server tests.
- Commit: `5e1f612 Validate workflow reasoning at runtime`.

Added persisted token-usage validation.

- Stored token totals, input/output, and optional usage fields must be finite nonnegative values.
- Existing runs without token usage remain compatible.
- Validation passed: Core typecheck and 11 HarnessStore tests.
- Commit: `b8dc2eb Validate persisted workflow token usage`.

Implemented and committed selected workflow run details in the inspector.

- Shows the run ID and frozen definition version.
- Shows the recorded start time and elapsed duration when available.
- Validation passed: Desktop typecheck and 49 HarnessPanel tests.
- Commit: `84711eb Show workflow run details`.

Added aggregate token usage to selected workflow run details.

- Sums provider-reported tokens across all blocks in the selected run.
- Displays the total alongside run identity, definition version, and timing.
- Validation passed: Desktop typecheck and 49 HarnessPanel tests.
- Commit: `f184c9b Show workflow run token totals`.

Implemented and committed selected-run token-budget visibility.

- Run details now show aggregate tokens alongside the configured budget.
- Over-budget totals use the existing error styling.
- Added coverage in `HarnessPanel.test.tsx`.
- Validation passed: Desktop typecheck and 49 HarnessPanel tests.
- Commit: `b5053c4 Show workflow token budget usage`.

Implemented and committed the selected-run execution timeline.

- Merges persisted workflow operations with block logs in chronological order.
- Shows block labels, operation status/errors, prompts, and responses.
- Added focused coverage.
- Validation passed: Desktop typecheck and 50 HarnessPanel tests.
- Commit: `e4dd25c Show workflow execution timeline`.

Implemented and committed pagination for selected-run execution timelines.

- Displays 50 events per page.
- Supports Previous/Next navigation with the visible range.
- Resets to the first page when selecting another run.
- Validation passed: Desktop typecheck and 51 HarnessPanel tests.
- Commit: `2205f36 Paginate workflow execution timeline`.

Implemented and committed waiting-state explanations for selected workflow blocks.

- Explains scheduler queue, dependency joins, timers, retries, permissions, and input pauses.
- Includes each state’s next action.
- Added focused coverage.
- Validation passed: Desktop typecheck and 52 HarnessPanel tests.
- Commit: `9a5fe3d Explain workflow block waiting states`.

Implemented and committed selected-block attempt history.

- Shows each persisted attempt’s status, start/completion time, and failure detail.
- Added focused coverage.
- Validation passed: Desktop typecheck and 53 HarnessPanel tests.
- Commit: `f15cb57 Show workflow block attempt history`.

Implemented and committed workflow run comparison.

- Compares the selected run with another historical run.
- Shows run status, aggregate token totals, and per-block status/token differences.
- Added focused coverage.
- Validation passed: Desktop typecheck and 54 HarnessPanel tests.
- Commit: `2bbaf31 Compare workflow run history`.

Implemented and committed persisted active-run limits per workflow.

- Added a configurable 1–32 active-run limit, defaulting to 4.
- Validates and persists the setting.
- Enforces the limit atomically before creating a run, including concurrent starts.
- Added Core and Desktop coverage.
- Validation passed: Protocol build; Core and Desktop typechecks; 112 focused graph/runner/panel tests.
- Commit: `3cb6e76 Limit active workflow runs`.

Implemented and committed persisted workflow block-attempt limits.

- Added a configurable 1–1,000 cap, defaulting to 100.
- Enforced before provider dispatch, including recovered runs.
- Added Protocol/Core validation, storage support, editor control, and focused tests.
- Validation passed: Protocol build; Core/Desktop typechecks; 113 focused graph/runner/panel tests.
- Commit: `11c9681 Limit workflow block attempts`.

Implemented and committed persisted workflow stack-input limits.

- Added a configurable 1–1,000 stack-input cap, defaulting to 100.
- Rejects oversized `workflow_run_stack` calls before scheduling downstream blocks.
- Added Protocol/Core validation, storage support, editor control, and focused tests.
- Validation passed: Protocol build; Core/Desktop typechecks; 114 focused graph/runner/panel tests.
- Commit: `122f0ad Limit workflow stack inputs`.

Implemented and committed persisted workflow loop-iteration limits.

- Added a configurable 1–1,000 loop cap, defaulting to 100.
- Enforces the cap per loop edge before scheduling another pass.
- Added Protocol/Core persistence and editor configuration support.
- Validation passed: Protocol build; Core/Desktop typechecks; 114 focused graph/runner/panel tests.
- Commit: `2ef0d63 Limit workflow loop iterations`.

Implemented and committed persisted workflow child-task limits.

- Added a configurable 1–1,000 child-task cap, defaulting to 100.
- Enforces the cap before registering a new child task.
- Preserves idempotent re-registration of an existing child task.
- Added Protocol/Core persistence and editor configuration support.
- Validation passed: Protocol build; Core/Desktop typechecks; 114 focused graph/runner/panel tests.
- Commit: `4f4f6ec Limit workflow child tasks`.

Added runtime coverage for workflow child-task limits.

- Confirms duplicate child registration remains idempotent.
- Confirms a new child task is rejected once the persisted cap is reached.
- Validation passed: Core typecheck and 50 HarnessRunner tests.
- Commit: `3119ec9 Test workflow child task limits`.

Implemented and committed selected-run resource-limit visibility.

- Shows the frozen run’s active-run, block-attempt, stack-input, loop-iteration, and child-task limits.
- Keeps token budget and aggregated token usage alongside the limits.
- Added focused coverage.
- Validation passed: Desktop typecheck and 54 HarnessPanel tests.
- Commit: `f45ef56 Show workflow run resource limits`.

Implemented and committed persisted workflow prompt-size limits.

- Added a configurable 1,000–200,000 character prompt cap, defaulting to 100,000.
- Enforces the limit after templates and workflow instructions are rendered, before provider dispatch.
- Added Protocol/Core persistence and editor configuration support.
- Validation passed: Protocol build; Core/Desktop typechecks; 54 HarnessPanel tests.
- Commit: `c3cbcb3 Limit workflow prompt size`.

Added runtime coverage for workflow prompt-size enforcement.

- Confirms an oversized rendered prompt fails before provider dispatch.
- Confirms the persisted run reports the configured prompt limit.
- Validation passed: Core typecheck and 51 HarnessRunner tests.
- Commit: `7735fde Test workflow prompt size limits`.

Implemented and committed persisted workflow secret redaction.

- Redacts common credential keys and token formats during JSON serialization.
- Covers persisted workflow definitions, run snapshots, prompts, outputs, logs, and operation payloads.
- Preserves the repository’s schema shape.
- Added HarnessStore coverage.
- Validation passed: Core typecheck and 12 HarnessStore tests.
- Commit: `bf62cd8 Redact persisted workflow secrets`.

Implemented and committed selected workflow-run export.

- Added an Export run action for the selected frozen run snapshot.
- Downloads formatted JSON using persisted, redacted run data.
- Added serializer coverage.
- Validation passed: Desktop typecheck and 55 HarnessPanel tests.
- Commit: `e85b11a Export selected workflow runs`.

Implemented and committed the Core/Protocol operation for deleting completed workflow runs.

- Deletes retained completed run history.
- Refuses to delete active runs until they are cancelled.
- Added typed protocol routing and store coverage.
- Validation passed: Protocol build, Core typecheck, and 13 HarnessStore tests.
- Commit: `eca8cfb Delete completed workflow runs`.

Implemented and committed selected workflow-run deletion in Desktop.

- Completed runs can be deleted after confirmation.
- Active runs remain disabled in the UI and are rejected by Core.
- Added UI coverage for both behaviors.
- Validation passed: Protocol build; Core/Desktop typechecks; 13 HarnessStore tests; 56 HarnessPanel tests.
- Commit: `fe40cc2 Delete selected workflow runs`.

Implemented and committed workflow definition duplication.

- Added a Duplicate control that creates a new workflow identity and saves a full copy.
- Added focused coverage, including accessibility labeling.
- Validation passed: Desktop typecheck and 57 `HarnessPanel.test.tsx` tests.
- Commit: `5fd571f Duplicate workflow definitions`.

Implemented and committed workflow block duplication.

- Duplicates the selected block with a new ID, copied configuration, offset position, and unique copy label.
- Added focused editor coverage.
- Validation passed: Desktop typecheck and 58 `HarnessPanel.test.tsx` tests.
- Commit: `c31431f Duplicate workflow blocks`.

Implemented and committed workflow block copy/paste.

- Copies selected block configuration to the system clipboard with an in-editor fallback.
- Pasting assigns a new ID, offsets its position, and creates a unique label.
- Validation passed: Desktop typecheck and 59 `HarnessPanel.test.tsx` tests.
- Commit: `a89c5c9 Copy and paste workflow blocks`.

Implemented and committed workflow editor undo/redo.

- Tracks up to 50 draft revisions.
- Resets history when loading, saving, reloading, or creating a workflow copy.
- Added accessible Undo and Redo controls.
- Validation passed: Desktop typecheck and 60 `HarnessPanel.test.tsx` tests.
- Commit: `65e22e9 Add workflow editor undo and redo`.

Implemented and committed workflow definition import/export.

- Exports definitions in a versioned JSON envelope with secret redaction.
- Imports current and legacy envelopes after structural validation.
- Imported workflows receive a new identity and are saved separately.
- Validation passed: Desktop typecheck and 61 `HarnessPanel.test.tsx` tests.
- Commit: `afbc041 Import and export workflow definitions`.

Implemented and committed selected workflow-run reruns from frozen snapshots.

- Reruns use the selected run’s persisted definition and input, even if the workflow changed afterward.
- Added a Rerun control for completed snapshot-backed runs.
- Validation passed: Protocol build, Core typecheck, Desktop typecheck, and 62 `HarnessPanel.test.tsx` tests.
- Commit: `071920b Rerun workflow snapshots`.

Implemented and committed snapshot reruns from a selected workflow start block.

- Shows a block-level rerun control when the selected block is a persisted start block.
- Reuses the selected run’s frozen definition and input.
- Validation passed: Desktop typecheck and 62 `HarnessPanel.test.tsx` tests.
- Commit: `e3c777c Rerun workflow start blocks`.

Implemented and committed frozen-snapshot reruns from any selected workflow block.

- Core now permits a selected persisted block as a rerun entry point.
- Desktop exposes the block rerun action whenever the selected block exists in the run snapshot.
- Validation passed: Core and Desktop typechecks.
- Commit: `207c259 Rerun selected workflow blocks`.

Implemented and committed failed-block retry control.

- When a selected block failed, Desktop now offers a retry action using the run’s frozen snapshot and the failed block as its entry point.
- Validation passed: Desktop typecheck and 62 `HarnessPanel.test.tsx` tests.
- Commit: `0d0a29d Retry failed workflow blocks`.

Added focused coverage for failed-block retry.

- Verifies the selected failed block reruns with its frozen snapshot and original input.
- Validation passed: Desktop typecheck and 63 `HarnessPanel.test.tsx` tests.
- Commit: `cdd5eea Test failed workflow block retry`.
