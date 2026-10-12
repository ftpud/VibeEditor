# Completed

Implemented workflow canvas panning.

- Finished the existing draft implementation recovered during roadmap continuation.
- Captures pan gestures before block handlers, preventing accidental block movement.
- Ends panning on pointer release, cancellation, lost capture, and window blur.
- Added interaction coverage for middle-drag, Space-drag, form fields, and cleanup.
- Validation passed: full Desktop suite — 332 renderer tests and 6 Electron tests.

- Added middle-button drag and Space+left-drag to pan the workflow canvas.
- Shows grab/grabbing cursor feedback while editing.
- Preserved normal block drag behavior and prevented the browser's middle-click autoscroll.
- Validation passed: `npm run typecheck -w @remote-ide/desktop`.

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

# Workflow continuation check

Input: Start the workflow.

`TODO.md` is absent from the current checkout and from `HEAD` (removed in commit `a2054ab`, “Remove workflow planning notes”). The previous roadmap is recoverable from its parent commit and still has unchecked items, including run history details, a chronological timeline, deterministic appended input, resource/data limits, audit fields, product hardening, documentation, and broader acceptance tests. A coder job remains; continue the workflow.

No implementation was performed in this continuation check.

## TODO-001 — Proc sidebar: inspect and kill AI-started processes

- Completed locally: 2026-10-12.
- Result: Proc sits beside Timers in focused/classic layouts, persists navigation, and lists managed AI processes across root/task/workflow sessions with command, PID and available context. Kill stops the selected process and managed descendants, reconciles natural exits, and protects unrelated projects/sessions.
- Changed areas: typed Protocol list/kill/live events; Core ACP, workflow script and Run App launch tracking, Linux inherited identities, PID lifetime checks and launch cleanup; Desktop panel, state persistence and themed states; docs/PROCESSES.md.
- Validation: full build; ACP/Protocol build and Core/Desktop/Electron/Gateway typechecks; focused real ACP/Run App/subprocess and sidebar checks; smart integration full suite passed (469 Core + 362 renderer + 6 Electron + 11 Gateway renderer + 33 Gateway Electron = 881 tests); git diff --check; clean worker tree.
- Task: ff020776-f19a-4c97-acd6-0ee10731c1c3; branch: feature/todo-001-proc-sidebar; provider: codex. New task for an independent subsystem; no reset/reuse needed; task finished.
- Implementation commit: 0b6f30023550d0749c145279383d97ec64099981.
- Integrated root commit: 0b6f30023550d0749c145279383d97ec64099981 (smart fast-forward); integration: 20301abd-8798-4800-9b56-8a4b3f846b8b completed, suite exit 0.
- Publishing: pushed normally to origin / refs/heads/dev; published SHA fdfb9b72bc8d5299ee1ae2f416b46d2e594d2f38 includes the integrated feature and completion bookkeeping. Push succeeded and remote tracking/remote ref were verified. Final publishing-record commit may follow; no feature replay needed.
- Recovery evidence: initial isolated worktree lacked vitest; shared validated task dependencies and ran checks. An existing 15ms workflow concurrency test failed once, then passed focused and final full-suite checks. A post-merge planned-feature notification errored after integration; actual root Git history, completed integration and finished task confirmed success.
- Limits/follow-ups: Linux /proc provides full inherited discovery. POSIX fallback cannot recover every detached child and uses lower precision identities; native Windows Core discovery unsupported. Identity-stripping commands and processes from previous Core lifetimes are excluded; see docs/PROCESSES.md. Integration dependency preparation and timing-sensitive existing workflow test remain tooling follow-ups.

## TODO-002 — Independent workflow chatboxes while another block is busy

- Completed locally: 2026-10-12.
- Result: idle Chatboxes accept independent messages while another Chatbox/agent works; block-specific admission and UI busy state preserve sessions, histories, connected tools and aggregate completion. Duplicate busy-target submissions are rejected.
- Changed areas: Core harness-runner and workflow-flow regressions; Desktop HarnessPanel and WorkflowRunPanel regressions.
- Validation: full build, repository/Gateway typechecks, full tests; independent history/tool delivery, admission race, reverse completion and failure isolation regressions; clean task tree/diff review; smart integration suite exit 0.
- Task: 451433d2-5f35-44aa-9217-28ce43a5fd96; branch feature/todo-002-independent-chatboxes; provider codex; finished. New task for runtime concurrency; no context reset.
- Implementation/integrated SHA: a238ce92928f1510aef211abe6f9a8c6fd654b96; integration 0f71ed2e-c222-4b5b-aea3-3d5547d21659 completed.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA a702ef6d0c6ae529a49f55d24d1f7ea106c84341; remote tracking and remote ref verified.
- Limitations: Stop remains run-wide. Isolated integration dependency environment repaired; post-merge planned-feature notification errored after confirmed successful integration.

## TODO-003 — Float workflow fit controls over the flowchart

- Completed locally: 2026-10-12.
- Result: Horizontal/vertical Fit controls float at the bottom-left of the scrolling chart viewport with keyboard access, tooltips and theme styling.
- Changed areas: Desktop WorkflowRunPanel, styles and fit interaction tests.
- Validation: full build, repository/Gateway typechecks, full tests, fit/keyboard and Chromium CSS positioning checks; smart integration suite exit 0; clean worker tree and scoped diff review.
- Task: 360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch feature/todo-003-workflow-fit-overlay; provider codex. Session decision: New Desktop layout task, to be reused for TODO-004/005; no reset.
- Implementation/integrated SHA: d2bd3bba05a525bcc0f21b93bb2eaba6843c0d47; integration aaaa6338-e276-4de8-9e09-a71690eb149a completed.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA 35d067d0ad21622ee69fc3afd578da7550b5b307; remote tracking and remote ref verified.
- Limitations/follow-ups: Browser positioning verified with a CSS fixture rather than full Electron UI. Post-merge notification errored after confirmed integration.

## TODO-004 — Move New run and Rerun to compact top icon controls

- Completed locally: 2026-10-12.
- Result: New run and Rerun are compact icons beside Run prompt; starting-point selection, snapshot reruns, pending states and labelled Stop controls remain available; completed cards have no dedicated action row.
- Changed areas: Desktop WorkflowRunPanel, styles and interaction coverage.
- Validation: full build, repository/Gateway typechecks, full tests, active/completed/no-run and keyboard interactions, narrow-width Chromium CSS checks; smart integration suite exit 0; clean worker tree and scoped diff review.
- Task: 360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch feature/todo-003-workflow-fit-overlay; provider codex. Session decision: Reused TODO-003 task and codex conversation with clean root synchronization; no reset.
- Implementation/integrated SHA: 2edbe5176859e10540104ff3765bca753dfd32a7; integration f0fea944-c69f-4f7a-8e7e-73a200ca2731 completed.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA c01feb73d6451ba3623d28772ab68e5e6e0afd56; remote tracking and remote ref verified.
- Limitations/follow-ups: Browser checks use CSS fixtures rather than full Electron UI. Post-merge notification error reconciled against successful integration.

## TODO-005 — Compact armed workflow timers into a single-line status strip

- Completed locally: 2026-10-12.
- Result: Armed Workflows timers render as borderless single-line strips with a colored state bar, due time, Stop/Run now actions and pending/error feedback; long labels truncate and other pause layouts remain preserved.
- Changed areas: Desktop HarnessPanel PauseResolution, WorkflowRunPanel, styles and timer interaction tests.
- Validation: build, repository/Gateway typechecks, full tests, timer cancellation/resume/pending/error/transition regressions, narrow/theme Chromium CSS checks; smart integration suite exit 0; clean worker tree and scoped diff review.
- Task: 360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch feature/todo-003-workflow-fit-overlay; provider codex. Session decision: Reused TODO-003/004 task and codex conversation; no reset; task finished after final layout item.
- Implementation/integrated SHA: 15fe97e0bd1ce6c584352dcf4044f5b1b98b70e3; integration 81225b9a-7dde-4473-abb4-a78163cc8c61 completed.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA 2571c5ee09ebf3d1947bc6d7c612b19fe2d6c2ce; remote tracking and remote ref verified.
- Limitations/follow-ups: CSS fixture visual validation rather than full Electron UI. Stop retains existing whole-run cancellation semantics. Post-merge notification error reconciled against successful integration.

## TODO-006 — Review and improve independent WebSocket request concurrency

- Completed locally: 2026-10-12.
- Result: Real WebSocket/PTY evidence confirms independent fast reads, errors and terminal output arrive during a held slow read, with request-ID correlation and workspace-switch ordering preserved. Added regression tests and findings documentation; transport already concurrent, so no runtime rewrite was justified.
- Changed areas: Core real WebSocket/PTY concurrency test, Desktop client response/disconnect tests, docs/WEBSOCKET-CONCURRENCY.md.
- Validation: full build, all required typechecks, 904 tests including independent delivery, reverse responses, errors/disconnect and workspace-switch barrier; smart integration suite exit 0; clean worker tree and scoped diff review.
- Task: daa5a9cd-4e02-4ce7-afc1-795fbcffae41; branch feature/todo-006-websocket-concurrency; provider codex. Session decision: New independent transport task; no reset; task finished after integration.
- Implementation/integrated SHA: abc48d6137c72be6a8c27a6408e52b7c9d4cefd7; integration b6402e44-e4f4-4edf-bf13-7fa1935dad58 completed.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA 3f05fe9ba0335f8cc9a7bd83d11841e0ea54a320; remote tracking and remote ref verified.
- Limitations/follow-ups: Tests establish async concurrency, not saturated-network performance or unlimited-load backpressure. Large queued frames/event-loop stalls can still delay delivery; existing service ordering retained. Post-merge notification error reconciled against successful integration.

## TODO-007 — Focus Proc on workflow apps and review growing process counts

- Completed locally: 2026-10-12.
- Result: Proc counts one entry per explicitly launched workflow app tree, excluding agent/helpers. Detached app survivors remain visible as Children running, Start reuses their launch, and Stop terminates the whole chosen app tree without affecting other apps/agents. Fixed stale Stop snapshots and unnecessary status/tail scans.
- Changed areas: Protocol app-launch metadata; Core managed/process grouping, Run App lifecycle and routes; Desktop Proc/workflow app status UI; lifecycle/isolation/UI tests and docs/PROCESSES.md.
- Validation: full build, required repository/Gateway typechecks, full tests and final impacted UI checks; real app children/repeated concurrent starts/stops/natural exits/detached survivors/root isolation; 910 smart integration tests; smart integration suite exit 0; clean worker tree and scoped diff review.
- Task: ff020776-f19a-4c97-acd6-0ee10731c1c3; branch feature/todo-001-proc-sidebar; provider codex. Session decision: Reused original TODO-001 task and codex conversation for related correction; no reset; task finished.
- Implementation/integrated SHA: cb94315b3b6af409b1f2bde16863bafa14683aaf; integration b0ab7813-e3f4-47ec-8a8b-4349ea94580a completed.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA 5656f0019cd6c7353612c505b9c105f7668db7e7; remote tracking and remote ref verified.
- Limitations/follow-ups: Broad PID counting inflated totals and detached survivors could accumulate across starts; complete natural exits did not reproduce duplicate/stale rows. Linux /proc gives full inherited discovery; POSIX fallback, stripped identities and previous Core lifetimes remain documented limitations. Earlier lifecycle failures repaired and final suite passed; post-merge notification error reconciled.

## TODO-008 — Move workflow Stop into the top toolbar

- Completed locally: 2026-10-12. Result: accessible run-specific Stop icons beside New run/Rerun; dedicated action row removed; pending disable and cancellation errors/retry preserved.
- Areas: Desktop WorkflowRunPanel, styles and interaction tests.
- Validation: build, repository/Gateway typechecks, full tests on rerun, focused cancellation/keyboard/multiple-run tests and narrow/theme browser CSS checks; smart integration suite exit 0; reviewed scoped commit and clean worker. Initial Core timing failure passed isolated/full reruns.
- Task: 360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch feature/todo-003-workflow-fit-overlay; provider codex. Reused merged clean workflow layout task/conversation; no reset.
- Implementation/integrated SHA: af845d41b180084dd74e9632d6889478fef20a2e; integration 57bcd39a-6a83-4553-a303-d3361d592bcf completed. Post-merge notification error reconciled with actual root history and retained integration evidence.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA 60b6cf15b3a1dcd907927eb7405003dac3fac6ad; tracking and remote ref verified. TODO.md contains pre-existing user backlog replacement; completion annotations remain intact locally and are not staged with that unrelated edit.
- Limitations: no full Electron visual check.

## TODO-009 — Move Fit controls into the workflow toolbar

- Completed locally: 2026-10-12. Result: horizontal/vertical Fit icons precede New run/Rerun/Stop with a separator; removed overlay row and reserved padding, retained viewport fitting and keyboard/tooltips including cards without runs.
- Areas: Desktop WorkflowRunPanel, styles, fit interaction coverage.
- Validation: build, repository/Gateway typechecks, full tests; actual-component Chromium checks of measurements, keyboard, narrow/expanded layouts and themes; smart integration suite exit 0; scoped commit reviewed, clean worker tree.
- Task: 360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch feature/todo-003-workflow-fit-overlay; provider codex. Reused merged clean layout task/conversation; no reset.
- Implementation/integrated SHA: 2987a594b3636cfaf8bc1beb0af9e8ddd1796975; integration 23cf5de6-40c1-4b8f-be5c-401418a084c6 completed. Post-merge notification error reconciled with actual history and integration record.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA 7ae1b26db916235dc616f9ad4a67426baa546a06; tracking and remote ref verified. TODO.md remains locally annotated but uncommitted because of the pre-existing user backlog replacement.
- Limitations: no full Electron visual check.

## TODO-010 — Keep expanded workflow Chatbox composer reachable during resize

- Completed locally: 2026-10-12. Result: lowered transcript minimum from 140px to zero, removed expanded chatbox fixed 300px minimum in favor of intrinsic controls; transcript shrinks/scrolls and chart/run context scrolls separately. Composer remains in panel at moderate resize heights; normal transcript grows with available space.
- Areas: Desktop WorkflowRunPanel context wrapper and workflow/chatbox CSS.
- Validation: build, repository/Gateway typechecks, full tests on rerun; real rendered Chromium progressive Tasks resize from focused composer without manual outer scrolling, panel bounds, themes/widths, normal restoration, keyboard/send. At 381px panel height composer bottom improved 1061px to 837px within 850px boundary; roomy transcript grows to 292px. Scoped commit reviewed, clean worker.
- Task: 360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch feature/todo-003-workflow-fit-overlay; provider codex. Reused clean merged layout task/conversation, no reset; targeted containment review follow-up improved verification and layout.
- Implementation/integrated SHA: ae0b9e2f7092f465292b5b549a625b767f3bc259; integration 570e67d9-905a-4b07-bffe-93fd4fecfc72 completed suite exit 0. Initial integration 4b09839f-01f9-49cd-b397-bcb3e164ace6 failed unrelated live-JVM timeout with root unchanged; isolated JVM and retained full suite passed, retry same merge delivery succeeded. Post-merge notification error reconciled from actual history and integration record.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA 2a9338d7dc0d67a300db8dc4b8e92836b4759ea5; tracking and remote ref verified. TODO.md remains locally annotated but uncommitted to preserve pre-existing user backlog replacement.
- Limitations: near the roughly 70px resize minimum, outer scrolling is required for intrinsic controls; keyboard reachability verified. No full Electron visual check.

## todo-queue-20261012-connectivity / TODO-001 — Keep workflow Stop beside Start and Rerun

- Completed locally: 2026-10-12. Stop shares one horizontal row with Run/New run and Rerun in workflow cards and HarnessPanel. Narrow or many-run rows scroll horizontally; focus reveals actions; cancellation feedback retained.
- Areas: Desktop WorkflowRunPanel, HarnessPanel, styles, interaction coverage and reusable real-component browser layout regression.
- Validation: build, repository/Gateway typechecks, full tests, 36 Chromium cases (240/320/800px, themes, 0/1/6 active runs), old CSS reproduces 29px wrap; reviewed scoped commit and clean worker. Smart integration suite exit 0.
- Task: 360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch feature/todo-003-workflow-fit-overlay; provider codex. Reused clean merged layout conversation, no reset.
- Implementation/integrated SHA: 41e80f2a5cacf795ddc361220b8b1d249ab9ff3f. Integration 73e9edbd-155c-4dc1-a636-37242f275290 completed. Feature-assignment notification error reconciled from root history and Core integration record.
- Publishing: pushed normally to origin/refs/heads/dev; published SHA fdb95795c6bb69d763b3e572ab35c84bc5e279c0, remote/tracking verified. Root TODO remains uncommitted to preserve pre-existing dispatcher backlog replacement.
- Limitations: many runs require horizontal scrolling; no full Electron session check. Historical TODO-001 refers to a different feature and is preserved above.
