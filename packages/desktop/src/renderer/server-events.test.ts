import { describe, expect, it } from "vitest";
import { isServerEvent, serverEventTypes, type ServerEvent } from "@remote-ide/protocol";

type Examples = { [K in ServerEvent["type"]]: Extract<ServerEvent, { type: K }> };
const examples = {
  "processes.changed": { type: "processes.changed", payload: {} },
  "configuration.changed": { type: "configuration.changed", payload: { rootId: "root", resource: "settings", global: true } },
  "timers.changed": { type: "timers.changed", payload: {} },
  "workflow.document": { type: "workflow.document", payload: { rootId: "root", runId: "run", blockId: "block", title: "", content: "markdown" } },
  "filesystem.changed": { type: "filesystem.changed", payload: { rootId: "root", paths: ["file.txt"], overflow: false, health: "healthy", message: "ready" } },
  "terminal.output": { type: "terminal.output", payload: { rootId: "root", terminalId: "terminal", data: "" } },
  "terminal.exit": { type: "terminal.exit", payload: { rootId: "root", terminalId: "terminal", exitCode: 0 } },
  "git.changed": { type: "git.changed", payload: { rootId: "root" } },
  "taskGit.changed": { type: "taskGit.changed", payload: { rootId: "root" } },
  "java.semantic.changed": { type: "java.semantic.changed", payload: { rootId: "root" } },
  "java.output": { type: "java.output", payload: { rootId: "root", data: "text" } },
  "java.exit": { type: "java.exit", payload: { rootId: "root", exitCode: null, signal: null } },
  "java.debug.state": { type: "java.debug.state", payload: { rootId: "root", status: "paused", variables: [{ name: "a", value: "1", reference: "r", type: "int", objectId: "id", indexedCount: 1 }], path: "Main.java", className: "Main", method: "main", line: 5, applyingChanges: true, inspectionError: "", stopReason: "breakpoint" } },
  "ai.changed": { type: "ai.changed", payload: { rootId: "root" } },
  "tasks.changed": { type: "tasks.changed", payload: { rootId: "root" } },
  "commit-message.changed": { type: "commit-message.changed", payload: { rootId: "root", workspace: "/project", message: "commit" } },
  "runConfig.changed": { type: "runConfig.changed", payload: { rootId: "root", configs: [{ scope: "local", name: "run", commands: "echo", status: "running", terminalId: "terminal", exitCode: 0 }] } },
  "harness.changed": { type: "harness.changed", payload: { rootId: "root", runId: "run" } }
} satisfies Examples;

describe("Protocol server event validation", () => {
  it("covers every registered event and preserves valid wire payloads", () => {
    expect(Object.keys(examples).sort()).toEqual([...serverEventTypes].sort());
    for (const example of Object.values(examples)) {
      expect(isServerEvent(JSON.parse(JSON.stringify(example)))).toBe(true);
      expect(isServerEvent({ ...example, extra: "compatible", payload: { ...example.payload, extra: true } })).toBe(true);
      for (const payload of [undefined, null, [], "wrong"]) expect(isServerEvent({ ...example, payload })).toBe(false);
      expect(isServerEvent({ ...example, id: "response" })).toBe(false);
    }
  });
  it("checks required and optional primitives and nested arrays", () => {
    const invalid = [
      { type: "terminal.output", payload: { rootId: "r", terminalId: "t", data: 3 } },
      { type: "git.changed", payload: {} },
      { type: "timers.changed", payload: { rootId: null } },
      { type: "filesystem.changed", payload: { rootId: "r", paths: [null], overflow: false, health: "healthy" } },
      { type: "filesystem.changed", payload: { rootId: "r", paths: [], overflow: "false", health: "invalid" } },
      { ...examples["java.debug.state"], payload: { ...examples["java.debug.state"].payload, variables: [null] } },
      { ...examples["java.debug.state"], payload: { ...examples["java.debug.state"].payload, variables: [{ name: "a", value: {} }] } },
      { ...examples["java.debug.state"], payload: { ...examples["java.debug.state"].payload, variables: [{ name: "a", value: "v", indexedCount: "1" }] } },
      { ...examples["java.debug.state"], payload: { ...examples["java.debug.state"].payload, status: "invalid" } },
      { ...examples["java.debug.state"], payload: { ...examples["java.debug.state"].payload, line: Infinity } },
      { ...examples["runConfig.changed"], payload: { rootId: "r", configs: [null] } },
      { ...examples["runConfig.changed"], payload: { rootId: "r", configs: [{ scope: "local", name: "n", commands: "c", status: "running", terminalId: 1 }] } },
      { ...examples["runConfig.changed"], payload: { rootId: "r", configs: [{ scope: "other", name: "n", commands: "c", status: "unknown" }] } },
      { type: "java.exit", payload: { rootId: "r", exitCode: null } },
      { type: "commit-message.changed", payload: { rootId: "r", message: "m", workspace: null } }
    ];
    for (const value of invalid) expect(isServerEvent(value)).toBe(false);
    for (const value of [null, [], 3, {}, { type: "__proto__", payload: {} }, { type: "future.event", payload: {} }]) expect(isServerEvent(value)).toBe(false);
  });
  it("accepts optional omissions, enum variants and nullable Java exits emitted by Core", () => {
    for (const scope of ["global", "local"]) for (const status of ["idle", "starting", "running", "stopping", "succeeded", "failed"]) {
      expect(isServerEvent({ type: "runConfig.changed", payload: { rootId: "r", configs: [{ scope, name: "", commands: "", status }] } })).toBe(true);
    }
    for (const status of ["starting", "running", "paused", "stopped"]) expect(isServerEvent({ type: "java.debug.state", payload: { rootId: "r", status, variables: [] } })).toBe(true);
    for (const exitCode of [null, 0, 1]) for (const signal of [null, "SIGTERM"]) expect(isServerEvent({ type: "java.exit", payload: { rootId: "r", exitCode, signal } })).toBe(true);
    expect(isServerEvent({ type: "filesystem.changed", payload: { rootId: "r", paths: [], overflow: true, health: "degraded" } })).toBe(true);
    expect(isServerEvent({ type: "commit-message.changed", payload: { rootId: "r", message: "" } })).toBe(true);
    expect(isServerEvent({ type: "timers.changed", payload: { rootId: "r" } })).toBe(true);
  });
});
