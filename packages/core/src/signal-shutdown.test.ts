import { afterEach, describe, expect, it, vi } from "vitest";
import { installSignalShutdown, type ShutdownSignal, type ShutdownSignalRuntime } from "./signal-shutdown.js";

class FakeRuntime implements ShutdownSignalRuntime {
  readonly listeners = new Map<ShutdownSignal, Set<() => void>>();
  readonly exits: number[] = [];
  readonly errors: unknown[] = [];

  on(signal: ShutdownSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: ShutdownSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  exit(code: number): void { this.exits.push(code); }
  log(error: unknown): void { this.errors.push(error); }

  signal(signal: ShutdownSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("installSignalShutdown", () => {
  it("waits for successful shutdown before exiting with success", async () => {
    const runtime = new FakeRuntime();
    const shutdownFinished = deferred<void>();
    const shutdown = vi.fn(() => shutdownFinished.promise);
    installSignalShutdown(shutdown, { runtime });

    runtime.signal("SIGTERM");
    await flushMicrotasks();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(runtime.exits).toEqual([]);

    shutdownFinished.resolve();
    await flushMicrotasks();
    expect(runtime.exits).toEqual([0]);
    expect(runtime.errors).toEqual([]);
  });

  it("reports shutdown rejection and exits unsuccessfully", async () => {
    const runtime = new FakeRuntime();
    const failure = new Error("drain failed");
    installSignalShutdown(() => Promise.reject(failure), { runtime });

    runtime.signal("SIGINT");
    await flushMicrotasks();

    expect(runtime.errors).toEqual([failure]);
    expect(runtime.exits).toEqual([1]);
  });

  it("ignores repeated signals while shutdown is in progress", async () => {
    const runtime = new FakeRuntime();
    const shutdownFinished = deferred<void>();
    const shutdown = vi.fn(() => shutdownFinished.promise);
    installSignalShutdown(shutdown, { runtime });

    runtime.signal("SIGTERM");
    runtime.signal("SIGINT");
    runtime.signal("SIGTERM");
    await flushMicrotasks();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(runtime.exits).toEqual([]);

    shutdownFinished.resolve();
    await flushMicrotasks();
    expect(runtime.exits).toEqual([0]);
  });

  it("logs timeout and exits unsuccessfully when shutdown exceeds its deadline", async () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    const shutdownFinished = deferred<void>();
    installSignalShutdown(() => shutdownFinished.promise, { runtime, timeoutMs: 25 });

    runtime.signal("SIGTERM");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(25);

    expect(runtime.errors).toHaveLength(1);
    expect(runtime.errors[0]).toMatchObject({ message: "Graceful shutdown timed out after 25 ms" });
    expect(runtime.exits).toEqual([1]);

    // A late shutdown result cannot convert an already timed-out exit into success.
    shutdownFinished.resolve();
    await flushMicrotasks();
    expect(runtime.exits).toEqual([1]);
  });

  it("uses a 30-second default shutdown deadline", async () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    installSignalShutdown(() => new Promise<void>(() => {}), { runtime });

    runtime.signal("SIGTERM");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runtime.exits).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.errors[0]).toMatchObject({ message: "Graceful shutdown timed out after 30000 ms" });
    expect(runtime.exits).toEqual([1]);
  });

  it("disposes both signal listeners without exiting the process", () => {
    const runtime = new FakeRuntime();
    const shutdown = vi.fn(async () => {});
    const dispose = installSignalShutdown(shutdown, { runtime });

    expect(runtime.listeners.get("SIGTERM")?.size).toBe(1);
    expect(runtime.listeners.get("SIGINT")?.size).toBe(1);
    dispose();
    dispose();
    runtime.signal("SIGTERM");
    runtime.signal("SIGINT");

    expect(shutdown).not.toHaveBeenCalled();
    expect(runtime.listeners.get("SIGTERM")?.size).toBe(0);
    expect(runtime.listeners.get("SIGINT")?.size).toBe(0);
    expect(runtime.exits).toEqual([]);
  });

  it("rejects unbounded or invalid timeout values", () => {
    const runtime = new FakeRuntime();
    expect(() => installSignalShutdown(async () => {}, { runtime, timeoutMs: 0 })).toThrow(RangeError);
    expect(() => installSignalShutdown(async () => {}, { runtime, timeoutMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(runtime.listeners.size).toBe(0);
  });
});
