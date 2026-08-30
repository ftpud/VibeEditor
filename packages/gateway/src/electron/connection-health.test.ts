import assert from "node:assert/strict";
import test from "node:test";
import { connectionHealthForLatency } from "./connection-health.js";

test("marks SSH setup at one second or more as slow", () => {
  assert.deepEqual(connectionHealthForLatency(1_000), { status: "slow", latencyMs: 1_000, message: "SSH connected slowly (1000 ms)" });
});

test("reports faster SSH setup as online", () => {
  assert.equal(connectionHealthForLatency(82).status, "online");
});
