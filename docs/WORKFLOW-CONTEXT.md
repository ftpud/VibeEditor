# Workflow context review

Workflow blocks keep separate provider sessions. A connected AI or Chatbox
continues its existing session when invoked again; it does not receive the
parent's whole conversation. Follow connections carry the source's output.
Joining graph branches combines their direct predecessor outputs.

## Fixed accumulation sources

- New sessions receive the block instructions and connected tool catalogue.
  Continued sessions receive the new input and any dynamic block templates,
  without repeating the runtime manual or static block instructions. Review
  blocks, which create fresh sessions, still receive the complete instructions.
- An `{{input}}` template supplies the input once. Core adds an input section
  only when the block prompt does not already interpolate it. Tool metadata is
  appended after rendering, so templates in another block's description cannot
  expand into copies of the caller's input or upstream outputs.
- Connected descriptions are previews of at most 512 characters, explicitly
  marked when shortened. Executing the block still uses its full instructions.
  Skills expose their descriptions and load their instructions on demand.
- `workflow_use_block` returns app state/logs under `app`, task results under
  `task_controls`, and linked skill content under `skill`. These structured
  responses omit the second escaped JSON copy in `output`. Ordinary text,
  script, and AI outputs retain the `output` field. Persisted block outputs
  retain the full original result.
- `workflow_block_messages` returns recent messages and activity instead of
  also returning a duplicate full output. The existing 8,000-character message
  tails now indicate truncation. Identical polls by the same caller return
  `unchanged: true`; `include_unchanged: true` explicitly rereads the snapshot.
  Snapshot fingerprints live only for the execution and contain no transcript.
- Connection listings and progress reads no longer create durable operation
  journal entries. Execution and other state-changing tools remain journalled.

## Existing protections and remaining growth

App status/start/kill results contain process metadata, not log history. Tail
requests default to 100 lines, accept a requested line count, and return at most
30,000 characters with a truncation flag. UI app logs and terminal replay are
separate from the model's tool results. Repeated explicit tail requests can still
repeat the same log window: an incremental log cursor would reduce that further.

Dynamic `{{blocks.ID.output}}` templates and large branch joins can intentionally
carry substantial output into later turns. Core preserves these inputs and
checks the configured rendered prompt limit; it does not silently summarize
them. Workflows should reference the relevant block results and ask for concise
agent outputs when full evidence is unnecessary.

Provider conversations still grow with useful user turns and tool calls.
Core's local transcript retention (1,000 provider messages, 200 Chatbox messages)
is not a model context-window limit. Compaction belongs to the provider; Core
does not reset sessions or discard task context automatically. An optional
context-aware handoff/compaction policy is a separate follow-up, because it must
preserve provider capabilities, block instructions, permissions, and recovery.

The operation journal still grows with actual workflow actions. Removing
read-only polls addresses avoidable growth, but journal retention must preserve
idempotency and recovery evidence rather than deleting old entries blindly.
