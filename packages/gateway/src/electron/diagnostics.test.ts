import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectionDiagnostics, redactDiagnosticText } from "./diagnostics.js";

test("diagnostics redact credential forms and environment values", () => {
  const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret material\n-----END OPENSSH PRIVATE KEY-----";
  const value = redactDiagnosticText(`password=hunter2 token: abc Bearer xyz https://user:pass@example.test ${privateKey} PATH=/secret/bin`);
  assert.doesNotMatch(value, /hunter2|\babc\b|\bxyz\b|:pass@|secret material|\/secret\/bin/);
  assert.match(value, /password=\[redacted\]/);
});

test("connection diagnostics include state, stage, version, latency, timestamps, and a bounded redacted log tail", () => {
  const report = buildConnectionDiagnostics({
    generatedAt: "2026-08-31T12:00:00.000Z", version: "0.1.0", platform: "linux-x64",
    connection: { name: "Production", authenticationMethod: "privateKey" },
    connectionRuntime: { status: "slow", stage: "ssh-health-check", message: "Connected", latencyMs: 812, updatedAt: "2026-08-31T11:59:59.000Z" },
    workspaces: [{ id: "workspace-1", name: "API", remotePort: 7331 }],
    runtimes: { "workspace-1": { status: "error", stage: "npm-build", message: "token=message-secret", updatedAt: "2026-08-31T11:59:58.000Z", logs: Array.from({ length: 45 }, (_, index) => `line-${index} password=log-secret`) } },
    tunnels: [{ id: "tunnel-1", port: 5432 }], tunnelRuntimes: { "tunnel-1": { status: "running", message: "Forwarding", updatedAt: "2026-08-31T11:59:57.000Z" } },
  });
  assert.match(report, /generated=2026-08-31T12:00:00.000Z/);
  assert.match(report, /version=0.1.0 platform=linux-x64/);
  assert.match(report, /state=slow stage=ssh-health-check .*latency=812ms/);
  assert.match(report, /workspace API core-port=7331: state=error stage=npm-build/);
  assert.match(report, /provisioning-log-tail \(40\/40 max\):/);
  assert.doesNotMatch(report, /line-[0-4]\b|message-secret|log-secret/);
  assert.match(report, /line-5 password=\[redacted\]/);
});
