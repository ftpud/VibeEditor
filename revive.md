# Kapeh revival handoff

Resume this repository as the **Kapeh feature dispatcher**. The standing user goal is to keep improving Vibe Editor by implementing items from `TODO.md`, marking completed items accurately, and then proposing/implementing sensible new product improvements. Continue autonomously until the user explicitly ends the goal.

## User operating requirements

- Coordinate implementation through Vibe Editor tasks; do not implement feature branches directly in the dispatcher session.
- Dispatch every implementation task to the local `Oleg.md` agent with exactly:
  - provider: `codex`
  - model: `gpt-5.6-terra`
  - reasoning: `low`
  - agent: `{ "scope": "local", "name": "Oleg.md" }`
- Task prompts must state which bounded part is being implemented and that Terra/low is used.
- Multiple tasks may run in parallel when quota is healthy, but normally cap concurrency at 2–3 and choose non-overlapping feature surfaces to minimize merge conflicts.
- When quota is low, stop dispatching early enough for every active task to finish, merge, test, and build. The user permits using quota down to roughly 6–8% before standby.
- Monitor task status, inspect each final response, merge each task branch into `dev`, and mark the Vibe task `finished` only after merge.
- Keep the dispatcher alive while tasks execute. Poll statuses periodically without wasting tokens.
- At the end of every integration batch, run `npm test && npm run build`. Do not call a batch complete if the merged repository does not build.
- Create stable checkpoint branches named `PI_<number>` only from fully merged, verified `dev` commits. Near 10–12% quota remaining, drain work first, build, then create the next unused checkpoint branch.
- Prioritize token efficiency and bounded tasks. Use difficult models/reasoning only if the user changes the dispatch configuration.

## Mandatory quota revival loop

At the start of every fresh/revived turn:

1. Call Vibe Editor `ai_usage` for provider `codex`.
2. Read `account_quota.primary.resets_at`.
3. Immediately set/replace the Vibe Editor timer to fire a few seconds after that reset.
4. The timer continuation prompt must itself say to repeat steps 1–3 before resuming work. This makes the timer self-renewing across quota windows and machine/backend restarts.
5. Then list active tasks and resume draining/dispatching.

Recommended timer prompt:

> Quota reset revival: FIRST call ai_usage, read the new primary resets_at, and immediately set/replace a timer for that new reset time with these same self-renewal instructions. THEN inspect active Vibe Editor tasks, finish/merge/build them, mark finished tasks, and dispatch non-conflicting TODO improvements while quota is healthy (2–3 concurrent max). Stop new dispatch early enough to drain. Near 10–12% remaining, drain all tasks, require npm run build, then create the next unused PI_<number> branch.

Do not trust the old reset timestamp after migration; query it again.

## Task workflow

For each feature:

1. Read `TODO.md` and inspect current source behavior. Some roadmap checkboxes may be stale, so audit before implementing.
2. Select a bounded, valuable item and avoid files owned by concurrent tasks.
3. Create and start a Vibe task with the fixed provider/model/reasoning/agent settings above.
4. Instruct the task agent to add focused tests, update only its assigned TODO checkbox, commit all changes, and report commit hash and verification.
5. Poll `task_list`; use `task_ai_response_tail` when done.
6. Merge with `git merge --no-ff <task-branch> -m "Merge <task-branch>"` on `dev`.
7. Mark the Vibe task finished.
8. After the batch, run the complete test suite and build, then create the next `PI_<number>` checkpoint when appropriate.

Preserve existing user changes. Never reset or destructively clean the worktree.

## Repository rules

- Node 20+ npm-workspaces monorepo.
- Source lives under `packages/*/src`; never hand-edit generated `dist*`, `node_modules`, `.tools`, or `.electron-runtime`.
- Dependency direction: `acp -> protocol -> core/desktop`; Gateway is separate.
- Cross-boundary changes go Protocol first, then Core, then Desktop.
- Core owns filesystem/process/Git/search/task/durable state. Desktop is a typed WebSocket control surface.
- Read the repository `AGENTS.md` before acting and follow it.
- Main verification: `npm test && npm run build` from repository root.

## Current state at handoff

- Current branch: `dev`.
- Worktree was clean at handoff.
- `dev` is 2 commits ahead of `origin/dev`.
- Latest verified commit: `9e8438638b12b1f4e01a2df055355cfd2ac34d01` (`Merge feature/pinned-tabs`).
- Stable checkpoints:
  - `PI_1` at `2ced2e5f4955292702221ce3e9190b6c3dd364ef`
  - `PI_2` at `9e8438638b12b1f4e01a2df055355cfd2ac34d01`
- No implementation task was active at the last completed batch.
- Last full verification passed: 136 Core tests, 92 Desktop tests, 2 Gateway tests, and the full five-workspace build.

## Features completed during this dispatcher run

- Project-tree context menu and keyboard actions.
- Copy workspace-relative/remote-absolute paths and reveal active file.
- Bounded surrounding context in Find in Files, with explicit truncation indicators.
- Gateway SSH/Core/tunnel connection-health and latency indicators.
- Git Changes keyboard navigation and distinct focus/active/checked states.
- Persisted pinned editor tabs with stable pinned-first ordering and close protection.
- Earlier merged work already present includes project-tree create/rename operations, task finished status, Quick Open, Problems navigation, editor status bar, keyboard tab navigation, and grouped multi-occurrence Find in Files.

## Important roadmap audit note

`TODO.md` still shows **Project-tree create file/folder and rename/move** unchecked even though earlier work implemented create file, create directory, and rename operations. Before claiming that item complete, audit whether the full promised move-related atomic updates (open tabs, persisted paths, Java roots, file colors) are actually complete. Do not blindly check it off.

Good next bounded candidates include:

- `Make AGENTS.md a compact coding and navigation guide` (audit first; documentation rather than product functionality).
- `Rename, reorder, and duplicate terminal tabs` (small, contained terminal surface).
- `Tag browsing and bounded create/delete` (small but requires careful Git safety).
- `Settings search and workspace override indicators` (small, settings surface).
- `Prompt provenance and handoff summary` (small, AI/task surface).

Avoid starting a large Project item late in a quota window. When the quota resets and is healthy, 2–3 independent tasks can be dispatched across separate surfaces.
