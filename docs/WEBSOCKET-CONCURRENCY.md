# WebSocket request concurrency (TODO-006)

Original request:

> Low priority:
> Review the communication, for me it looks like the current web socket connection is slow for concurrent requests as all actions are sequenced. So need to rework the connection the way, so the file contents for example, or terminal data, or things where sequence is not required could be parallelized and not wait for each other. If you think it’s bad idea - explain why, if it’s good - implement

## Finding

Independent asynchronous operations already overlap. A new transport scheduler is
not justified by the delayed-request experiment. This item adds regression evidence
without changing runtime admission, routing, or ordering.

`CoreClient.request` sends immediately and stores a separate promise and timeout
under a UUID. Responses resolve/reject the matching ID, regardless of arrival
order. Events are dispatched immediately to `onServerEvent`, outside the pending
request map. Disconnect or replacement rejects all pending requests on that
socket; stale socket messages are ignored. Connection negotiation deliberately
awaits handshake, root discovery, and optional root selection in that order.

Core's `socket.on("message", async ...)` listener starts a handler for each
message; the emitter does not await its promise. Each handler returns its own
request ID on success or failure. Requests initially share service initialization,
then ordinary routing has no global request queue. TerminalSessionHost callbacks
send output and exit events directly, independently of handler completion.
`sendWebSocketData` safely drops sends after disconnect and catches send failures.

## Evidence and ordering

`packages/core/src/websocket-concurrency.test.ts` starts the real Core server on
an ephemeral localhost port with an isolated Git workspace/state directory and a
real WebSocket and PTY. Only the slow file's service read is held by a controllable
promise. Before releasing it, another file read completes, a missing-file error
arrives under its own ID, terminal input is acknowledged, and actual PTY output
arrives. Releasing the read produces its correctly identified response later.
This is a deterministic ordering check, not a network latency benchmark.

The same test awaits rename before reading the new path, and holds task selection
to verify a subsequent scoped read cannot enter its service until selection
finishes. An unscoped root-discovery round trip proves Core has admitted messages
behind the held switch. Desktop client tests separately exercise reverse response
order, interleaved events/errors, and rejection of multiple requests on disconnect.
Existing `server.test.ts` covers late sends and failed root selection;
`workspace-state.test.ts` covers rapid ordered saves retaining the latest options.

Keep these existing consistency boundaries:

- Core's per-connection `switching` barrier serializes task/root transitions and
  makes later scoped routing wait for services to change.
- WorkspaceStateStore queues saves; TaskCheckpointStore queues checkpoint
  transactions; root Git integration mutations use `serializedRootMutation` and
  a repository lock. These are service-specific, not transport-wide queues.
- Dependent operations must still await the preceding mutation. The transport
  does not promise arbitrary concurrent filesystem mutations are atomic or
  ordered. Renderer task switches retain the latest queued selection.
- Renderer `CoalescedAsyncAction` refreshes retain one active refresh and one
  latest follow-up. App startup and tab restoration already use `Promise.all`
  where dependencies permit it.

## Resource use and limits

No new fan-out, buffering, or admission queue is introduced. Existing file-size
limits (2 MiB), search result limits (500), terminal replay cap (1,000,000
characters), filesystem event batching, and refresh coalescing remain unchanged.
Request timeouts release Desktop pending entries but do not cancel Core work.

There is no explicit global in-flight request cap or application-level terminal
socket backpressure in the inspected path. The test establishes independence of
asynchronous service waits, not bounded behavior under unlimited clients or a
slow network consumer. WebSocket/TCP still sends bytes in order: a large already
queued frame, saturated connection, synchronous JavaScript, or heavy renderer
work can delay later messages. Removing useful service queues would not fix
those causes. A future latency report should measure service duration, event-loop
stalls, renderer handling, and socket buffering before changing the transport.
