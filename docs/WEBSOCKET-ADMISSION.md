# Configurable Core request admission

Queue `todo-queue-20261012-connectivity`, TODO-011.

The Core WebSocket async message listener starts each request independently.
Desktop request timeouts only remove the client's pending response; they do not
cancel Core service work. Outbound byte limits alone therefore do not bound
concurrent service calls or handlers waiting for initialization/task switches.

Each Desktop connection admits unlimited concurrent application requests by
default. Set an explicit cap with the fourth argument to `createServer`:

```ts
createServer(host, port, workspace, {
  admission: { maxInFlight: 32 }
});
```

When provided, the value must be a positive safe integer and is validated before server startup.
There is no additional admission queue: a slot covers service initialization,
workspace/task switch barriers, service execution, and response submission.
Independent operations still run concurrently below the cap; a held operation
cannot consume another peer's slots. Existing switch ordering remains intact.
Explicitly dependent mutations still require callers to await their responses.

Excess requests are rejected before starting the requested service operation,
using the existing Protocol `INVALID_REQUEST` error and the original request ID:
`Core request concurrency limit reached; request was not started`. This does not
introduce a new protocol error, operation, or version. The existing outbound
budget limits correlated error writes too; if reliable delivery cannot fit or
fails, Core disconnects and Desktop uses its existing recovery path. Core does
not silently drop responses, queue a retry, or replay a mutation. Clients do not
automatically retry admission failures.

Handshake and browser-compatible `protocol.keepAlive` execute synchronously and
bypass application admission. They neither wait for workspace services nor
allocate an application slot. Native server ping/pong monitoring and outbound
control budgets continue to apply. This is a concurrency bound, not an inbound
message/CPU rate limit or parsing-size policy. File-transfer sockets keep their
separate transport path.

Slots release in `finally` on success or failure. Connection close clears all
leases; late releases are idempotent. A closing (not just closed) socket also
fails the execution guard. Handlers waiting for initialization or switch barriers
check the connection before starting service mutations. Root removal and root
selection check again after preparatory waits before committing. Initialization
checks connection state before installing subscriptions or building services.
Already-started service operations may finish after disconnect: this does not
cancel arbitrary service promises or roll back durable changes. A service promise
that never settles can retain its bounded handler until it settles; closing the
connection invalidates its lease and prevents a later dispatch. There is no
server-wide concurrency cap, and service-internal fanout/producer memory are not
bounded by this per-connection policy.

The held-service experiment uses two blocked file reads with a limit of two:
exactly two enter the service, twenty subsequent writes receive correlated
rejections without invoking the write service, and an independent peer and the
saturated peer's keepAlive both answer promptly. Releasing one successful and one
failing read permits subsequent write/read operations, with no automatic replay.
Real WebSocket tests also hold initialization or an active task switch, send a
mutation behind that wait, disconnect, and verify it never writes; a task switch
waiting behind initialization never calls task selection; a second task switch
waiting behind the active switch does not start selection after disconnect. The active task switch
is allowed to finish its already-started selection. Unit tests verify limit
validation, idempotent release, close/shutdown accounting and closing-state
execution guards. Existing delayed-response/terminal, workspace recovery/switch,
heartbeat, outbound slow-peer and send-error coverage remains applicable.

The previously recorded snapshot producer finding (TODO-016) and inbound parsing,
retry jitter, coalescing and workflow binding items remain outside this change.
