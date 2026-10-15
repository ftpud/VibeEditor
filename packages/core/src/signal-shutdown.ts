export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ShutdownSignalRuntime {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): unknown;
  log(error: unknown): void;
}

export interface InstallSignalShutdownOptions {
  /** Maximum time to wait for graceful shutdown before exiting with failure. */
  timeoutMs?: number;
  /** Process-like hooks, replaceable so callers can test without exiting. */
  runtime?: ShutdownSignalRuntime;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

const processRuntime: ShutdownSignalRuntime = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  exit: (code) => process.exit(code),
  log: (error) => console.error("Graceful shutdown failed:", error)
};

/** Install SIGTERM/SIGINT handlers that finish shutdown before exiting. */
export function installSignalShutdown(
  shutdown: () => Promise<void>,
  options: InstallSignalShutdownOptions = {}
): () => void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }

  const runtime = options.runtime ?? processRuntime;
  let shuttingDown = false;
  let disposed = false;

  const onSignal = () => {
    if (shuttingDown || disposed) return;
    shuttingDown = true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Graceful shutdown timed out after ${timeoutMs} ms`)), timeoutMs);
    });

    void Promise.race([Promise.resolve().then(shutdown), deadline]).then(
      () => runtime.exit(0),
      (error: unknown) => {
        try { runtime.log(error); }
        finally { runtime.exit(1); }
      }
    ).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };

  runtime.on("SIGTERM", onSignal);
  runtime.on("SIGINT", onSignal);

  return () => {
    if (disposed) return;
    disposed = true;
    runtime.off("SIGTERM", onSignal);
    runtime.off("SIGINT", onSignal);
  };
}
