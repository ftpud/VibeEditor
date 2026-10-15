import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Client } from "ssh2";
import { executeSshCommand } from "./ssh-command.js";

function begin() {
  const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close() {} });
  const client = Object.assign(new EventEmitter(), { exec(_command: string, callback: (error: undefined, stream: typeof channel) => void) { callback(undefined, channel); } });
  return { channel, client, result: executeSshCommand(client as unknown as Client, "activate") };
}

test("reports an unknown outcome when SSH drops after the activation marker", async () => {
  const { channel, client, result } = begin();
  channel.emit("data", Buffer.from("VIBE_ACTIVATED:release\n"));
  client.emit("close");
  await assert.rejects(result, /SSH command interrupted: connection closed.*remote command may still be running/s);
  assert.equal(client.listenerCount("close"), 0);
});

test("requires an exit status instead of treating an empty channel close as success", async () => {
  const { channel, result } = begin();
  channel.emit("close");
  await assert.rejects(result, /without an exit status/);
});

for (const source of ["channel", "client"] as const) {
  test(`rejects ${source} errors without leaving the command pending`, async () => {
    const running = begin();
    running[source].emit("error", new Error("connection reset"));
    await assert.rejects(running.result, /SSH command interrupted: connection reset/);
  });
}

test("preserves a confirmed successful status if the transport closes afterwards", async () => {
  const { channel, client, result } = begin();
  channel.emit("data", Buffer.from("7331\n"));
  channel.stderr.emit("data", Buffer.from("remote shell warning\n"));
  channel.emit("exit", 0);
  client.emit("close");
  assert.equal(await result, "7331\n");
});

test("retains remote command failure diagnostics", async () => {
  const { channel, result } = begin();
  channel.stderr.emit("data", Buffer.from("Candidate failed; previous release restored"));
  channel.emit("exit", 1); channel.emit("close");
  await assert.rejects(result, /Candidate failed; previous release restored/);
});

test("includes the exit status when activation output accompanies a nonzero close", async () => {
  const { channel, result } = begin();
  channel.emit("data", Buffer.from("VIBE_ACTIVATED:release\n"));
  channel.emit("exit", 143); channel.emit("close", 143);
  await assert.rejects(result, /Remote command exited with 143\nVIBE_ACTIVATED:release/);
});
