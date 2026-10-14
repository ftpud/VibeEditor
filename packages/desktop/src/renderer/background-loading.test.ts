import { expect, it, vi } from "vitest";
import { startBackgroundLoading } from "./background-loading";

it("starts optional loads concurrently and returns before a slow history settles", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const history = vi.fn(() => slow);
  const usage = vi.fn().mockResolvedValue(undefined);
  const failure = vi.fn();
  expect(startBackgroundLoading([history, usage], () => true, failure)).toBeUndefined();
  await Promise.resolve();
  expect(history).toHaveBeenCalledOnce();
  expect(usage).toHaveBeenCalledOnce();
  expect(failure).not.toHaveBeenCalled();
  release();
});

it("reports optional failures without throwing and ignores failures from an old workspace", async () => {
  const failure = vi.fn();
  startBackgroundLoading([() => { throw new Error("Unreadable history"); }], () => true, failure);
  await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
  startBackgroundLoading([() => Promise.reject(new Error("Old root"))], () => false, failure);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(failure).toHaveBeenCalledOnce();
});
