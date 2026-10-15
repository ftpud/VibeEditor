import { expect, it, vi } from "vitest";
import { retryProcessSpawn } from "./process-spawn.js";

it.each(["EIO", "EMFILE", "ENFILE", "EAGAIN"])("recovers a transient spawn %s without replaying a started command", async (code) => {
  const operation = vi.fn().mockRejectedValueOnce(Object.assign(new Error(`spawn ${code}`), { code, syscall: "spawn git" })).mockResolvedValue({ stdout: "created" });
  const pause = vi.fn(async () => {});
  expect(await retryProcessSpawn(operation, pause)).toEqual({ stdout: "created" });
  expect(operation).toHaveBeenCalledTimes(2);
});

it("preserves persistent spawn errors after a bounded retry", async () => {
  const error = Object.assign(new Error("spawn EIO"), { code: "EIO", syscall: "spawn git" });
  const operation = vi.fn().mockRejectedValue(error);
  await expect(retryProcessSpawn(operation, async () => {})).rejects.toBe(error);
  expect(operation).toHaveBeenCalledTimes(3);
});

it.each([{ code: 1 }, { code: "ENOENT", syscall: "spawn git" }, { code: "EIO", syscall: "read" }])("does not retry commands that exited or permanent failures: %j", async (detail) => {
  const error = Object.assign(new Error("failed"), detail);
  const operation = vi.fn().mockRejectedValue(error);
  await expect(retryProcessSpawn(operation)).rejects.toBe(error);
  expect(operation).toHaveBeenCalledOnce();
});
