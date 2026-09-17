# Harness implementation plan

Harnesses provide a visual, observable alternative to a single AI chat. Definitions and run state belong to Core; Desktop edits and displays them through the typed protocol. Execution must reuse the existing provider-neutral ACP registry, provider adapters, agent files/presets, MCP assembly (`withAppTools`), permission flow, and provider descriptor metadata used by the AI tab. Harness code may add isolated session ownership and orchestration around that path, but must not fork or replace it.

## Phase 1 — durable definitions and visual editor (in progress)

- [x] Define provider-neutral harness, block, edge, and run snapshot types in the protocol.
- [x] Add Core-owned, workspace-scoped persistence with list/create/update/delete operations.
- [x] Add a Harness tool-window tab in both Classic and AI-focused layouts.
- [x] Add create, select, rename, and delete controls.
- [x] Add a visual block canvas with draggable prompt blocks and dependency connectors.
- [x] Add block editing for label, provider, model, agent preset, and prompt template.
- [x] Add an initial prompt entry point and explicit save/run controls.
- [x] Add Core-store tests for persistence, workspace isolation, versioning, and basic CRUD conflicts.
- [ ] Add focused component tests and graph-validation tests once execution validation lands.

## Phase 2 — execution engine

- [x] Validate graphs before a run: unique IDs, existing edge endpoints, duplicate/self edges, acyclic dependencies, and at least one entry block.
- [ ] Compile the graph into a dependency-aware execution plan; run independent ready blocks concurrently with a configurable limit.
- [x] Resolve `{{input}}` and `{{blocks.<id>.output}}` variables without executing arbitrary templates.
- [ ] Start each AI block in an isolated Core-owned session/worktree context so same-provider parallel blocks cannot overwrite one another.
- [ ] Resolve each block's provider, model, reasoning level, agent preset, MCP set, timeout, and retry policy from descriptor metadata.
- [ ] Route block dispatch through the same ACP `send` request shape and `withAppTools` agent/MCP setup as the AI tab; cover compatibility with shared fake-provider integration tests.
- [x] Persist bounded run snapshots separately from editable definitions and stream block/run changes to Desktop.
- [ ] Extend the implemented start/cancel operations with retry-block, resume, and rerun-from-block.
- [x] Stream run/block state events for queued, running, succeeded, failed, and cancelled states with bounded persisted history.
- [ ] Handle permission and user-input pauses with ownership tied to harness run and block IDs.

## Phase 3 — richer orchestration

- [ ] Add fan-out, join, conditional, transform, human-approval, and reusable sub-harness blocks.
- [ ] Define join semantics (`all`, `any`, failure tolerance) and typed input/output ports.
- [ ] Allow an agent block to launch one or more child blocks and wait for their result.
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

The first implementation establishes the durable schema and working visual authoring UI. The Run button records the intended input in the UI but remains disabled until the isolated execution/session layer in Phase 2 is complete; dispatching a graph through the existing single conversation would make parallelism and block attribution incorrect.
