# Task Git prompt history

Prompt History shows which files changed during each AI prompt. Open a text change
to review its diff, or restore the recorded changes after stopping the agent and
saving your editor buffers. Task Git separately compares the task with its base
branch.

## What a checkpoint records

Task Git records a durable filesystem checkpoint when a user prompt starts and
completes it when the corresponding ACP turn finishes, fails, or is interrupted.
Each history item has stable checkpoint and prompt IDs, provider/session metadata,
timestamps, status, redacted prompt text (up to 1,000 characters), optional
model/reasoning/agent/attachment/usage/commit provenance, and its added, modified,
deleted, or renamed files. Steering prompts received during a running turn are
recorded separately, but because they share one live agent turn their final
filesystem point can overlap.

## Where snapshots are stored

Snapshots are owned by Core under `REMOTE_IDE_STATE_DIR` (normally `~/.remote-
ide/workspaces`). They use content-addressed raw-file blobs and JSON manifests
outside the task worktree and `.git`; no commits, hidden refs, stashes, or index
entries are created. Tracked files and non-ignored untracked files are captured,
including deletions, executable modes, symlinks, and binary bytes. Ignored files,
directories, special files, and Git staging state are not captured.

## Review and restore changes

The separately openable Prompt History panel groups files beneath each prompt, while
Task Git remains focused on the task's comparison with its base branch. Text changes
open in the diff editor; binary changes are identified but do not have a textual
diff. Restore applies the selected checkpoint's changed files from their before-
state to their completed after-state while leaving HEAD, branches, refs, commits,
and the index untouched. Review can apply selected files instead. Files already at
the after-state are skipped; changes that conflict with the current filesystem are
reported rather than overwritten. Unrelated files are left alone. Restore is
disabled for running checkpoints and Core rejects restore while any provider session
in that task is active. Stop the agent and save any editor buffers before restoring.

## Retention and restart recovery

Core serializes capture and restore per workspace. It retains the newest 100
completed prompt checkpoints plus all running checkpoints per workspace. Older
manifests and blobs no longer referenced by retained checkpoints are removed.
Deleting a Vibe task removes its task state directory, including prompt history,
through the existing task cleanup. If Core restarts during a turn, it closes the
orphaned running checkpoint as interrupted using the filesystem state found at
startup.
