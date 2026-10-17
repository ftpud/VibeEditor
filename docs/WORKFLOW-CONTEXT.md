# Workflow context limits

Workflow blocks keep separate provider sessions. Invoking a connected AI or
Chatbox continues its session without copying the parent's conversation.
New sessions receive block instructions and a connected tool catalogue. Chatbox
instructions and runtime guidance are delivered through the session's agent
instructions, alongside any selected agent preset, rather than as user messages.
They appear under Instructions in the context inspector. A Chatbox's `{{input}}`
placeholder refers to the current user message; it does not cause its instructions
to be repeated on each turn. Follow-up messages contain the new user input, plus
bounded updates for explicitly referenced block outputs. Those updates omit the
surrounding instruction template. AI Agent blocks retain dynamic prompt templates.
Later turns omit the runtime manual and static instructions, with these bounds:

## Context transfers

- Dynamic `{{blocks.ID.output}}` references receive bounded previews: at most
  8,000 characters per referenced output and 20,000 characters across expanded
  output references. Unchanged outputs become short references to the earlier
  result in that caller's session. Changed outputs are sent again. Fingerprints
  are recorded from the data actually available when the prompt was rendered.
- AI and Chatbox inputs are capped at 20,000 characters. Fan-in joins divide
  that budget among direct predecessors, retaining each source's label.
  Declared structured input schemas retain their exact input and the existing
  rendered-prompt limit; document and script data are not shortened.
- Workflow tool results have a 20,000-character serialized result limit.
  Large strings become head/tail previews with truncation notices; large
  collections receive a bounded JSON preview if their structure cannot fit.
  App, terminal and task results keep their structured shape when possible
  and avoid duplicating the same result in an escaped `output` string.
- `workflow_block_output` reads retained output from a connected block without
  invoking it. Pass `block_id`, `offset` (default 0) and `limit` (1–8,000).
  Follow `nextOffset` to inspect further pages. This exposes the existing
  retained output, subject to run-state retention limits, not an unlimited
  archive. Linked skills must use the normal skill loader to check live policy.
- Polling messages retain at most 8,000 characters each, within the aggregate
  result limit. Repeated identical polls and direct tails return
  `unchanged: true`. Changed snapshots omit individual messages and activity
  already delivered to that caller. `include_unchanged: true` on
  `workflow_block_messages` explicitly rereads the snapshot. Read-only AI polls,
  output reads and connection listings do not add operation journal entries.
- Skill instructions are delivered intact on their first load. Repeated
  unchanged loads return a compact acknowledgement. Native skill loading
  always checks current policy and content revision first; a new catalogue or
  conversation reloads instructions. Workflow skill loads likewise validate
  policy before suppressing an identical result.

Previews are deterministic truncation, not semantic summaries. Outputs remain
in workflow state under the existing output retention policy. Agents should
request concise worker reports and send new facts rather than forwarding
previous reports repeatedly. Terminal Control is for long-running apps and
services; agents should list and reuse terminals whenever possible, avoid
unnecessary new terminals, and never spawn agents inside them.

## Long-lived conversations

`settings.contextBudgetChars` bounds cumulative context delivered through a
workflow block. It defaults to 400,000 characters per block per run and accepts
1,000–10,000,000. Core persists `deliveredContextChars` alongside block state,
counting prompts, assistant reports and projected workflow tool results,
including polling. Reaching the budget stops delivery with an explicit error
instructing the user to start a new run with a concise handoff or increase the
budget. The conversation is preserved. This is a conservative character budget,
not a provider token estimate; provider-native tool traffic is outside this
counter. Existing prompt, attempt, run-duration and token budgets still apply.

Core does not automatically reset provider history or attempt provider-specific
compaction. The local transcript retention of 1,000 provider messages and 200
Chatbox messages is separate from model context capacity. Provider compaction
can still occur. After a Core restart, context fingerprints may be rebuilt and
an unchanged value may be delivered once again; the persisted cumulative budget
still applies.

The operation journal grows with actual workflow actions. Recovery and
idempotency evidence are retained rather than deleting old actions to reduce
conversation context.

## Shared Meeting blocks

Connect each AI Agent or Chatbox to a **Meeting** block using **Use**. The block
stores an attributed discussion in Core for that workflow run; it does not start
participants when messages arrive. Agents use `workflow_use_block` with:

```json
{"block_id":"meeting","action":"publish","message":"Here is my proposal."}
{"block_id":"meeting","action":"tail","lines":20}
{"block_id":"meeting","action":"diff","lines":20}
{"block_id":"meeting","action":"wait","timeout_seconds":300}
```

`tail` reads recent messages. `diff` reads new messages since that participant's
last read; omitted action also means `diff`. Each participant has an independent
cursor persisted with the run. `wait` returns unread messages immediately or holds
until another message is published, without polling. It returns `status: "updated"`
or `status: "timed_out"` inside `meeting` with the normal diff fields. It accepts
`lines` and `after`; `timeout_seconds` overrides the connection timeout (default
300 seconds, maximum 86,400). Waiting releases workflow execution capacity, so
other participants can publish even with concurrency one. Run cancellation and
Core shutdown release pending waits. For replay, supply `after` with a sequence number,
then use each returned `cursor` as the next `after`. Explicit replay never rewinds
the participant's saved cursor. Results are under `meeting`, including `messages`,
`cursor`, `latestSequence`, `hasMore`, and `historyTruncated`. Read further diff
pages while `hasMore` is true. Pages preserve complete messages within the context
budget. `lines` is 1–50 (default 20). Publishing accepts at most 10,000 text
characters and 16,000 serialized characters including author metadata.

The Meeting run panel shows the transcript with author, model and timestamps.
The latest 1,000 messages are retained; `historyTruncated` indicates expired unread
history. Meetings and read positions are isolated between workflow runs.

## Blocks and their actions

Actions available to a calling AI Agent or Chatbox through `workflow_use_block`.
`fetch` is the incremental read: it returns only data that caller has not yet
fetched from the block, never starts or changes the block, and is not recorded in
the operation journal. Each caller keeps its own position, so one caller's fetch
does not consume another's. Positions are kept in Core memory for the caller's
session; after a Core restart or a new session the data may be delivered once more.
Fetch accepts only `block_id` (plus `terminal_id` for Terminal Control). A result
with `hasMore: true` has further unfetched data (fetch again); `gap: true` means
older unfetched data has already rolled off the retained buffer; `unchanged: true`
means nothing new.

| Block | Actions | `fetch` returns |
| --- | --- | --- |
| AI Agent (`ai`), Chatbox (`chatbox`) | omitted (run and wait), `start`, `status`, `tail`, `steer`, `fetch` | messages and activity not yet delivered to this caller (changed messages are re-sent) |
| Meeting (`meeting`) | `publish`, `tail`, `diff` (default), `wait`, `fetch` | unread messages from the caller's saved cursor (same as `diff`) |
| Run App (`run_app`) | `start`, `status`, `kill`, `tail` (only those configured), `fetch` | log text since the last fetch (needs `tail` allowed) |
| Terminal Control (`terminal_control`) | `list`, `open`, `open_and_run`, `read`, `write`, `fetch` | terminal text since the last fetch (needs `terminal_id`) |
| Task controls (`task_controls`) | `create`, `create_and_start`, `status`, `prompt`, `set_status`, `set_commit_message`, `update_commit_message`, `fetch` | task status, only when changed since the last fetch (optional `task_id`) |
| Text, Markdown, Script, Timer, User Prompt, Yes/No Prompt | run (omit action); `fetch` | retained output not yet fetched; Timer and prompts run when used without `fetch` |
| Skill (`skill`) | load (omit action) | not supported; skills load through policy checks |

Not callable by agents: Start button/input, and the legacy Prompt, Task, Review
and Verification blocks. The read-only companions `workflow_block_output` (paged
retained output of any non-skill block), `workflow_block_messages` (AI/Chatbox
snapshot) and `workflow_connections` (list tools) are unchanged.
