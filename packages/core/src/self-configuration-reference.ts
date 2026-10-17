import { appToolDefinitions, flowToolDefinitions } from "./app-tools.js";

const configuration = String.raw`# Configuration formats

Contents: scopes; document formats; writes; workflow definition; validation.

## Scopes and logical paths

Call configuration_list({include_models:true}) when selecting providers/models;
otherwise omit include_models. Its workspace is the invoking checkout; rootWorkspace
is the root project. Use catalogue IDs rather than guessed filesystem locations.

- agents/{global|local|workspace}/{filename.md}: agent Markdown.
- skills/{global|local|workspace}/{name}/SKILL.md: skill Markdown. Name starts with
  an alphanumeric character, then alphanumeric, underscore or hyphen; maximum 80.
- useful/{global|local}/{filename}: arbitrary text, not necessarily Markdown.
- skills/policy.json: project skill selection and agent assignments.
- workflows/{id}.json: project workflow definition. workflows/new.json is a starter.
- tasks/{id}.json: existing task metadata only.

Global is shared across projects on this Core host. Local is Core state shared by
all tasks of the root project. Workspace agents/skills are files in the invoking
checkout's .agents directory, suitable for versioned project instructions. Useful
files have no workspace scope. Skill policy belongs to the root project in Core
state; writing it migrates a legacy checkout policy. Logical paths cannot contain
absolute paths, traversal, backslashes, empty segments or private registry names.
Agent/useful filenames are at most 180 characters and cannot contain subdirectories.

## Markdown documents

Agent example (filename reviewer.md):

~~~markdown
---
name: Reviewer
description: Review the requested change and report actionable findings.
mcpServers: [vibe-editor]
---
Read the change and relevant tests. Explain findings with file locations.
~~~

mcpServers enables app tools for an agent; use the vibe-editor entry when needed.
Agent references are objects such as {"scope":"local","name":"reviewer.md"}.
They are independent of provider/model selection.

Skill example (skills/local/testing/SKILL.md):

~~~markdown
---
name: testing
description: Run and interpret this project's targeted tests after code changes.
---
Choose the package test command for the changed code and report failures.
~~~

Skill IDs are strings such as local/testing, not filesystem paths. New skills are
not automatically enabled. Change policy only when requested. Supporting files for
this built-in skill are shipped by Core; configuration_read/write expose SKILL.md,
not arbitrary nested reference files.

Policy document example:
~~~json
{"allowed":["local/testing"],"defaults":["local/testing"],"agents":{"local/testing":[{"scope":"local","name":"reviewer.md"},null]}}
~~~

Defaults must be allowed. Missing agents assignment means any agent; an empty
assignment list permits none; null permits a chat without an agent preset. Preserve
unrelated assignments. Policy controls delivery of instructions, not filesystem
permissions. Existing chats retain their selections; changed instructions apply
on a subsequent turn.

Task document example:
~~~json
{"name":"Fix navigation","status":"active","archived":false}
~~~

Only name (nonempty, at most 200 characters), status (active/finished) and archived
(boolean) are accepted. Use task lifecycle commands for worktrees, sessions, merges
and deletion. Do not write branch paths, transcripts or workflow-run state.

## Read, write, reconcile

1. Discover resources with configuration_list; read the target with configuration_read.
2. Edit the full document, preserving unrelated properties and IDs. content is a
   string containing JSON or Markdown, never an object or a patch. Limit: 2 MB.
3. configuration_write takes resource, content and expected_revision. Use the exact
   read revision for an existing document, null for creation. Missing agent/skill/
   useful reads return exists:false, revision:null. Policy always exists.
4. Read back and check behavior/scope. Workflow writes return validation issues;
   valid JSON can still describe an invalid graph. Fix issues before execution.
5. On conflict, reread and reconcile; do not repeatedly overwrite competing edits.

Example tool arguments for a new useful file:
~~~json
{"resource":"useful/local/notes.md","content":"# Notes\nProject instructions.\n","expected_revision":null}
~~~

For JSON documents construct content with JSON.stringify(definition), preserving
real newlines inside JSON strings. Never interpolate untrusted prompts into shell
commands. Read workflows/new.json, change its content and write with null revision.
The response supplies the actual workflows/{id}.json: use that resource for edits
and retries to avoid creating duplicates. Existing workflow edits must preserve the
read version as well as expected_revision; Core owns id, version and timestamps.
Saving never runs commands or starts tasks/workflows. Execute only when the user's
request covers execution; use the app's run controls for starting workflows.

## Workflow envelope and settings

New content needs name, blocks and edges, plus optional settings. Existing content
also contains id, version, createdAt and updatedAt; preserve these when editing.
Every block needs id, type, label, prompt (even if empty), position:{x,y}.
Every edge needs id, from and to. Prefer stable alphanumeric/underscore/hyphen IDs.
See blocks.md for every type and connection property.

Optional settings (integer ranges):
- concurrency, maxActiveRuns: 1–32; simultaneous work and active runs respectively.
- maxBlockAttempts, maxStackSize, maxLoopCount, maxChildTasks: 1–1000.
- promptLimitChars, outputLimitChars: 1000–200000.
- contextBudgetChars, tokenBudget: 1000–10000000.
- retry:{maxAttempts}: 1–10.
- logLimitEntries: 10–500.
- maxRunDurationMs: 60000–86400000.

Use limits proportional to the job; retain existing settings unless changing them
is part of the request. Provider/model/agent availability is runtime-dependent:
discover actual provider IDs, model IDs and reasoning choices from the catalogue.
`;

const blocks = String.raw`# Workflow blocks and connections

Contents: common fields; every block type; connections; commands; patterns.

## Common block configuration

All blocks: id, type, label, prompt:string, position:{x:number,y:number}.
Optional description explains when a connected agent should use the block.
AI configuration: provider, model, reasoning, agent:{scope,name}, autopilot.
Choose values from configuration_list(include_models:true); do not invent IDs.
When the provider supports autopilot, it is enabled unless autopilot:false; this
controls provider permission behavior. Keep the user's requested permission mode.
Optional options:{id:value} sets non-interactive provider feature switches such as
liveSteering; interactive ones such as askQuestions are always off in workflows.
Optional inputSchema/outputSchema describe JSON values using type:string|number|
boolean|object|array, object properties and required arrays, or array items.
These are a limited schema subset, not arbitrary JSON Schema. An associated
input/output must be JSON text matching the schema, even for type:string.

Prompt templates: {{input}} is incoming text; {{blocks.ID.output}} references a
block's retained output. References do not execute blocks or establish dependencies.
Missing output renders empty; keep prompts and transferred reports concise.
Legacy stack execution also supplies {{iteration}}; prefer {{input}} for new flows.
Shell command fields are shell source, not prompt templates. Scripts receive input
on stdin and in VIBE_WORKFLOW_INPUT; Run App receives VIBE_WORKFLOW_INPUT.

## Block catalogue

### ai — AI Agent

Configure prompt plus optional provider/model/reasoning/agent/autopilot. Performs
reasoning or implementation and can use connected blocks. Its existing session
context is reused on subsequent calls. Give clear delegation/output instructions.
Use for decisions and work needing an agent; use script for deterministic commands.
Optional watchdog:true configures the independent Core watchdog: only one is allowed,
it cannot have edges, and at least one other delivery block must exist. It supervises
runtime recovery rather than participating as an ordinary graph step.

### chatbox — Chatbox

Same AI configuration; prompt can be empty. Provides a conversational workflow entry
for repeated user turns. All outgoing connections are exposed as callable tools,
regardless of edge type; they do not automatically forward on completion and do not
act as ordinary path choices. Use explicit use edges to make this intent clear.

### skill — Skill

Set skillId to an existing scoped skill ID (global/name, local/name, workspace/name),
or use inline prompt plus a nonempty description of when to use it. A referenced
skill loads through current selection/policy for the calling agent; its prompt is
not a substitute for that policy check. Inline skills return rendered instructions.
Use a use edge so the agent loads relevant guidance on demand. Skill output must
be loaded through workflow_use_block, not bypassed with workflow_block_output.

### task_controls — Task controls

Configure provider/model/reasoning for task agents; prompt may be empty. Operates
isolated task worktrees using structured commands. AI settings come from the block,
not per-call overrides. Use for implementation work requiring isolation and lifecycle
management, rather than spawning agents in terminal sessions.

Direct block input is a JSON string object with action and these action-specific fields:
- create: branch; optional idempotency_key.
- create_and_start: prompt; optional branch, idempotency_key.
- status: optional task_id; empty input defaults to listing tasks.
- prompt: task_id, prompt; optional idempotency_key.
- set_status: task_id, status:"active"|"finished".
- set_commit_message: task_id, message (or prompt fallback); saves a draft only.
- update_commit_message: task_id, message (or prompt fallback); rewrites the latest
  unpushed commit message without changing contents; published history is refused.

For workflow_use_block, pass prompt text as input, with action and other fields at
the top level. Results appear in task_controls. Reuse an idempotency_key only when
retrying the same intended operation; use a new key for a distinct operation.

### meeting — Meeting

Shared, attributed chat log for a single workflow run. prompt may be empty.
Connect multiple ai/chatbox participants to it with incoming use edges. It accepts
no outgoing edges or follow/path inputs. Publishing wakes pending wait calls without
starting new agent turns. Participants use workflow_use_block:
- action:"publish", message:"Proposal" (or input): append a message, returning
  published and latestSequence. Maximum 10000 text characters and 16000 serialized
  characters including attribution; author/provider/model come from the caller.
- action:"tail", lines:20: read recent messages and advance this participant's cursor.
- action:"diff", lines:20: read messages after this participant's last read.
  Optional after is an explicit nonnegative sequence number for replay/pagination.
  Omitted action defaults to diff. lines is 1–50, default 20.
- action:"wait": return unread messages immediately, or wait for the next publish
  without polling. Uses the same lines/after options and saved cursor as diff.
  timeout_seconds overrides the connection timeout (default 300 seconds, maximum
  86400). Returns status:"updated" or status:"timed_out" inside meeting. The wait
  releases workflow execution capacity so other agents can publish. Run cancellation
  and Core shutdown release pending waits.

Results are in meeting: messages, cursor, latestSequence, hasMore and
historyTruncated. Continue diff reads while hasMore is true. For explicit replay,
pass each returned cursor as after on the next page. Pages fit the tool context
budget. Read positions are independent per calling block and persist with the run;
explicit replay never rewinds the saved cursor. The latest 1000 messages are kept;
historyTruncated reports when unread history has expired. The Meeting run panel
shows the shared transcript. New workflow runs start with an empty meeting.

### terminal_control — Terminal Control

prompt may be empty. Provides persistent workspace-scoped terminals for interactive
programs, REPLs, or services needing later terminal input. Do not use for short tasks,
one-shot scripts, routine tests/builds or spawning AI agents. Prefer script for
finite non-interactive work and run_app for named services needing lifecycle control.
List first and reuse an appropriate terminal; avoid opening duplicates.

Direct input is a JSON string object:
- {"action":"list"}: list terminals; empty input also lists.
- {"action":"open","name":"Interactive console"}: create a named terminal.
- {"action":"open_and_run","name":"Console","command":"node"}: open and execute;
  a newline is appended automatically; returns terminalId immediately.
- {"action":"read","terminal_id":"ID","lines":100}: last 1–10000 lines (default
  100), bounded to 30000 output characters.
- {"action":"write","terminal_id":"ID","data":"help\n"}: raw input; include
  newline to execute a command. A control character such as \u0003 sends Ctrl-C.

Names are 1–120 characters without control characters. Commands/data are at most
100000 characters. Only terminals belonging to the execution workspace are available.
With workflow_use_block use these fields as top-level arguments; open_and_run can
also take its command from input. Structured results appear in terminal. There is
no terminal_control close action; do not invent one.

### script — Script

Required command is a shell script; prompt may be empty. Runs in the execution
workspace, waits for completion, returns stdout, fails on nonzero exit (with stderr),
and times out after 30 minutes. Input is supplied through stdin and VIBE_WORKFLOW_INPUT,
not interpolated into command source. Use for checks, builds, transformations and
small non-interactive tasks. Example command: npm run typecheck. When composing
multiple steps, make shell failure behavior explicit when needed.

### run_app — Run App

Required app:{name,actions:[...]} with allowed actions start/status/kill/tail;
legacy app.action selects a single action. name is 1–120 characters. command is
required when start is allowed. Optional app.lines is 1–10000 (default 100).
Use for a named long-lived preview server or service, reused by workspace and name.
Start reuses a live app; status inspects; kill stops; tail reads bounded logs.
Apps can outlive a workflow run; stopping a run is not the same as killing its app.

workflow_use_block accepts action and optional input; tail accepts lines. Only
configured actions are allowed. Direct JSON input can be {"action":"tail","lines":50}
or {"action":"start","input":"data"}; plain text is start input. If start is
allowed it is the default; otherwise a single allowed action is the default.
For multiple actions without start, choose explicitly. Results appear in app.
Use terminal_control instead when ongoing raw terminal interaction is needed.

### text — Text

prompt is literal/rendered text returned as output, including empty text. Use for
reusable instructions, fixed input or templates without starting an AI session.

### markdown — Markdown document

prompt is rendered into a document; empty prompt passes incoming text through.
Opens the result as an editor document after completion. Use for plans, reports,
specifications and reviewable deliverables; this does not write an arbitrary file.

### timer — Timer

Required seconds:number from 0 to 86400; prompt may be empty. Arms a countdown and
returns immediately. When it fires, follow connections receive its supplied input.
Use for delayed checks/continuations; avoid polling loops. This differs from the
session timer_set commands, which support delays up to seven days.

### user_prompt — User Prompt

prompt is the displayed question. Waits for a free-text answer in the workflow UI,
then returns it. Use when progress requires missing information or a user decision.
When called as a tool, its wait is not bounded by the connection timeout.

### yes_no_prompt — Yes/No Prompt

prompt is the displayed question. Same wait behavior, with output exactly yes or no.
Use for a binary decision; do not assume the returned text automatically selects an
edge label. Give an AI Agent the answer if routing requires a decision.

### start_button — Start button

prompt is the fixed starting input. Selecting this entry starts with that prompt;
use a follow connection to begin a repeatable flow. Multiple entry blocks require
choosing an entry when running.

### start_input — Start input

prompt can be empty. Entry receives the user's supplied run input. Use when each
run needs a new request or data, then follow to the processing block.

### prompt — Legacy prompt agent

AI configuration plus prompt. Runs an AI instruction in the legacy dependency/
stack workflow. Preserve when editing an existing workflow; prefer ai for new flows.

### task — Legacy task agent

AI configuration plus prompt. Runs work using the legacy task execution path.
Use task_controls for explicitly creating/steering tasks in new flows. Do not assume
this legacy type has the same action JSON interface as task_controls.

### review — Revision review

AI configuration plus prompt and review:{revision,baseRevision?,correction?}.
revision/baseRevision are exact Git SHAs (7–64 hexadecimal characters), not branch
names. correction:{ownerBlockId,maxCycles?,verificationBlockId?} can return findings
to an existing owner block, with 1–20 cycles and optional verification block.
Use for review tied to a concrete revision; preserve legacy execution semantics.

### verification — Verification gate

prompt plus verification:{command,revision?,workingDirectory?,timeoutMs?}.
Optional revision is an exact SHA; timeoutMs is 1–1800000. Runs the verification
command and records its result, optionally against that revision/working directory.
Use for a recorded verification gate; prefer script for a simple command in new flows.

## Connections

Every edge: {id,from,to,type?,label?,timeoutMs?,loop?,execution?}.
- use: gives the source AI Agent a callable target. It does not automatically run
  after the source. Call workflow_use_block({block_id:target,input:...}). Use for
  tools, delegation, reusable skills and on-demand questions. Use/path edges must
  start at ai or chatbox. Direction is caller -> tool, not tool -> caller.
- follow: automatically invokes the target after the source finishes, carrying its
  output. Several follow edges can fan out. Missing type defaults to follow.
- path: an AI Agent chooses a uniquely labeled outgoing path with
  workflow_choose_path({path:"label"}). The target receives final output after the
  source finishes. Ordinary follow edges still run. Path choice is not a tool call
  that immediately invokes the target. Chatboxes treat outgoing edges as tools.

timeoutMs (1–86400000) applies to use edges, or outgoing Chatbox connections; default
300000. A call's timeout_seconds can override it (positive, maximum 86400). Timeout
does not cancel a child: inspect messages/status instead of launching duplicate work.
User questions are exempt from this waiting timeout. Typed edges cannot set loop:true.
Legacy edges support loop:true only when returning to an earlier block on a forward
path; execution:"sync"|"async", block join:"all"|"any" and routing:"all"|"ai"
belong to legacy dependency/stack execution. join defaults to all (wait until incoming
dependencies resolve, then run if any selected input is active); any can run as soon
as one incoming dependency is active. routing defaults to all; ai requires a named
path for legacy workflow_run_stack dispatch. execution selects synchronous versus
asynchronous legacy dispatch. Preserve them in old definitions; use
explicit typed connections for new flows. Cyclic flows need sensible run/loop limits.

## Callable AI lifecycle and output

workflow_use_block on connected ai/chatbox accepts input with no action to wait;
start launches immediately, status inspects, tail reads messages (lines 1–50),
steer sends input to a running session. Different AI blocks can work independently.
A child continues its existing context. workflow_block_messages reads progress
without sending input. Tool results are bounded to 20000 characters and may report
truncated or unchanged:true. workflow_block_output pages retained output with offset
and limit (maximum 8000); follow nextOffset. Never resend work solely because a
result timed out or was truncated. Full argument schemas are in commands.md.

## Patterns

- Repeatable check: start_button -> follow -> script(command:"npm test") -> follow
  -> markdown(prompt:"{{input}}").
- Conversational helper: chatbox -> use -> skill, script, run_app or task_controls.
- Decision: ai -> path(label:"approved") -> markdown, and ai -> path(label:"revise")
  -> another ai. Instruct the source to choose a path before its final output.
- Interactive debugging: ai -> use -> terminal_control; list, reuse/open, read,
  then write only when the live program needs interaction.

Minimal complete new workflow content (serialize this object as content):
~~~json
{"name":"Check project","blocks":[{"id":"start","type":"start_button","label":"Check","prompt":"Check this project.","position":{"x":40,"y":80}},{"id":"check","type":"script","label":"Typecheck","prompt":"","command":"npm run typecheck","position":{"x":300,"y":80}},{"id":"report","type":"markdown","label":"Results","prompt":"{{input}}","position":{"x":560,"y":80}}],"edges":[{"id":"start-check","from":"start","to":"check","type":"follow"},{"id":"check-report","from":"check","to":"report","type":"follow"}]}
~~~
`;

// Derive exact command documentation from the same schemas exposed over MCP.
// This keeps required arguments, enum values and limits in sync with the handlers.
const commands = [
  "# App and workflow commands",
  "Read only the relevant command section. Each section contains its use case and full JSON argument schema. These are MCP calls, not shell commands. A schema's required array identifies required arguments; other properties are optional. Do not pass fields outside the advertised schema.",
  "## Availability and execution",
  "Normal app sessions expose app commands. Flow sessions expose flow commands plus app commands except workflow_run_stack, workflow_resume_failed and workflow_plan_features. A skills-only server exposes skill_load only. The current tools/list response determines availability; this reference does not grant extra commands. workflow_run_stack is the legacy stack interface, while workflow_use_block is the flow interface. Workflow design is edited with configuration_write; there is no workflow-start MCP command in this catalogue. Use app run controls when execution is requested.",
  "Actions that create tasks, send prompts, merge, delete tasks, rewrite commits or start/kill processes change runtime state. Saving configuration does not perform them. Stay within the user's requested work. For operations supporting idempotency_key, reuse a key only for retries of the same operation.",
  ...[...appToolDefinitions, ...flowToolDefinitions].map((tool) =>
    `## ${tool.name}\n\n${tool.description}\n\nArgument schema:\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``)
].join("\n\n") + "\n";

export const CONFIGURATION_REFERENCES: Readonly<Record<string, string>> = {
  "configuration.md": configuration,
  "blocks.md": blocks,
  "commands.md": commands
};
