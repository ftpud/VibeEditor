# Proc sidebar

Proc sits beside Timers in both sidebar layouts. It lists running AI agent hosts,
commands (including background commands), workflow scripts, and Run App processes
across the selected root project's tasks and workflow chats. It uses the Timers
panel's theme-aware styles. Both layout selections persist in workspace settings;
classic task-specific panel preferences also support Proc.

Core registers each ACP launch, workflow script, and Run App launch with a random
identity inherited through the environment. Provider IDs are context only; discovery
and termination do not branch on provider. Session IDs, task names and IDs, and
workflow run/block IDs are shown when available. Workflow aliases are resolved to
worktrees for task attribution. Core polls every 500 ms, broadcasts changes, and
refreshes discovery before list and kill requests. Only registered launch identities
and observed descendants are exposed. Ordinary terminals and other host processes
are excluded. Launch registrations are released after a complete snapshot finds
no live root or managed descendants. Registrations changed during a scan survive
until the next scan, preserving short-lived-parent discovery. Spawn failures are
released, and periodic scans stop when the registry is empty.

On Linux, `/proc` environment identities discover detached children even if their
intermediate parent started and exited between polls. `/proc/<pid>/stat` start ticks
identify individual process lifetimes, including registered roots. Discovery checks
that stat identity again after reading the environment. Kill requests carry the
process lifetime identity, rather than accepting an arbitrary PID. Core rechecks
lifetimes before signalling, treats an already exited process as a no-op, and rejects
kills outside the selected project. Killing a registered launch also kills its
inherited children, including already reparented children. For individual commands,
Core remembers observed ancestry across reparenting and stops that command's known
descendants. Another launch/session is left running. SIGKILL is intentional here;
there is no graceful shutdown delay. Permission failures identify the PID and suggest
checking Core host permissions.

## Platform and coverage limits

Linux `/proc` under the Core user's permissions provides the full inherited-identity
coverage. The POSIX fallback uses `ps` parent discovery and start timestamps. It
retains observed descendants across reparenting, but cannot recover children whose
entire ancestry disappeared between snapshots; its start timestamps have only
second precision. Native Windows Core process discovery is unsupported (remote Linux
Core works with Windows Desktop). Process environment restrictions can reduce
inherited discovery. Commands that strip the identity from their environment and
fully detach before discovery cannot be attributed safely and are omitted. When
an individual command's child detaches before its ancestry has ever been observed,
only the launch-level Kill can reliably include it. Tracking is for the current Core
lifetime; it does not adopt arbitrary processes left by previous Core instances.

Discovery and signalling are not an OS-atomic operation. Start-time checks avoid
stale PID kills, but a process can exit or fork during termination. Core stops the parent first and repeats discovery and signalling to catch new
inherited descendants during termination. If managed descendants remain, an error
asks the user to refresh and retry Kill. Live updates reconcile the resulting state.
