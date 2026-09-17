import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Client } from "ssh2";
import { SshTunnel, type SshTunnelStatus } from "./ssh-tunnel.js";

class FakeClient extends EventEmitter {
  ended = false;
  end(): this { this.ended = true; return this; }
  forwardOut(): void { /* No local connections are needed for lifecycle tests. */ }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for tunnel state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("reconnects a closed SSH transport without changing the local port", async () => {
  const clients = [new FakeClient(), new FakeClient()];
  const statuses: Array<{ status: SshTunnelStatus; port: number }> = [];
  let connects = 0;
  const tunnel = new SshTunnel({
    localPort: 0,
    remotePort: 7331,
    reconnectDelayMs: 1,
    connect: async () => clients[connects++] as unknown as Client,
    onStatus: (status, port) => statuses.push({ status, port }),
  });

  const port = await tunnel.start();
  clients[0]!.emit("close");
  await until(() => connects === 2 && statuses.at(-1)?.status === "running");

  assert.equal(tunnel.localPort, port);
  assert.equal(statuses.at(-1)?.port, port);
  tunnel.stop();
});

test("catches transport errors and retries failed reconnects in the background", async () => {
  const first = new FakeClient();
  const replacement = new FakeClient();
  let connects = 0;
  const tunnel = new SshTunnel({
    localPort: 0,
    remotePort: 7331,
    reconnectDelayMs: 1,
    connect: async () => {
      connects += 1;
      if (connects === 1) return first as unknown as Client;
      if (connects === 2) throw new Error("network is still waking up");
      return replacement as unknown as Client;
    },
  });

  await tunnel.start();
  assert.doesNotThrow(() => first.emit("error", new Error("socket closed after sleep")));
  await until(() => connects === 3);
  assert.equal(first.ended, true);
  tunnel.stop();
});

test("resume reconnect is immediate and preserves the bound port", async () => {
  const clients = [new FakeClient(), new FakeClient()];
  let connects = 0;
  const tunnel = new SshTunnel({ localPort: 0, remotePort: 7331, connect: async () => clients[connects++] as unknown as Client });
  const port = await tunnel.start();

  tunnel.reconnect();
  await until(() => connects === 2);

  assert.equal(tunnel.localPort, port);
  assert.equal(clients[0]!.ended, true);
  tunnel.stop();
});
