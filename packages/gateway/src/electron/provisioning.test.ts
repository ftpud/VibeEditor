import assert from "node:assert/strict";
import test from "node:test";
import { boundedProvisioningLog, classifyProvisioningFailure, redactProvisioningLog } from "./provisioning.js";

test("provisioning logs redact credentials and retain only a bounded tail", () => {
  assert.equal(redactProvisioningLog("token=secret https://user:password@example.com/repo"), "token=[redacted] https://user:[redacted]@example.com/repo");
  const lines = boundedProvisioningLog(Array.from({ length: 82 }, (_, index) => `line-${index}`), 80);
  assert.equal(lines.length, 80);
  assert.equal(lines[0], "line-2");
});

test("provisioning failures expose conservative retry and repair actions", () => {
  assert.deepEqual(classifyProvisioningFailure(new Error("node-pty could not be built")), { message: "node-pty could not be built", retryable: true, repairable: true });
  assert.deepEqual(classifyProvisioningFailure(new Error("Provisioning cancelled")), { message: "Provisioning cancelled", retryable: true, repairable: false });
  assert.equal(classifyProvisioningFailure(new Error("permission denied")).retryable, false);
});
