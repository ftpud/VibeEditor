/** Optional panels must not delay workspace readiness or reject its connection. */
export function startBackgroundLoading(loads: Array<() => Promise<unknown>>, canApply: () => boolean, onFailure: () => void): void {
  void Promise.allSettled(loads.map((load) => Promise.resolve().then(load))).then((results) => {
    if (canApply() && results.some((result) => result.status === "rejected")) onFailure();
  });
}
