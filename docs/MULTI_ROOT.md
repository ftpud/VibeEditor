# Multi-root protocol boundary

Core assigns each registered canonical remote directory a stable `WorkspaceRootId`.
Desktop never derives an identity from a local path. Protocol v3 applies these rules:

- Every root-owned request except handshake and root registration carries `Request.rootId`.
  Core validates it against the connection's selected root before dispatch, and root
  switching is serialized with other requests. Nested relative paths, terminal IDs,
  Git refs, task IDs, checkpoint IDs, replacement previews, recovery IDs, and transfer
  tickets inherit this enforced request root; their success response repeats the same
  `rootId`. A mismatched response is rejected by Desktop.
- Every asynchronous filesystem, Git, terminal, run-config, Java/JDT, AI, task,
  checkpoint, commit-message, and task-state event carries `payload.rootId`. Core binds
  process IDs and watchers when they are created rather than recovering ownership from
  a later selected path. Desktop centrally ignores stale non-terminal events. Inactive
  terminal output remains safe because it is addressed by both root and terminal ID;
  inactive filesystem changes only mark tabs of that root for reconciliation.
- Search results and Java diagnostics/symbol locations carry their own `rootId` because
  they can outlive the request UI. Editor navigation-history entries and editor/terminal
  tabs retain the same stable owner; tabs and cross-root results display its alias.
  Activating a foreign-root item switches Core first, then refreshes or sends input.
- Root-specific Git, tasks, checkpoints, workspace options, Java/JDT, searches, useful
  files, agents, terminals, run configurations, and transfers are constructed from the
  validated canonical root or its validated task worktree. Late Desktop responses are
  guarded by the root captured when the request was issued.
- App-tool transport uses the launch root only as a shared command channel. Commands
  retain their current remote workspace, are mapped back to a registered root, and are
  dispatched with that root's task and agent stores.

Legacy workspace option files contain only relative paths. They are loaded solely by
the primary root's path-derived state store. They are never copied or guessed into a
new root. On first use the root registry contains only that primary canonical path.

Removing a root unregisters metadata only. Core refuses removal of the primary or
selected root and roots with task worktrees, persisted open files, terminal sessions,
or transfer tickets. Desktop additionally refuses roots with live editor or terminal
tabs. No removal operation deletes the registered directory.
