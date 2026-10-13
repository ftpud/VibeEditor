# Detecting silently lost Desktop–Core connections

Queue `todo-queue-20261012-connectivity`, TODO-002.

An individual request timeout previously rejected only that request. A silently
lost socket could remain OPEN, leaving Desktop unaware that recovery was needed.
Repeated disconnects during restoration could also create competing retry loops.

## Detection

Desktop now sends `protocol.keepAlive` with a unique request ID every 10 seconds,
waiting at most 10 seconds for its response. There is at most one probe in flight.
Core answers after the protocol handshake but before service initialization or
workspace-switch waits. Long file reads, AI operations, and workspace switches
do not serialize or block this probe. Healthy idle sessions respond normally.

This uses ordinary browser `send`/`onmessage`; browser JavaScript cannot initiate
WebSocket ping frames. Core separately sends a WebSocket ping every 30 seconds
and allows 10 seconds for the matching pong. Browsers reply automatically. Core
terminates silent peers so their connection-owned services and subscriptions can
be released through the existing close cleanup. Durable terminals remain alive
for reattachment. File-transfer sockets are outside this Desktop session monitor.

| Monitor | Default interval | Response deadline | Silent-loss bound |
| --- | --- | --- | --- |
| Desktop application probe | 10 seconds | 10 seconds | 20 seconds |
| Core ping/pong | 30 seconds | 10 seconds | 40 seconds |

Bounds apply while the event loop runs; OS sleep, suspended renderers, or event
loop stalls delay timers. On resume an expired deadline may cause a conservative
reconnect. Constructor injection makes thresholds configurable and testable:
`new CoreClient(requestTimeoutMs, { intervalMs, timeoutMs })` and
`createServer(host, port, workspace, { intervalMs, timeoutMs })`. Values must be
positive finite milliseconds within the timer range. No CLI/settings UI is added.

Desktop detaches a lost socket immediately, clears heartbeat timers, rejects all
its pending requests, and calls `onDisconnected` once. It does not wait for a
browser close event, which itself may stall. Old socket events/responses cannot
settle new requests. Explicit disconnect, connection replacement, failed
negotiation, peer close, and shutdown clean up their timers. Timed-out ordinary
operations do not by themselves disconnect a transport that still answers probes.

## Recovery

App transitions to disconnected while keeping the editor and live buffers mounted;
connection-dependent commands see disconnected until restoration finishes.
App owns one cancellable `ConnectionRecovery` loop. Disconnect notifications
while it is active do not start another attempt. Existing exponential retry
spacing (250 ms up to 5 seconds) remains; cancellation removes the retry timer.
Shutdown, manual disconnect, and connection replacement stop recovery and reject
pending work. Workspace-option persistence stays paused during restoration.
Restoration commits are guarded by client, root, workspace, and cancellation
identity, including the recovery refreshes. Obsolete results cannot overwrite a
replacement client or selection.

Recovery negotiates protocol, reselects the remembered registered root, opens the
workspace to renew watch/event subscriptions, restores snapshots, reattaches
terminal IDs, and refreshes tasks and other state. `workspace.selectRoot` now has
an optional `preserveTaskSelection` flag for connection restoration: Core routes
to that root's durable selected task worktree without clearing its task selection.
Ordinary user root selection still clears task selection and returns to the root.
The existing workspace-switch barrier remains in force. Before restoring UI
state, recovery verifies the returned root, workspace path, and selected task ID
against the live selection captured at disconnect. A missing root or mismatched
workspace/task fails explicitly and continues retrying; it never substitutes a
different workspace. A user can explicitly disconnect and choose a new session.

Recovery merges disk snapshots with the latest live editor groups at commit time.
Dirty buffers retain their complete tab objects, original saved contents/revision,
IDs, view state and active selection, including unsaved tabs absent from durable
options and edits made while reads are pending. Clean matching tabs refresh disk
contents while retaining IDs and view settings. Live draft metadata and panel
selection are retained during recovery. Initial connection/root/task selection
continues to use the existing snapshot restoration behavior.

Recovery never queues or replays old requests. Failed shell creation, writes,
terminal input, AI sends, and other mutations are rejected, not resent. Missing
terminal sessions are shown as unavailable during recovery; a replacement shell
requires a user action. Routing restoration and subscription attachment are fresh
connection setup operations, not retries of interrupted mutations. Protocol and
the downloadable Desktop compatibility manifest advance together to version 15,
so an older Core cannot silently miss the required heartbeat operation.

## Evidence and limits

- Fake browser-socket tests hold readyState OPEN and suppress every response and
  close event, verify the deadline, one notification, obsolete mutation rejection,
  healthy idle probes, replacement, and timer cleanup.
- Recovery-loop tests cover duplicate starts, failed restoration, retry, active
  cancellation, and shutdown without another attempt.
- A native WHATWG WebSocket test with a real local server suppresses application
  replies without closing TCP. It verifies idle health, one recovery connection,
  root/task snapshots, renewed workspace/terminal subscriptions, live events, and
  no mutation replay. Native WHATWG tests run on Node versions exposing that API;
  fake browser tests also cover older supported Node versions.
- Delayed editor-snapshot regressions cover unsaved buffers across multiple
  groups, external disk changes, edits during pending reads, and replacement of
  client/root/workspace or shutdown before commit. Missing saved roots/workspaces/
  task selections produce explicit recovery failures.
- Core tests verify automatic browser-compatible pongs, silent-peer termination,
  send failure and cleanup. The real Core/WebSocket/PTY regression also proves
  keepAlive bypasses held reads/switches, and a reconnect to a secondary root
  preserves its actual task worktree and reattaches its actual terminal.

These checks do not benchmark congested networks or implement buffering,
admission limits, retry jitter, or cancellation of already-running Core work.
A rejected mutation can already have committed on Core; its outcome must be
inspected rather than automatically retried. A removed saved root/task requires explicit user selection or restoration of that
resource before automatic recovery can finish.

Live drafts remain renderer memory; this change protects reconnect restoration,
not process crashes or renderer restarts. File reads and option loads are not a
transactional snapshot against external edits. Dirty buffers keep their original
revision so the existing conflict check still protects a later save.
