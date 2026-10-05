import type { HarnessDefinition } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

export function workflowTemplate(template?: "five-minute-check-in" | "git-review-commit"): Pick<HarnessDefinition, "blocks" | "edges"> {
  if (!template) return { blocks: [], edges: [] };
  if (template === "git-review-commit") return gitReviewCommitTemplate();
  if (template !== "five-minute-check-in") throw new CoreError("INVALID_REQUEST", "Unknown workflow template");
  return {
    blocks: [
      { id: "start", type: "start_button", label: "Start workspace monitor", prompt: "Monitor this workspace every five minutes. Inspect changes, compare with the previous cycle, and suggest a useful next action. Ask me only when a decision genuinely needs my input. Continue until I stop the run.", position: { x: 32, y: 40 } },
      { id: "start-text", type: "start_input", label: "Start with your own goal", prompt: "", position: { x: 32, y: 220 } },
      { id: "check-in", type: "ai", label: "Coordinate each check-in", prompt: `You coordinate a recurring workspace monitor. Preserve the goal from the initial input and compare each check-in with your previous observations.
Latest user decision: {{blocks.user-question.output}}
Previous report: {{blocks.report-agent.output}}
On every invocation:
1. First call workflow_use_block with block_id: "repeat-timer" and input: "Continue monitoring the original goal. Arm the connected Timer again, inspect the workspace, consult the analysis agent, and choose the reporting or user-input path." The Timer block is configured for 300 seconds. Confirm its status is waiting. Arming it returns immediately; keep working. When it fires, its follow connection invokes this same AI block with the supplied input. Use this connected Timer block for scheduling.
2. Use block "monitor-instructions" to read the monitoring guidelines, then use "workspace-snapshot" to inspect the workspace.
3. Use the connected AI block "analysis-agent" with the goal, snapshot, and previous observations. It keeps its own context and returns its assessment.
4. Choose exactly one path with workflow_choose_path: "report" for a normal check-in, or "ask-user" only if a concrete decision needs user input. Output the original goal, a concise assessment, and one useful next action. For "ask-user", also include one clear question.
5. Finish this invocation. Your output passes to the selected path. The Timer's follow connection starts the next cycle in five minutes.`, position: { x: 300, y: 130 } },
      { id: "repeat-timer", type: "timer", label: "Repeat after 5 minutes", seconds: 300, prompt: "", position: { x: 570, y: 40 } },
      { id: "monitor-instructions", type: "text", label: "Monitoring instructions", prompt: "Read the workspace without modifying it. Compare Git changes and the latest commit with the previous cycle. Highlight new changes, blockers, and one concrete next action. If nothing changed, say so briefly. Ask the user only about a specific unresolved decision; avoid repeated questions that were already answered.", position: { x: 570, y: 220 } },
      { id: "workspace-snapshot", type: "script", label: "Read workspace status", prompt: "", command: 'date -u "+%Y-%m-%d %H:%M:%S UTC"\nprintf "\\nWorkspace changes:\\n"\ngit status --short || exit $?\nprintf "\\nLatest commit:\\n"\ngit log -1 --format="%h %s" 2>/dev/null || true', position: { x: 570, y: 400 } },
      { id: "analysis-agent", type: "ai", label: "Analyze changes", prompt: "Analyze the supplied goal and workspace snapshot. Use the connected monitor-instructions Text block for guidelines. Keep your own context so you can compare cycles. Return the meaningful changes, any concrete blocker, whether user input is needed, and one recommended next action. Inspect only; do not modify files.", position: { x: 830, y: 400 } },
      { id: "user-question", type: "user_prompt", label: "Ask for a decision", prompt: "The monitor needs your decision. Read the findings and question below, then type your answer.\n\n{{input}}", position: { x: 830, y: 40 } },
      { id: "report-agent", type: "ai", label: "Write the check-in report", prompt: "Turn the supplied findings or user answer into a short workspace check-in report. Use the connected report-format Text block for formatting. Keep your own context across cycles; remember user decisions. Coordinator findings: {{blocks.check-in.output}}. Include what changed, any blocker or user decision, and one next action. Do not modify files. Finish after reporting; the coordinator's Timer handles the next cycle.", position: { x: 1090, y: 220 } },
      { id: "report-format", type: "text", label: "Report format", prompt: "Write a concise report with three items: Changes, Decision or blocker, Next action. State when nothing has changed. Keep the whole report under 120 words.", position: { x: 1090, y: 400 } }
    ],
    edges: [
      { id: "start-check-in", from: "start", to: "check-in", type: "follow" },
      { id: "text-start-check-in", from: "start-text", to: "check-in", type: "follow" },
      { id: "use-repeat-timer", from: "check-in", to: "repeat-timer", type: "use" },
      { id: "repeat-check-in", from: "repeat-timer", to: "check-in", type: "follow" },
      { id: "use-instructions", from: "check-in", to: "monitor-instructions", type: "use" },
      { id: "use-snapshot", from: "check-in", to: "workspace-snapshot", type: "use" },
      { id: "use-analysis", from: "check-in", to: "analysis-agent", type: "use" },
      { id: "analysis-instructions", from: "analysis-agent", to: "monitor-instructions", type: "use" },
      { id: "report-path", from: "check-in", to: "report-agent", type: "path", label: "report" },
      { id: "question-path", from: "check-in", to: "user-question", type: "path", label: "ask-user" },
      { id: "answer-report", from: "user-question", to: "report-agent", type: "follow" },
      { id: "report-format-tool", from: "report-agent", to: "report-format", type: "use" }
    ]
  };
}

function gitReviewCommitTemplate(): Pick<HarnessDefinition, "blocks" | "edges"> {
  return {
    blocks: [
      { id: "git-start", type: "start_button", label: "Review & commit workspace", prompt: "Inspect all current Git changes without editing workspace files. Commit the existing changes with a meaningful message, then ask me before pushing.", position: { x: 32, y: 280 } },
      { id: "git-review", type: "ai", label: "Review & write commit", prompt: `Use the connected Script blocks to inspect the workspace without editing files:
1. Use git-status, git-diff, git-history, git-remotes, and git-check. Read git-rules too.
2. Review tracked changes and untracked files. git-diff lists untracked paths; inspect their contents using read-only tools before including them. Never execute project code or modify source files. If secrets, unresolved conflicts, suspicious generated files, or unexplained unrelated changes need a decision, stop and report them using the finished path without committing.
3. If there are no changes, choose finished and report that there is nothing to commit.
4. Write a specific imperative commit subject describing the actual changes, plus a short body when helpful. Call git-commit with ONLY the exact commit message as input. This block stages all existing changes and commits them; never pass shell commands as input. Do not amend existing commits.
5. Use git-receipt to inspect the new commit and push destination. Choose ask-push only after a successful commit. Output a concise review, the commit hash/message, and the current branch/upstream (or explain that no upstream exists). The User Prompt will ask permission and the push Script will enforce it. Never push through another tool.`, position: { x: 300, y: 280 } },
      { id: "git-rules", type: "text", label: "Commit review rules", prompt: "Preserve workspace file contents. Inspect staged, unstaged, and untracked changes. Do not run formatters, fixes, builds, or project scripts. Commit only the existing work; never amend, reset, clean, checkout, or force push. Stage all changes only after reviewing them. If the changes include secrets or need clarification, report and stop. Push requires the user's Yes response and an existing upstream.", position: { x: 560, y: 40 } },
      { id: "git-status", type: "script", label: "Branch & changed files", prompt: "", command: 'set -eu\ngit rev-parse --show-toplevel\ngit status --short --branch\nprintf "\\nUntracked files:\\n"\ngit ls-files --others --exclude-standard', position: { x: 560, y: 210 } },
      { id: "git-diff", type: "script", label: "Inspect both diffs", prompt: "", command: 'set -eu\nprintf "Unstaged changes:\\n"\ngit --no-pager diff --no-ext-diff --no-textconv\nprintf "\\nStaged changes:\\n"\ngit --no-pager diff --cached --no-ext-diff --no-textconv\nprintf "\\nUntracked paths (inspect contents before commit):\\n"\ngit ls-files --others --exclude-standard', position: { x: 560, y: 380 } },
      { id: "git-history", type: "script", label: "Recent commit style", prompt: "", command: 'git --no-pager log -8 --format="%h %s"', position: { x: 560, y: 550 } },
      { id: "git-remotes", type: "script", label: "Check push destination", prompt: "", command: 'set -eu\ngit branch --show-current\ngit remote -v\nprintf "\\nUpstream:\\n"\ngit rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null || printf "No upstream configured; push will be skipped.\\n"', position: { x: 820, y: 40 } },
      { id: "git-check", type: "script", label: "Whitespace & conflicts", prompt: "", command: 'set -eu\nprintf "Unmerged paths:\\n"\ngit diff --name-only --diff-filter=U\nprintf "\\nUnstaged whitespace check:\\n"\nif git diff --check; then printf "OK\\n"; else printf "Review warnings above.\\n"; fi\nprintf "\\nStaged whitespace check:\\n"\nif git diff --cached --check; then printf "OK\\n"; else printf "Review warnings above.\\n"; fi', position: { x: 820, y: 210 } },
      { id: "git-commit", type: "script", label: "Stage & create commit", prompt: "", command: 'set -eu\ntest -n "$VIBE_WORKFLOW_INPUT" || { printf "Missing commit message\\n" >&2; exit 1; }\ntest -n "$(git symbolic-ref -q HEAD)" || { printf "Detached HEAD; refusing to commit\\n" >&2; exit 1; }\ntest -z "$(git ls-files --unmerged)" || { printf "Resolve conflicts before committing\\n" >&2; exit 1; }\ngit add -A\nif git diff --cached --quiet; then printf "No changes to commit.\\n"; exit 1; fi\nprintf "%s\\n" "$VIBE_WORKFLOW_INPUT" | git -c core.hooksPath=/dev/null commit -F -\ngit --no-pager log -1 --format="%H%n%B"', position: { x: 820, y: 380 } },
      { id: "git-receipt", type: "script", label: "Verify new commit", prompt: "", command: 'set -eu\ngit --no-pager show --no-ext-diff --no-textconv --stat --format=fuller HEAD\nprintf "\\nRemaining workspace changes:\\n"\ngit status --short --branch\nprintf "\\nPush destination:\\n"\ngit rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null || printf "No upstream configured.\\n"', position: { x: 820, y: 550 } },
      { id: "git-push-question", type: "yes_no_prompt", label: "Approve push?", prompt: "{{input}}\n\nPush this commit to the current branch's configured upstream? Choose Yes to push or No to keep the commit local. No upstream means push is skipped.", position: { x: 1090, y: 210 } },
      { id: "git-push", type: "script", label: "Push only with approval", prompt: "", command: 'set -eu\nif [ "$VIBE_WORKFLOW_INPUT" != "yes" ]; then printf "Push skipped: user did not approve.\\n"; exit 0; fi\nbranch=$(git symbolic-ref --quiet --short HEAD) || { printf "Push skipped: detached HEAD.\\n"; exit 0; }\nremote=$(git config --get "branch.$branch.remote") || { printf "Push skipped: no upstream remote.\\n"; exit 0; }\nmerge=$(git config --get "branch.$branch.merge") || { printf "Push skipped: no upstream branch.\\n"; exit 0; }\ngit -c core.hooksPath=/dev/null push -- "$remote" "HEAD:$merge"\nprintf "\\nPush completed.\\n"', position: { x: 1090, y: 380 } },
      { id: "git-finished", type: "ai", label: "Commit & push report", prompt: "Summarize the supplied result and review: {{blocks.git-review.output}}. State whether a commit was created and whether push succeeded, was declined, or was skipped. Include the commit hash/message if available. Do not run tools or modify anything.", position: { x: 1350, y: 280 } }
    ],
    edges: [
      { id: "git-start-review", from: "git-start", to: "git-review", type: "follow" },
      ...["git-rules", "git-status", "git-diff", "git-history", "git-remotes", "git-check", "git-commit", "git-receipt"].map((id) => ({ id: `review-use-${id}`, from: "git-review", to: id, type: "use" as const })),
      { id: "git-ask-push", from: "git-review", to: "git-push-question", type: "path", label: "ask-push" },
      { id: "git-no-commit", from: "git-review", to: "git-finished", type: "path", label: "finished" },
      { id: "git-answer-push", from: "git-push-question", to: "git-push", type: "follow" },
      { id: "git-push-report", from: "git-push", to: "git-finished", type: "follow" }
    ]
  };
}
