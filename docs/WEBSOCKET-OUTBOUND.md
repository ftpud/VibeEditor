# Bounded Desktop–Core outbound delivery

Queue `todo-queue-20261012-connectivity`, TODO-003.

Core previously called `socket.send` without checking queued bytes and discarded
asynchronous write errors. A slow Desktop could accumulate responses and stream
output indefinitely while appearing connected.

## Policy and configuration

Every Desktop session now has an independent outbound budget in
`packages/core/src/websocket-output.ts`. Configure it through the existing server
options, without changing the wire protocol:

```ts
createServer(host, port, workspace, {
  intervalMs: 30_000, // Existing Core heartbeat configuration.
  timeoutMs: 10_000,
  outbound: {
    maxBufferedBytes: 16 * 1024 * 1024,
    maxCoalescedBytes: 64 * 1024,
    maxCoalescedEvents: 64,
    drainIntervalMs: 25,
    maxCoalesceDelayMs: 2_000
  }
});
```

These are the defaults. Values must be positive safe integers; the outbound
limit must exceed a 64-byte control reserve. Drain/deadline timers must fit Node's
timer range and the poll interval cannot exceed the congestion deadline. Options
are validated before starting Core. There is no new CLI/settings UI.

Admission uses the larger of `socket.bufferedAmount` and unfinished send-callback
bytes. Each application frame is charged UTF-8 payload bytes plus ten bytes for
the maximum unmasked WebSocket header. Native-client pong replies are also
charged and use the same failure policy; automatic unbudgeted pongs are disabled
on the server. Their payloads and protocol behavior are preserved. Tracking callbacks also bounds rapid
writes when the socket metric reads zero before callbacks run. This is a
conservative budget, not a measurement of total process memory. It excludes
producer-side JSON construction, kernel/TLS buffering, and WebSocket close-frame
overhead. The 64-byte reserve accommodates Core's one outstanding
heartbeat ping on normal browser connections.

Core never queues required application messages in another unbounded buffer.
Before a write would exceed the application capacity (limit minus reserve), or
when a single frame is too large, Core terminates that peer immediately. A
synchronous throw or asynchronous send callback error does the same. Subsequent
writes are rejected. Other clients continue using their own budgets.

Termination uses `terminate`, rather than queueing a close frame behind the
stalled output and waiting for a close handshake. The server logs a fixed reason.
Desktop receives connection loss and uses the existing guarded recovery loop.
Request IDs and payloads are unchanged; obsolete pending requests reject. No
interrupted mutation is queued or replayed. A write may already have committed
on Core before its response fails, so callers must inspect state instead of
blindly retrying it.

## Replaceable hints

Only these Core-generated events can be deferred/coalesced under pressure:

- `git.changed`
- `taskGit.changed`
- `java.semantic.changed`
- `ai.changed`
- `tasks.changed`
- `timers.changed`

They ask Desktop to fetch current snapshots; they do not carry required deltas.
Keys include the event type and root identity. Coalescing starts at 75% of the
application capacity, retains the latest encoded hint per key, and preserves
separate roots. Deferred state is bounded independently by its key count and
UTF-8 key/payload bytes. The combined logical bound is the socket/callback budget
plus the configured deferred-hint budget, with at most two queue timers per
congested peer. Draining starts as capacity returns. Duplicates do not extend the
maximum lifetime of a congested burst. If retained state exceeds either bound or
the burst cannot drain before its deadline, Core disconnects instead of losing
an invalidation while keeping the client connected.

Correlated responses, heartbeat responses, terminal/Java output and exit events,
workflow documents, and payload-bearing configuration/process/run-config/commit
message events are never coalesced or silently skipped. Responses and required
streams do not wait behind deferred hints; if they cannot be admitted safely,
the session fails explicitly. The existing request concurrency and workspace
switch barrier are unchanged. AI change hints reconcile durable provider state;
AI snapshot responses remain required delivery.

## Cleanup and recovery

Peer close/failure releases queued hints, byte counters and timers. Existing Core
close cleanup releases live-root selections, active-session subscriptions,
workspace watchers, Java/JDT services and liveness monitoring. Terminal ownership
records for the closed socket are now removed too. A watcher or service that
finishes preparation after disconnect is disposed rather than installed on the
closed session. Initialization rejection is handled even when an oversized
handshake terminates the session before any scoped request awaits initialization.

Durable PTYs and AI/provider state remain alive for recovery. Terminal output
produced while detached stays in its existing bounded replay buffer; reconnect
reattaches the existing terminal ID. Full, unlimited terminal history is not
promised: the existing replay limit is one million characters. Missing durable
sessions still require explicit user action, rather than automatic shell creation.

## Validation and review findings

Unit checks simulate non-draining sockets and withheld callbacks, assert the byte
bound, root-specific hint coalescing, key/byte/deadline limits, timer cleanup,
required-message failures, asynchronous errors and an unaffected healthy peer.
The real Core/WebSocket/PTY checks force a peer's buffer metric or asynchronous
send callback to fail, verify prompt close and healthy response/heartbeat delivery,
release of that peer's Java/JDT/watch resources, no further writes to its retired
terminal owner, and reattachment with detached output and live streaming. The
interrupted terminal command is observed exactly once. Another check holds
service initialization past an oversized handshake and verifies late cleanup.
Existing delayed-request and workspace-switch regression checks still apply.

Additional concrete finding: `WorkspaceFileSystem.listTree` builds a complete tree
from Git path lists (each Git subprocess allows 64 MiB stdout) or a directory walk,
and `workspace.open` JSON-encodes that complete result before this sender sees it.
There is no aggregate node/encoded-size limit on that tree. One large snapshot can
therefore consume substantial producer memory or fail this delivery limit even
with a single request. This is distinct from the queued admission work: it needs
snapshot sizing/pagination or producer-side bounds, rather than more parallelism.
No such API or producer change is included here.

Inbound flooding, client event validation, retry jitter,
configuration/process refresh coalescing, and workflow binding are already in the
queue or outside this Desktop application-frame policy, and are not duplicated.
File-transfer sockets use their separate callback-paced download path and are
outside this Desktop-session application sender; their native pong replies still
use the bounded control path.

A legitimate large response can exceed a configured limit and trigger recovery;
this policy does not chunk responses or paginate large snapshots. Operators using
large payloads must choose a sufficient budget. A persistent oversized recovery
snapshot requires adjusting that budget before recovery can finish. Timer bounds
also assume the event loop runs; OS suspension or stalls delay enforcement.
