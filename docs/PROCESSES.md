# Proc: workflow apps

Proc sits beside Timers in both sidebar layouts. Its list and badge count represent
running apps explicitly started by workflow **Run App** blocks across the selected
root project's tasks and workflow sessions. Each launch/tree counts once. Provider
hosts, MCP/helper processes, transient AI tool commands, and workflow scripts are
excluded, even when they belong to a workflow session. Changing this view does not
stop any existing agent process. Both layout selections persist in workspace
settings, including classic task-specific Proc preferences.

An entry shows the app name, command, status, a live PID, process-tree size, workspace,
and available task/run/block context. The child process count describes that app's
tree and does not contribute additional entries or badge counts. When the launcher
exits but app descendants survive, the entry shows **Children running**, a surviving
PID, and the exited launcher PID in App details. **Stop** terminates the whole selected
app launch, including managed reparented/detached descendants. A stale Stop after the
app has already exited is a no-op. Another app or agent session stays running.

## Core tracking and lifecycle

Core registers each launch with a random inherited identity. Run App explicitly
registers workflow-app provenance, app name and workflow context; grouping uses the
launch record, never a provider-specific name or session membership. `processes.list`
returns one app per live registered app tree. `processes.kill` accepts its stable
`app:<launch identity>` ID, checks project ownership and stops the tree even when
its original launcher is gone. Individual process rows remain an internal discovery
mechanism; this UI has no general host/agent process inspector.

Core discovers changes every 500 ms while managed launches exist, broadcasts live
updates, and refreshes discovery before list and Stop. On Linux, `/proc` inherited
identities find detached children even if their intermediate parent starts and exits
between scans. Start ticks identify individual process lifetimes; Core checks them
before signalling to avoid stale PID kills. Stop uses SIGKILL, stops the launcher
first when present, then repeats discovery/signalling to catch surviving children.
Permission failures identify the PID and suggest checking Core host permissions.
Registrations are released after a complete snapshot finds no live root or managed
descendants; changes during a scan postpone pruning until the next scan. Failed
spawns are released and idle periodic scanning is skipped.

Run App serializes operations for each workspace/name. Start reuses an existing
launch while any of its managed descendants survive, preventing another copy from
being launched over an orphaned app. Once the whole tree exits or is stopped, Start
creates a fresh identity. Run App Kill, Proc Stop, and Core shutdown all stop the
registered app tree rather than relying only on the original process group. Explicit
Kill always discovers the launch before deciding it has exited, even if the cached
app entry is absent. Every termination pass reconciles the app cache before reporting
success; Linux rechecks start ticks immediately at each signal. Status/tail reuse
current state instead of doing a whole-host scan for every tool call. Operations on
independently named apps are not serialized together.

## Platform and coverage limits

Linux `/proc` under the Core user's permissions provides inherited-identity coverage.
The POSIX `ps` fallback retains observed descendants across reparenting, but cannot
recover children whose entire ancestry disappeared between snapshots; its start
timestamps have second precision. Native Windows Core discovery is unsupported
(remote Linux Core works with Windows Desktop). Restricted process environments or
commands that strip the inherited identity and fully detach before discovery cannot
be attributed safely and are omitted. Tracking is for the current Core lifetime;
it does not adopt arbitrary processes left by previous Core instances.

Discovery/signalling is not OS-atomic: processes can exit or fork during Stop. Core
rechecks identities and repeats discovery; if managed descendants remain, an error
asks the user to refresh and retry. Natural-exit updates can take one polling interval.
