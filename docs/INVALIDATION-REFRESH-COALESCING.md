# Configuration and process invalidation refreshes

Queue `todo-queue-20261012-connectivity`, TODO-014.

App previously started four configuration refresh functions for every
`configuration.changed` event and called `processes.list` for every
`processes.changed`. Agent refresh also loads the skill catalogue, so each
configuration batch performs five reads. Bursts could multiply concurrent reads
and older results could overwrite a replaced client's visible state.

`InvalidationRefreshes` now owns two independent snapshot channels for each
connection, reusing `CoalescedAsyncAction`: configuration and processes. Each
channel has at most one active batch and one pending follow-up bit. Events received
while a batch is running set that bit; an event during the follow-up retains one
further batch. A sustained event stream therefore keeps fetching current snapshots
without growing a queue. Configuration batches await all sibling refreshes, even
when one fails, before releasing the active batch. Failure is reported only for
the current scope; another event can retry. No timer, payload backlog or dependency
is introduced.

Local configuration events for other roots remain ignored. Global configuration
hints refresh the active root, and group-wide process hints refresh its process
snapshot. Guards capture root, workspace and task-switch revision and confirm the
same live client is still active. Reset/disposal permanently invalidates old batch
commit guards and discards their follow-up. App resets on transport loss/recovery
failure and selection transitions, and disposes on connection replacement,
explicit disconnect and unmount. A reconnect reuses the CoreClient but gets a fresh
batch epoch: old results cannot revive merely because the same root becomes active
again. After a completed root/task selection App also schedules a fresh configuration
batch for the new scope, so an invalidation discarded during transition cannot
leave its configuration snapshots stale. The affected tasks, agents, skills,
useful files, harnesses and process
refresh functions check guards before updating state or issuing the second agent
read. Process success/error/loading updates also retain the existing request-order
guard and check the active client.

Only these two event-driven snapshot channels change. Manual refreshes, mutations,
workflow operations, terminal output/exits and AI activity retain their existing
routing and ordering. Saved agent selection, skill catalogues, task selection,
harness diagnostics and process loading/error semantics remain in the existing App
refresh functions. Existing heartbeat/recovery, admission and Protocol validation
are unchanged. No Protocol or wire version change is needed.

Deferred-request regression checks exercise the same five-read configuration
pipeline and separate process channel. One initial invalidation pair plus 100
pairs during the batch produces twelve reads: two five-read configuration batches
and two process reads, versus 606 uncoalesced reads. Checks cover events during a
follow-up, a failed configuration read with siblings held, a failed process read
then another event, foreign/global roots, queued work disposal, same-client
reconnect, root/task changes and replacement/unmount. Final visible snapshots are
checked, not just callback counts. Existing CoreClient tests also continue passing.

Limits: already-issued reads are not cancelled on disposal, but their results and
errors are guarded and queued follow-ups are dropped. Explicit user refreshes and
existing AI/status-driven process refresh calls can still run alongside these
event channels; their existing ordering guard prevents older process snapshots
from winning. Root/task transitions retain their existing explicit state refreshes and schedule
a configuration reconciliation for the new scope.
The tests simulate deferred service responses rather than mounting the full
Electron/Monaco application. Continuous invalidations can keep requesting one
batch at a time; this is coalescing, not a time-based rate limit.
