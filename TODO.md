# Vibe Editor roadmap

This is a candidate roadmap for the remote-first, AI-first experiment described in
[WHY.md](WHY.md). It records product gaps, not every possible IDE feature. `Now`,
`Next`, and `Later` indicate suggested order, not commitments. Each item is tagged
**Small** (a bounded usability improvement) or **Project** (protocol and/or
multi-surface work).

## Recently completed

- **Quick Open:** fuzzy, keyboard-first workspace file navigation (`Ctrl/Cmd+P`).
- **Problems navigation:** text/severity filtering plus keyboard traversal and
  editor navigation.
- **Editor status bar:** live cursor, selection, language, and indentation details.
- **Keyboard tab navigation:** wraparound `Ctrl+Tab` / `Ctrl+Shift+Tab` navigation.
- **Find in Files:** grouped results with every occurrence reported per matching line.

## Now

### Project foundations

- [x] **Make `AGENTS.md` a compact coding and navigation guide — Small.** Value:
  reduce agent search/token cost while keeping changes consistent with the package
  boundaries, SOLID design, useful abstractions, reuse, and repository structure.
  Constraint: audit current adherence first, document only repository-specific rules
  that change decisions, and prefer short routing examples over a generic coding
  bible. Treat agent navigation and token efficiency as the first priority.

### Project and filesystem control

- [ ] **Project-tree create file/folder and rename/move — Project.** Value: make
  routine repository changes possible without dropping to a terminal. Constraint:
  add typed Protocol operations first, then Core boundary/symlink validation and
  Desktop actions; update open tabs, persisted paths, Java roots, and file colors
  atomically after a move.
- [ ] **Safe delete with recovery — Project.** Value: let users clean up files and
  directories confidently. Constraint: define remote-host trash semantics and a
  clear permanent-delete fallback; show the resolved target and affected children,
  reject workspace-root/symlink escapes, and never silently discard a dirty buffer.
  Depends on the shared mutation API above.
- [x] **Project-tree context menu and keyboard actions — Small.** Value: expose
  create, rename, delete, and open actions where users expect them. Constraint:
  commands must share one selection/action model and remain keyboard accessible;
  disable unsupported actions rather than emulating filesystem work locally.
- [x] **Copy relative/absolute path and reveal active file — Small.** Value: speed
  terminal, issue, and AI handoffs and reconnect the editor with a large tree.
  Constraint: relative paths are workspace-relative; absolute paths explicitly
  identify the remote machine and use the Electron clipboard bridge. Revealing must
  expand ancestors without replacing the user's remaining expansion state.
- [ ] **Actionable external-change conflicts — Project.** Value: replace the current
  dirty-buffer warning with compare, reload, overwrite, and save-as choices.
  Constraint: carry file identity/version metadata through Core so stale saves are
  detected server-side; preserve the current safe auto-reload behavior for clean
  buffers.

### Git workflows

- [ ] **Explicit stage/unstage for files and hunks — Project.** Value: support
  deliberate index-based review instead of using commit-time path selection alone.
  Constraint: distinguish index, worktree, untracked, and conflict states in the
  protocol; apply patches against the exact blob/version and refresh on mismatch.
  This is the foundation for amend and richer conflict workflows.
- [ ] **Remote tracking summary and fetch — Project.** Value: show upstream,
  ahead/behind counts, last fetch, and a visible Push/Fetch state before users act.
  Constraint: Git/network work stays on Core, is cancellable where possible, and
  reports authentication/progress without exposing credentials. Extend the current
  ahead-only status before adding pull/rebase UX.
- [ ] **Commit follow-ups: amend, copy hash/message, undo last local commit — Project.**
  Value: cover common review corrections without terminal commands. Constraint:
  only offer history-rewriting actions when repository state is understood; preview
  affected commit/index state and require confirmation if a commit may be published.
  Depends on explicit index operations and remote tracking.
- [x] **Git Changes keyboard and selection polish — Small.** Value: make diff review,
  stage/unstage, rollback, and commit reachable without pointer-heavy tree traversal.
  Constraint: focus, selection, and checked-for-commit paths must remain distinct;
  destructive shortcuts always retain confirmation.

### Editor and navigation

- [x] **Pin tabs and preserve preview intent — Small.** Value: keep reference files
  stable while navigating rapidly with Quick Open and search. Constraint: define
  pinned-tab ordering and persistence before adding preview-tab replacement; never
  close or replace dirty tabs implicitly.
- [ ] **Unified command palette — Project.** Value: make Project, Git, terminal,
  task, AI, and editor actions discoverable from one keyboard surface. Constraint:
  use a typed command registry with context/enablement metadata rather than UI event
  strings. Build after filesystem and Git commands have stable action contracts.
- [ ] **Workspace symbols and recent locations — Project.** Value: complement file
  search with fast code-level navigation and back/forward history. Constraint: use
  remote language/search services and bounded result sets; do not transfer or index
  the whole repository in Desktop.

### Search

- [ ] **Find-in-files include/exclude controls and replace preview — Project.** Value:
  make repository-scale refactors practical. Constraint: Core owns glob/ignore
  evaluation; replacements require a per-file preview, changed-file/version checks,
  binary exclusion, and one confirmed batch write.
- [x] **Search match context — Small.** Value: make individual search hits easier to
  interpret. Constraint: preserve truncation visibility and stream/page results
  before raising current limits.

## Next

### Project and filesystem control

- [ ] **Duplicate and move/copy via multi-select — Project.** Value: enable common
  bulk organization work. Constraint: introduce stable multi-selection and a
  preflight summary for collisions, overwrites, case-only renames, cross-device
  moves, partial failures, and dirty/open files. Depends on safe single-path
  mutations.
- [ ] **Remote upload/download — Project.** Value: move assets and artifacts between
  the local control surface and remote workspace without a separate SFTP client.
  Constraint: use a streaming, cancellable, size-limited transfer channel rather
  than WebSocket JSON payloads; make overwrite, permissions, symlinks, partial files,
  and destination trust explicit. Keep Gateway deployment artifacts separate from
  project-file transfer.
- [ ] **Watcher health and burst UX — Project.** Value: keep the tree/editor reliable
  during branch switches, generators, and large AI edits. Constraint: coalesce
  events, surface watcher degradation/overflow, and reconcile from a Core snapshot;
  never infer final state only from event order.

### Git workflows

- [ ] **Pull with merge/rebase choice — Project.** Value: synchronize branches with
  an understandable preview and outcome. Constraint: fetch first, display incoming
  commits and dirty-state blockers, avoid implicit auto-stash, and preserve recovery
  instructions. Depends on remote tracking/fetch.
- [ ] **Stash manager — Project.** Value: temporarily shelve selected or full working
  state while switching tasks/branches. Constraint: explicitly cover staged,
  unstaged, untracked, and ignored files; preview apply/pop conflicts and retain a
  stash on failed application.
- [ ] **Conflict resolution workspace — Project.** Value: turn conflicted status rows
  into navigable ours/base/theirs/result resolution and guided continuation/abort.
  Constraint: Core detects the active operation (merge, rebase, cherry-pick, stash),
  validates every resolved path, and exposes native Git continue/abort safely.
  Depends on index operations; precedes polished merge/rebase flows.
- [ ] **Branch management: create, delete, publish, upstream — Project.** Value:
  complete the current checkout/rename selector for everyday branch lifecycle work.
  Constraint: protect checked-out/task-worktree branches, distinguish local and
  remote deletion, preview unmerged commits, and require explicit confirmation for
  force or remote actions.
- [x] **Tag browsing and bounded create/delete — Small.** Value: make release and
  checkpoint refs visible in existing history/compare surfaces. Constraint: annotate
  local versus remote effects and refuse ambiguous ref names; pushing/deleting remote
  tags is a separately confirmed action.

### Terminal

- [x] **Rename, reorder, and duplicate terminal tabs — Small.** Value: keep multiple
  long-running remote shells understandable. Constraint: persist display metadata
  separately from PTY identity and retain the current rule that closing a tab ends
  its Core process.
- [ ] **Terminal recovery clarity — Project.** Value: distinguish a live reattach from
  a recreated shell after reconnect/task switch. Constraint: Core remains process
  owner; show exit/recreation reason and working-directory limitations instead of
  implying shell state was restored.
- [ ] **Command/task terminal links — Small.** Value: jump from run, build, or AI
  activity to its exact terminal. Constraint: references are workspace-scoped and
  tolerate expired terminal IDs.

### Tasks and AI

- [ ] **Task lifecycle filters, rename, and archive — Project.** Value: keep durable
  AI workspaces manageable as their count grows. Constraint: rename display metadata
  separately from Git branches; archive must not delete worktrees or unpublished
  commits, and deletion keeps its existing safety checks.
- [ ] **Review queue for AI changes — Project.** Value: turn prompt checkpoints into
  a file/hunk accept, restore, and follow-up loop. Constraint: Core snapshots remain
  authoritative, edits after a checkpoint are never overwritten without a three-way
  comparison, and actions compose with Git index state.
- [ ] **Prompt provenance and handoff summary — Small.** Value: make model, agent,
  attachments, usage, and resulting checkpoint easy to audit or continue. Constraint:
  redact secrets and keep large logs/content server-side with bounded retrieval.

### Settings and accessibility

- [ ] **Keyboard shortcut settings and conflict detection — Project.** Value: make
  the growing keyboard-first surface adaptable. Constraint: commands use stable IDs,
  OS conventions are preserved, reserved Electron/Monaco bindings are identified,
  and settings migrate safely.
- [ ] **Accessible focus, labels, contrast, and reduced motion pass — Project.** Value:
  make dialogs, trees, splitters, status, and AI permission flows usable without a
  mouse or animation. Constraint: test semantic focus order and screen-reader names
  across Electron platforms; never convey Git/AI state by color alone.
- [x] **Settings search and workspace override indicators — Small.** Value: make
  persisted UI choices easier to find and reset. Constraint: clearly distinguish
  global defaults, per-workspace values, and remote Core-owned configuration.

## Later

### Git, editor, and search

- [ ] **Interactive rebase planner — Project.** Value: offer reorder, squash, fixup,
  reword, and drop for unpublished commits. Constraint: require clean-state and
  upstream safety checks, preview the todo list, preserve reflog-based recovery, and
  route conflicts through the conflict workspace. Depends on remote tracking,
  amend, and conflict resolution.
- [ ] **Merge branch/tag from history — Project.** Value: complete the graph-to-action
  workflow. Constraint: preview merge base and incoming commits, never auto-commit
  unresolved conflicts, and expose abort/recovery. Depends on conflict resolution.
- [x] **Saved searches and search history — Small.** Value: retain useful remote
  investigation queries per workspace. Constraint: store compact query metadata,
  not result contents or sensitive file excerpts.
- [ ] **Multi-root workspace model — Project.** Value: support related repositories
  on one remote machine without pretending they are local folders. Constraint: every
  protocol path gains an explicit root identity and Git/task/state boundaries remain
  unambiguous; pursue only after single-root file mutation and transfer semantics are
  solid.

### Gateway and remote workflow

- [ ] **SSH key/agent and host-key verification UX — Project.** Value: replace the
  password-only path with safer, more common remote authentication. Constraint:
  never copy private keys into project/Core state; show fingerprints and changed-key
  failures explicitly, using OS-backed secret storage only where needed.
- [ ] **Provisioning logs, cancellation, and repair — Project.** Value: make remote
  clone/install/build/start failures diagnosable and recoverable. Constraint: stream
  bounded redacted logs, distinguish retryable stages, and never reset the configured
  project repository (only the dedicated Vibe application checkout).
- [ ] **Version compatibility and controlled updates — Project.** Value: prevent a
  cached Desktop from silently speaking an incompatible protocol to Core. Constraint:
  add an explicit handshake/version range before offering update or rollback; verify
  transferred artifacts and preserve the last known-good client.
- [x] **Connection resilience and latency indicators — Small.** Value: explain slow,
  reconnecting, tunneled, or offline states across Desktop and Gateway. Constraint:
  avoid aggressive retry loops and distinguish SSH tunnel health from Core health.
- [ ] **Workspace discovery and path validation — Small.** Value: reduce setup errors
  when configuring a remote project. Constraint: remote browsing occurs over the
  authenticated Gateway connection, is bounded to intended locations, and never
  grants Desktop direct filesystem ownership.

## Roadmap guardrails

- Keep filesystem, processes, Git, language services, agents, and durable task state
  on Core; Desktop remains a typed, reconnectable control surface.
- Add cross-boundary behavior in dependency order: ACP/Protocol contracts, Core
  implementation and tests, then Desktop/Gateway callers and UI tests.
- Treat destructive, history-rewriting, remote-network, and bulk actions as
  previewable operations with explicit targets, confirmations, partial-failure
  reporting, and a recovery path.
- Prefer small composable capabilities that strengthen human review of AI work over
  broad enterprise administration or local-first filesystem abstractions.
