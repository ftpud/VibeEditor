# Desktop reconnect retry jitter

Queue `todo-queue-20261012-connectivity`, TODO-013.

ConnectionRecovery previously used the same 250 ms initial retry and doubled it
up to 5000 ms for every client. Clients losing Core together could repeatedly
attempt recovery together, including after reaching the cap.

Each scheduled attempt now draws equal jitter from the upper half of its capped
exponential backoff window. With the defaults, the windows grow independently of
the sampled delay: 250, 500, 1000, 2000, 4000, then 5000 ms. Integer delays are
uniformly selected from `ceil(window / 2)` through `window`, inclusive. This
spreads even the first retry over 125–250 ms and keeps capped retries spread over
2500–5000 ms, without zero-delay retry bursts. Every retry draws again at the cap.
Attempt duration is additional to the delay: attempts never overlap within a loop.

The existing constructor delay arguments configure the initial window and cap;
both must be positive safe integers within the timer range, with initial no larger
than maximum. An optional fifth constructor argument injects `() => number` for
deterministic tests; production uses Math.random without a dependency. Samples
outside [0, 1] are clamped; non-finite samples fall back to 0.5. The pure
`recoveryRetryDelay` helper expects an already validated backoff window.

Each new recovery loop starts from the initial window, including after successful
restoration. Repeated disconnect notifications still share one loop. Stop aborts
scheduled timers and signals active restoration; an obsolete attempt cannot
schedule another retry or clear a replacement loop's controller. Application
restoration guards continue checking the client/root/workspace and abort signal.
Saved root, task, workspace, subscriptions and unsaved buffers use the existing
recovery path. No mutation is automatically replayed. No wire or Protocol version
change is involved.

Fake-timer tests inject opposite random samples into peers to prove different
initial schedules, then verify exponential windows, bounds at the cap, success
reset, timer cleanup and replacement while an old attempt is still pending.
Existing recovery/client/workspace tests cover single-loop ownership, cancellation,
obsolete pending requests, saved selections and dirty buffer retention.

Limits: random delays reduce synchronization but do not guarantee distinct peer
schedules. Math.random is not a cryptographic source; no security property relies
on it. OS suspension/event-loop stalls can delay timers and bunch resumed attempts.
Jitter does not limit Core admission or shorten a blocked connection attempt.
