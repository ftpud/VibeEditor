# Desktop–Core connections

Desktop uses typed WebSocket requests and events. Independent asynchronous
requests run concurrently; responses match request IDs and can arrive out of
order. Task/root transitions use a per-connection switch barrier. Dependent
mutations must still be awaited, and service-specific write queues remain in
force. A Desktop request timeout rejects its pending promise without cancelling
already-running Core work.

## Heartbeats and recovery

| Monitor | Interval | Response deadline |
| --- | --- | --- |
| Desktop `protocol.keepAlive` | 10 seconds | 10 seconds |
| Core WebSocket ping/pong | 30 seconds | 10 seconds |

Desktop has at most one probe in flight. Keep-alive replies bypass service
initialization, workspace-switch waits and application admission. Browsers answer
Core's native ping automatically. The bounds depend on the event loop running;
sleep or suspension can delay them. Embedders can override thresholds with
`new CoreClient(requestTimeoutMs, { intervalMs, timeoutMs })` and the fourth
argument to `createServer`.

A lost connection rejects pending requests and starts one cancellable recovery
loop. Retry windows grow from 250 ms to 5 seconds; each delay is randomly drawn
from the upper half of its window. Recovery reselects the saved root/task,
renews subscriptions and reattaches durable terminal IDs. Missing or mismatched
saved selections fail explicitly instead of substituting another workspace.
Live dirty buffers, saved revisions and editor view state are preserved during
recovery; this does not persist drafts through a renderer crash or restart.

Interrupted mutations are never automatically replayed. A failed write may
already have committed on Core, so inspect its outcome before retrying. Missing
terminal sessions need an explicit replacement. A Core shutdown closes managed
terminals and apps; see [release operations](RELEASE_OPERATIONS.md).

## Admission and outbound capacity

Embedders configure connection limits through the fourth `createServer` argument:

```ts
createServer(host, port, workspace, {
  admission: { maxInFlight: 32 }, // Optional; unlimited when omitted.
  outbound: {
    maxBufferedBytes: 16 * 1024 * 1024,
    maxCoalescedBytes: 64 * 1024,
    maxCoalescedEvents: 64,
    drainIntervalMs: 25,
    maxCoalesceDelayMs: 2_000
  }
});
```

The outbound values shown are defaults. Limits must be positive safe integers;
`maxBufferedBytes` must exceed the 64-byte control reserve, and timer values must
fit the supported timer range. The drain interval cannot exceed the congestion
deadline. These options have no CLI or settings-panel controls.

Admission rejects excess requests with a correlated `INVALID_REQUEST` response;
it adds no waiting queue and does not retry requests. Each connection owns its
slots, including work waiting for initialization or a workspace switch. Already
started operations can finish after disconnect; pending handlers check connection
state before starting work. There is no server-wide concurrency cap.

Outbound accounting uses the larger of socket-buffered bytes and unfinished
send-callback bytes, plus framing overhead. At 75% application capacity, selected
snapshot invalidations can coalesce by event type and root. The allowlist lives
in `core/src/websocket-output.ts`. Responses and required output/exit streams
are never silently dropped or coalesced. An oversized frame, exhausted budget,
failed send, or expired congestion deadline terminates that peer. Other peers
retain their own budgets. Recovery does not replay the interrupted operations.

Deferred hints have separate byte/count bounds. These limits do not bound all
producer-side JSON construction, kernel buffers, inbound parsing, or total Core
memory. File-transfer sockets use their own transport path.

## Workspace tree limits

Core accepts optional positive safe integer environment variables:

- `VIBE_TREE_MAX_NODES`: visible nodes, including implicit parent directories.
- `VIBE_TREE_MAX_PATH_BYTES`: summed UTF-8 relative paths of visible nodes.
- `VIBE_TREE_MAX_DEPTH`: path-component depth.

Unset limits are unlimited. Embedders can pass `maxNodes`, `maxPathBytes`, and
`maxDepth` to `WorkspaceFileSystem`. Limits apply per tree request; they do not
constrain mutations. `workspace.open`, root selection and `filesystem.listTree`
reject oversized trees with `WORKSPACE_TREE_TOO_LARGE` before serializing them.
They return no partial tree and leave the socket usable. Desktop stops automatic
recovery for this error. Narrow the workspace, ignore generated files, turn off
include-ignored, or adjust the producer and outbound limits together.

When both node and path-byte limits are set, each Git stdout/stderr collection
has a cap of `maxPathBytes + 2 * maxNodes`, with a 4096-byte floor. Collection is
otherwise unlimited. Overflow rejects the snapshot rather than falling back to
unbounded traversal. Traversal streams directory entries and closes handles on
rejection.

## Event validation and refreshes

`protocol/src/server-events.ts` validates event envelopes and payloads before
Desktop dispatch. Unknown types, malformed JSON, invalid nested values, and
events containing response-envelope fields are ignored. Extra fields on known
events are allowed for compatible additions. Diagnostics use a fixed warning at
most five times per client without logging payloads. This is shape validation,
not an inbound byte/rate limit or validation of every response result.

Configuration and process invalidations each have at most one active snapshot
batch and one pending follow-up. Root/task/client guards prevent obsolete results
from replacing current UI state. Disposal drops queued follow-ups; already-issued
reads can finish but cannot commit stale state. Manual refreshes and required
stream events retain their own handling. Continuous invalidations can keep one
batch running at a time; coalescing is not a time-based rate limit.

Implementation and regression tests are colocated with `core/src/server.ts`,
`request-admission.ts`, `websocket-output.ts`, `filesystem.ts`, and renderer
`client.ts`, `connection-recovery.ts`, `workspace-recovery.ts`, and
`invalidation-refreshes.ts`.
