import { expect, it, vi } from "vitest";
import { cleanAcpDiagnostics, isOAuthRefreshContention, retryOAuthRefresh } from "./acp-errors.js";

const contention = Object.assign(new Error("Internal error"), { data: { details: "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh." } });

it("recognizes only transient refresh contention and removes startup traces without hiding errors", () => {
  expect(isOAuthRefreshContention(contention)).toBe(true);
  expect(isOAuthRefreshContention(new Error("Internal error: Failed to refresh OAuth token=[REDACTED] Claude Code process is refreshing it or exited mid-refresh."))).toBe(true);
  expect(isOAuthRefreshContention(new Error("Failed to refresh OAuth token: invalid or revoked refresh token. Sign in again."))).toBe(false);
  expect(isOAuthRefreshContention(new Error("Authentication required"))).toBe(false);
  expect(isOAuthRefreshContention(new Error("Failed to refresh OAuth token: process could not refresh a revoked token"))).toBe(false);
  expect(cleanAcpDiagnostics("OAuth refresh failed\n[session/create] phase=settings\n[session/query] resume=none\n[authStatus] discarding a probe\nfatal: connection closed")).toBe("OAuth refresh failed\nfatal: connection closed");
});

it("retries with bounded delays and returns the successful result", async () => {
  const operation = vi.fn().mockRejectedValueOnce(contention).mockRejectedValueOnce(contention).mockResolvedValue("ok");
  const onRetry = vi.fn(async () => {});
  const result = retryOAuthRefresh(operation, { signal: new AbortController().signal, delays: [1, 2, 3], canRetry: () => true, onRetry });
  await expect(result).resolves.toBe("ok");
  expect(operation).toHaveBeenCalledTimes(3);
  expect(onRetry.mock.calls).toEqual([[1, 1], [2, 2]]);
});

it("stops after the configured retry limit", async () => {
  const operation = vi.fn().mockRejectedValue(contention);
  const result = expect(retryOAuthRefresh(operation, { signal: new AbortController().signal, delays: [5, 10], canRetry: () => true })).rejects.toBe(contention);
  await result;
  expect(operation).toHaveBeenCalledTimes(3);
});

it("does not retry permanent errors or replay work after progress", async () => {
  const error = new Error("Invalid refresh token");
  const operation = vi.fn().mockRejectedValue(error);
  await expect(retryOAuthRefresh(operation, { signal: new AbortController().signal, delays: [1], canRetry: () => true })).rejects.toBe(error);
  expect(operation).toHaveBeenCalledTimes(1);
  operation.mockRejectedValue(contention);
  await expect(retryOAuthRefresh(operation, { signal: new AbortController().signal, delays: [1], canRetry: () => false })).rejects.toBe(contention);
  expect(operation).toHaveBeenCalledTimes(2);
});

it("cancels the backoff immediately and clears its timer", async () => {
  const controller = new AbortController();
  const operation = vi.fn().mockRejectedValue(contention);
  let retrying!: () => void;
  const ready = new Promise<void>((resolve) => { retrying = resolve; });
  const onRetry = vi.fn(async () => { retrying(); });
  const pending = retryOAuthRefresh(operation, { signal: controller.signal, delays: [60000], canRetry: () => true, onRetry });
  const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  expect(onRetry).toHaveBeenCalledOnce();
  controller.abort();
  await result;
  expect(operation).toHaveBeenCalledOnce();
});
