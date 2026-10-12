- [x] TODO-001 — Proc sidebar: inspect and kill AI-started processes
  - Priority: High.
  - Scope: Desktop sidebar / Core process lifecycle / typed protocol.
  - Request: Add a “Proc” button immediately next to Timers, opening a process list styled and structured like the existing Timers panel.
  - Acceptance criteria:
    - Proc is available beside Timers in both focused and classic sidebar layouts, with consistent panel selection and persisted navigation behavior.
    - List all currently running processes started by AI agents across the root project's workspace group, including task and workflow chat sessions and their child commands/background processes. Identify each process with command/name, PID, status, and available workspace/task/session/provider context; provider behavior remains neutral. Do not list unrelated host processes.
    - Core owns process discovery/tracking and termination; expose typed list/kill operations and live updates through the protocol. Cover AI tool-launched processes and workflow Run App processes, rather than only the AI provider host process.
    - Each running entry has a Kill button that terminates the selected managed process and its descendants where applicable, updates the list promptly, and shows actionable errors without affecting unrelated sessions/processes. Handle processes that exit before Kill is clicked.
    - Match Timers panel styling, including count, loading/empty/error states, disabled pending actions, and supported themes. Refresh process state as processes start or exit.
    - Validate process tracking/termination and sidebar behavior with focused checks, including cross-task/workflow visibility, natural exits, descendant cleanup, and isolation of unrelated processes.
  - Context: Existing sidebar integration is in packages/desktop/src/renderer/App.tsx, TimersPanel.tsx, task-panel-state.ts and styles.css; timer protocol/routes are in packages/protocol/src/index.ts and packages/core/src/server.ts. packages/core/src/workflow-app.ts already manages workflow app processes; inspect AI provider/tool process lifecycles for complete coverage.
  - Dependencies: None identified. Implement this high-priority item before lower-priority actionable backlog work.
  - Runner execution: owner=todo-runner-20261012-proc; status=complete; context=managed-process-sidebar; task=ff020776-f19a-4c97-acd6-0ee10731c1c3; branch=feature/todo-001-proc-sidebar; provider=codex; attempt=1; delivery=todo-001-proc-20261012-a1; root-head=846abb4b01b0884287377dcd8f228d50fa78b135; implementation/integrated=0b6f30023550d0749c145279383d97ec64099981; integration=20301abd-8798-4800-9b56-8a4b3f846b8b completed; checks=full build, all typechecks, 881 integration tests; merge-key=ff020776-todo001-0b6f300-smart; task=finished; publishing=pushed origin/refs/heads/dev; published-sha=fdfb9b72bc8d5299ee1ae2f416b46d2e594d2f38; run=complete; fallback=no-op when this run is complete.
  - Session decision: new task for an independent Core/Protocol/Desktop process lifecycle feature; no related queue task exists.
  - Integration recovery: missing candidate dependencies repaired using validated task dependencies; existing 15ms HarnessRunner fanout test failed once, passed focused rerun and final full suite. Post-merge planned-feature notification errored; actual Git/integration/task state confirmed success, no replay.
  - Limitations: full inherited process discovery requires Linux /proc; POSIX fallback has reduced detached-child coverage; native Windows Core discovery unsupported. See docs/PROCESSES.md.

- [x] TODO-002 — Independent workflow chatboxes while another block is busy
  - Priority: High.
  - Scope: Workflow chat / Core runtime / Desktop.
  - Acceptance criteria:
    - In a single workflow run with multiple Chatboxes, allow sending to an idle Chatbox while another Chatbox or agent is working; preserve each block’s existing conversation and route messages to the selected block.
    - Use block-specific sending/running state in the UI and Core admission logic. Prevent duplicate simultaneous turns on the same block without imposing a workflow-wide lock on unrelated idle Chatboxes.
    - Keep concurrent block state, messages, connected-tool delivery, aggregate run status, and completion consistent; submitting to one block must not reset, cancel, or overwrite another active block.
    - Add focused regression coverage for two Chatboxes in one run, busy first/idle second, independent history and responses, and repeated submission to a busy target.
  - Context: packages/desktop/src/renderer/HarnessPanel.tsx BlockRunDetails currently derives busy from run.status; packages/core/src/harness-runner.ts continueChat rejects activeRuns/resumingChats by run ID and active aggregate run status. Trace typed chat routes and runtime/store concurrency before changing them.
  - Dependencies: None; independent outcome.
  - Runner execution: owner=todo-runner-20261012-workflow; status=complete; last-state=done; candidate=a238ce92928f1510aef211abe6f9a8c6fd654b96; merge-key=451433d2-todo002-a238ce9-smart; checks=build/typechecks/full-tests/clean-tree; context=workflow-chat-concurrency; task=451433d2-5f35-44aa-9217-28ce43a5fd96; branch=feature/todo-002-independent-chatboxes; provider=codex; attempt=1; delivery=todo-002-workflow-20261012-a1; root-head=1df0850c389843f7e5e7647b3db2a5f2dd1b4c3e; merge=0f71ed2e-c222-4b5b-aea3-3d5547d21659 completed; integrated=a238ce92928f1510aef211abe6f9a8c6fd654b96; publishing=pushed origin/refs/heads/dev; published-sha=a702ef6d0c6ae529a49f55d24d1f7ea106c84341; integration-recovery=b0a72287 failed missing isolated dependencies, root unchanged, reused validated worker dependencies for integration environment.
  - Session decision: new task for Core runtime concurrency; prior queue task covers unrelated process lifecycle.
  - Result: independent Chatbox turns share runtime/history/tool routing, reject duplicate busy targets and drain before aggregate completion; Stop remains run-wide. Post-merge notification errored; Git/integration/task evidence confirmed success.

- [x] TODO-003 — Float workflow fit controls over the flowchart
  - Priority: Normal.
  - Scope: Workflows panel / Desktop layout.
  - Acceptance criteria:
    - Move horizontal and vertical Fit buttons into an overlay at the bottom-left of the flowchart viewport, removing their dedicated layout row.
    - Keep controls anchored to the viewport while the chart scrolls or scales; retain both fit behaviors and avoid clipping in narrow and expanded workflow views.
    - Provide accessible names, tooltips, keyboard focus, and theme-consistent styling; verify positioning and fit interactions.
  - Context: packages/desktop/src/renderer/WorkflowRunPanel.tsx CompactWorkflowPreview renders workflow-preview-controls before workflow-compact-preview; inspect related styles.css rules.
  - Dependencies: None; independent outcome.
  - Runner execution: owner=todo-runner-20261012-workflow; status=complete; last-state=done; candidate=d2bd3bba05a525bcc0f21b93bb2eaba6843c0d47; merge-key=360d8b4b-todo003-d2bd3bb-smart; context=workflow-desktop-layout; task=360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch=feature/todo-003-workflow-fit-overlay; provider=codex; attempt=1; delivery=todo-003-layout-20261012-a1; root-head=0c0e661bac6f5d445a7aa4f8d704ccadcf914c92; merge=aaaa6338-e276-4de8-9e09-a71690eb149a completed; implementation/integrated=d2bd3bba05a525bcc0f21b93bb2eaba6843c0d47; checks=full build, repository/Gateway typechecks, full tests, fit/keyboard and Chromium CSS positioning checks; publishing=pushed origin/refs/heads/dev; published-sha=35d067d0ad21622ee69fc3afd578da7550b5b307.
  - Session decision: new task for independent Desktop layout; retain it for related workflow card/timer layout items after merge.
  - Result: Horizontal/vertical Fit controls float at the bottom-left of the scrolling chart viewport with keyboard access, tooltips and theme styling. Limitations: Browser positioning verified with a CSS fixture rather than full Electron UI. Post-merge notification errored after confirmed integration.

- [x] TODO-004 — Move New run and Rerun to compact top icon controls
  - Priority: Normal.
  - Scope: Workflows panel / Desktop run controls.
  - Acceptance criteria:
    - Replace New run and Rerun text buttons with compact icon buttons near the top of the workflow card, beside the Run prompt row where present; remove the dedicated row space consumed by those controls.
    - Preserve New run starting-point selection and Rerun semantics, availability, pending disabled state, and selected-run behavior. Keep Stop controls accessible.
    - Add descriptive accessible names and tooltips for both icons; verify behavior for active/completed runs and cards without a run, including narrow layouts.
  - Context: packages/desktop/src/renderer/WorkflowRunPanel.tsx WorkflowCard currently renders workflow-card-actions below the preview; existing interaction coverage is in WorkflowRunPanel.test.tsx. Placement beside Run prompt is the chosen default.
  - Dependencies: None; independent outcome.
  - Runner execution: owner=todo-runner-20261012-workflow; status=complete; last-state=done; candidate=2edbe5176859e10540104ff3765bca753dfd32a7; merge-key=360d8b4b-todo004-2edbe51-smart; context=workflow-desktop-layout; task=360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch=feature/todo-003-workflow-fit-overlay; provider=codex; attempt=1; delivery=todo-004-layout-20261012-a1; root-head=29690a7c1123b1dafef3137a3867129a78ae8c16; merge=f0fea944-c69f-4f7a-8e7e-73a200ca2731 completed; implementation/integrated=2edbe5176859e10540104ff3765bca753dfd32a7; checks=full build, repository/Gateway typechecks, full tests, active/completed/no-run and keyboard interactions, narrow-width Chromium CSS checks; publishing=pushed origin/refs/heads/dev; published-sha=c01feb73d6451ba3623d28772ab68e5e6e0afd56.
  - Session decision: reuse task/provider conversation after confirmed TODO-003 integration; same WorkflowRunPanel/styles/tests and recent layout decisions; no unresolved changes or reset needed.
  - Result: New run and Rerun are compact icons beside Run prompt; starting-point selection, snapshot reruns, pending states and labelled Stop controls remain available; completed cards have no dedicated action row. Limitations: Browser checks use CSS fixtures rather than full Electron UI. Post-merge notification error reconciled against successful integration.

- [x] TODO-005 — Compact armed workflow timers into a single-line status strip
  - Priority: Normal.
  - Scope: Workflow timer status / Desktop layout.
  - Acceptance criteria:
    - Render armed/waiting workflow Timer status as a compact single-line strip with no enclosing border, using a colored left bar to indicate state.
    - Keep timer identity and remaining/due time readable alongside Stop and Run now actions; retain their existing cancellation/immediate-delivery semantics and pending/error feedback.
    - Avoid a large timer card or unnecessary vertical padding. At narrow widths truncate long labels while keeping actions usable; support themes and accessible labels/focus.
    - Apply this to armed timer presentation in the Workflows panel and preserve other permission/question/retry pause presentations; verify timer state transitions and controls.
  - Context: packages/desktop/src/renderer/HarnessPanel.tsx PauseResolution and packages/desktop/src/renderer/WorkflowRunPanel.tsx paused-block rendering; inspect styles.css timer/pause rules. This request concerns workflow armed-timer UI, not a redesign of the separate Timers sidebar.
  - Dependencies: None; independent outcome.
  - Runner execution: owner=todo-runner-20261012-workflow; status=complete; last-state=done; candidate=15fe97e0bd1ce6c584352dcf4044f5b1b98b70e3; merge-key=360d8b4b-todo005-15fe97e-smart; context=workflow-desktop-layout; task=360d8b4b-1b36-4ce8-95b7-9ffd559c4b58; branch=feature/todo-003-workflow-fit-overlay; provider=codex; attempt=1; delivery=todo-005-layout-20261012-a1; root-head=0b6cbba262c61476d2603a3bc6f37d036128fc0a; merge=81225b9a-7dde-4473-abb4-a78163cc8c61 completed; implementation/integrated=15fe97e0bd1ce6c584352dcf4044f5b1b98b70e3; checks=build, repository/Gateway typechecks, full tests, timer cancellation/resume/pending/error/transition regressions, narrow/theme Chromium CSS checks; publishing=pushed origin/refs/heads/dev; published-sha=2571c5ee09ebf3d1947bc6d7c612b19fe2d6c2ce.
  - Session decision: reuse successfully merged clean Desktop task/provider conversation; same workflow card/pause presentation and styles, no reset needed.
  - Result: Armed Workflows timers render as borderless single-line strips with a colored state bar, due time, Stop/Run now actions and pending/error feedback; long labels truncate and other pause layouts remain preserved. Limitations: CSS fixture visual validation rather than full Electron UI. Stop retains existing whole-run cancellation semantics. Post-merge notification error reconciled against successful integration.


-----

Low priority:
Review the communication, for me it looks like the current web socket connection is slow for concurrent requests as all actions are sequenced. So need to rework the connection the way, so the file contents for example, or terminal data, or things where sequence is not required could be parallelized and not wait for each other. If you think it’s bad idea - explain why, if it’s good - implement

- [x] TODO-006 — Review and improve independent WebSocket request concurrency
  - Priority: Low; after the existing workflow bugfix and UI queue.
  - Scope: Desktop/Core WebSocket request concurrency.
  - Request: Actionable tracking for the original “Low priority” communication request above; preserve that original text.
  - Acceptance criteria:
    - Trace request admission, response correlation, event delivery, and any queues in Desktop client and Core routing; establish with a focused delayed-request check whether independent operations actually block each other. Treat global serialization as a hypothesis, not a confirmed cause.
    - If avoidable serialization exists, allow independent requests such as file reads to progress concurrently and ensure terminal output is delivered promptly while an unrelated request is slow; preserve request-ID response matching and error/disconnect handling.
    - Keep required ordering for dependent mutations and per-resource operations, and preserve bounded resource use and backpressure. Avoid blanket parallelization that breaks consistency.
    - Validate out-of-order independent responses and relevant ordered operations with focused coverage. Explain the findings and resulting behavior; if the proposed transport change is unjustified, document the evidence and reason rather than adding unnecessary concurrency.
  - Context: packages/protocol/src/index.ts, packages/core/src/server.ts WebSocket message handler and routing, packages/desktop/src/renderer/client.ts pending-response handling; inspect service queues and renderer call sites as needed. Current Core handler is async, so investigate before assuming the transport serializes every action.
  - Dependencies: None technically; lower scheduling priority than TODO-003 through TODO-005.
  - Runner execution: owner=todo-runner-20261012-workflow; status=complete; last-state=done; candidate=abc48d6137c72be6a8c27a6408e52b7c9d4cefd7; merge-key=daa5a9cd-todo006-abc48d6-smart; context=websocket-request-concurrency; task=daa5a9cd-4e02-4ce7-afc1-795fbcffae41; branch=feature/todo-006-websocket-concurrency; provider=codex; attempt=1; delivery=todo-006-websocket-20261012-a1; root-head=411060c1433da5383b85ad67048e09d1c464cf47; merge=b6402e44-e4f4-4edf-bf13-7fa1935dad58 completed; implementation/integrated=abc48d6137c72be6a8c27a6408e52b7c9d4cefd7; checks=full build, all required typechecks, 904 tests including independent delivery, reverse responses, errors/disconnect and workspace-switch barrier; publishing=pending.
  - Session decision: new task for independent Core/Desktop transport investigation, separate from retired workflow layout task.

  - Result: Real WebSocket/PTY evidence confirms independent fast reads, errors and terminal output arrive during a held slow read, with request-ID correlation and workspace-switch ordering preserved. Added regression tests and findings documentation; transport already concurrent, so no runtime rewrite was justified. Limitations: Tests establish async concurrency, not saturated-network performance or unlimited-load backpressure. Large queued frames/event-loop stalls can still delay delivery; existing service ordering retained. Post-merge notification error reconciled against successful integration.
