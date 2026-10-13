# Desktop incoming event validation

Queue `todo-queue-20261012-connectivity`, TODO-012.

Previously CoreClient treated any parsed object containing `type` as a
`ServerEvent`. App handlers immediately dereference payload fields and nested
values, so missing/null payloads or malformed arrays could throw or poison UI
state before subsequent messages were processed.

Protocol now exports `isServerEvent` and a compile-time-exhaustive
`serverEventTypes` registry from `src/server-events.ts`. The registry accounts for
every `ServerEvent` variant and each payload field. Nested Java debugger variables
and run configurations also use field-exhaustive schemas. Validators check
non-null object envelopes/payloads, known event types, required/optional primitive
fields, literal enum values, arrays and their elements, nullable Java exit fields,
and finite numeric values. No provider-specific logic is involved.

Events carrying response envelope fields (`id` or `ok`) are rejected rather than
dispatched or allowed to settle pending requests. Unknown types, malformed JSON,
primitive/array envelopes and invalid event payloads are ignored. CoreClient
continues processing the following messages: pending response IDs/timers remain
unchanged until a valid response, normal timeout or disconnect. Existing response
handling and valid event values remain intact; events are not sanitized, cloned,
coalesced, replayed, or reordered. The renderer callback receives the parsed
validated event object.

Extra fields are allowed so compatible additions do not silently discard valid
Core events. Empty string values are valid where Protocol permits strings; this
is shape validation, not path/identity authorization. `processes.changed` accepts
an object payload and `timers.changed` permits omission of its root ID, matching
Core's group-wide notifications. Optional fields may be absent, but null is only
accepted where the declared Protocol type permits it. All registered event types
have typed valid examples in the regression suite; enum variants, optional
omissions and nullable values are exercised separately. Compile-time schema and
example coverage forces review when Protocol fields or events change.

Diagnostics use one fixed warning, `[core-client] Ignoring invalid server message`,
at most five times per CoreClient lifetime (including reconnections). No raw
message, type, field value, ID or payload is logged. There are no diagnostic
timers or unbounded counters. Malformed input does not trigger an automatic
reconnect or retry. Heartbeat, outbound budgeting, admission and workspace switch
behavior are unchanged. There is no wire-format change or Protocol version bump.

Focused tests send repeated malformed JSON/events and malformed/hybrid envelopes
with a live pending request, verify no renderer dispatch or settlement occurs,
then deliver a valid terminal event and correlated response successfully. Nested
invalid run configurations/debugger variables, field types and enums are covered,
along with all 18 currently registered event types. Existing out-of-order response,
disconnect/recovery and healthy-idle coverage still applies.

Limits: this does not impose input byte/rate/array-length limits, validate every
operation-specific response result, or isolate exceptions thrown by application
handlers for otherwise valid events. Those are separate concerns. Unknown event
types are intentionally ignored until registered; extra fields on known types
remain accepted. The previously recorded snapshot producer and other connectivity
queue items remain outside this change.
