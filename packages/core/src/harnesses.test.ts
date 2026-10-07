import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateHarness } from "./harness-graph.js";
import { HarnessStore } from "./harnesses.js";

describe("HarnessStore", () => {
  it("persists workspace-isolated definitions and increments versions", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const first = new HarnessStore("/workspace/first", state);
    const second = new HarnessStore("/workspace/second", state);
    const created = await first.create("Review flow");
    const updated = await first.update({
      ...created,
      blocks: [{ id: "review", type: "prompt", label: "Review", prompt: "Review {{input}}", position: { x: 20, y: 30 } }],
      edges: []
    });

    expect(updated.version).toBe(2);
    expect((await first.list())[0]?.blocks[0]?.label).toBe("Review");
    expect(await second.list()).toEqual([]);

    await first.delete(created.id);
    expect(await first.list()).toEqual([]);
  });

  it("creates and persists the five-minute button template", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-template-")); const store = new HarnessStore("/workspace", directory);
    const template = await store.create("Recurring check-in", "five-minute-check-in");
    expect(validateHarness(template).valid).toBe(true);
    expect(template.blocks.map((block) => block.type)).toEqual(["start_button", "start_input", "ai", "timer", "text", "script", "ai", "user_prompt", "ai", "text"]);
    expect(template.blocks.find((block) => block.id === "repeat-timer")).toMatchObject({ id: "repeat-timer", type: "timer", seconds: 300 });
    expect(template.blocks.find((block) => block.id === "check-in")?.prompt).toContain('block_id: "repeat-timer"');
    expect(template.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "start", to: "check-in", type: "follow" }),
      expect.objectContaining({ from: "check-in", to: "repeat-timer", type: "use" }),
      expect.objectContaining({ from: "repeat-timer", to: "check-in", type: "follow" }),
      expect.objectContaining({ from: "check-in", to: "report-agent", type: "path", label: "report" }),
      expect.objectContaining({ from: "check-in", to: "user-question", type: "path", label: "ask-user" })
    ]));
    expect(await new HarnessStore("/workspace", directory).read(template.id)).toEqual(template);
  });

  it("rejects invalid names and stale identifiers", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const store = new HarnessStore("/workspace", state);
    await expect(store.create("   ")).rejects.toThrow("1–120");
    await expect(store.delete("missing")).rejects.toThrow("does not exist");
  });

  it("redacts secret-like values before persisting workflow definitions and runs", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-redaction-")); const store = new HarnessStore("/workspace", state); const created = await store.create("Flow");
    const definition = await store.update({ ...created, blocks: [{ id: "worker", type: "prompt", label: "Worker", prompt: "Use api_key=super-secret-value and sk_abcdefghijklmnop", position: { x: 0, y: 0 } }], edges: [] });
    await store.saveRun({ id: "run", harnessId: definition.id, harnessVersion: definition.version, input: "Authorization: bearer-secret", status: "succeeded", createdAt: "now", blocks: [{ blockId: "worker", status: "succeeded", prompt: "token=provider-secret", output: "password: output-secret", log: [{ timestamp: "now", kind: "response", message: "secret=log-secret" }] }] });
    expect((await store.read(definition.id)).blocks[0]?.prompt).toContain("[REDACTED]");
    const run = (await store.runs())[0]!;
    expect(JSON.stringify(run)).not.toContain("secret-value");
    expect(JSON.stringify(run)).not.toContain("output-secret");
    expect(JSON.stringify(run)).toContain("[REDACTED]");
  });

  it("deletes completed runs but retains active run history", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "workflow-delete-run-")); const store = new HarnessStore("/workspace", state); const definition = await store.create("Flow");
    await store.saveRun({ id: "completed", harnessId: definition.id, harnessVersion: 1, input: "work", status: "succeeded", createdAt: "now", blocks: [] });
    await store.saveRun({ id: "active", harnessId: definition.id, harnessVersion: 1, input: "work", status: "running", createdAt: "now", blocks: [] });
    await store.deleteRun("completed");
    expect((await store.runs()).map((run) => run.id)).toEqual(["active"]);
    await expect(store.deleteRun("active")).rejects.toThrow("Cancel an active");
  });

  it("serializes concurrent creates without losing definitions", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const store = new HarnessStore("/workspace", state); const secondInstance = new HarnessStore("/workspace", state);
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? store : secondInstance).create(`Flow ${index}`)));
    expect(await store.list()).toHaveLength(20);
  });

  it("rejects a stale definition update", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const store = new HarnessStore("/workspace", state); const created = await store.create("Flow");
    await store.update({ ...created, name: "First save" });
    await expect(store.update({ ...created, name: "Stale save" })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("changed since") });
    expect((await store.read(created.id)).name).toBe("First save");
  });

  it("reads the atomic backup when the current definition file is corrupt", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const store = new HarnessStore("/workspace", state); const created = await store.create("Flow");
    await store.update({ ...created, name: "Updated" });
    const key = crypto.createHash("sha256").update("/workspace").digest("hex");
    const directory = path.join(state, "harnesses", key); const target = path.join(directory, "index.json");
    expect(JSON.parse(await readFile(`${target}.bak`, "utf8"))).toMatchObject({ schemaVersion: 1 });
    await writeFile(target, "not json", "utf8");
    expect((await store.list())[0]?.name).toBe("Flow");
    const quarantined = await readdir(path.join(directory, "quarantine"));
    expect(quarantined).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(directory, "quarantine", quarantined[0]!), "utf8"))).toMatchObject({ source: "index.json", value: "not json" });
  });

  it("recovers valid definitions and runs from backups after truncated state files and reports diagnostics", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-")); const store = new HarnessStore("/workspace", state); const created = await store.create("Flow");
    await store.update({ ...created, name: "Newer flow" });
    await store.saveRun({ id: "run-1", harnessId: created.id, harnessVersion: 1, input: "first", status: "succeeded", createdAt: "now", blocks: [] });
    await store.saveRun({ id: "run-2", harnessId: created.id, harnessVersion: 1, input: "second", status: "succeeded", createdAt: "later", blocks: [] });
    const key = crypto.createHash("sha256").update("/workspace").digest("hex"); const directory = path.join(state, "harnesses", key);
    await writeFile(path.join(directory, "index.json"), "{\"schemaVersion\":1,\"definitions\":[", "utf8");
    await writeFile(path.join(directory, "runs.json"), "{\"schemaVersion\":1,\"runs\":[", "utf8");

    const recovered = new HarnessStore("/workspace", state);
    expect((await recovered.list()).map((definition) => definition.name)).toEqual(["Flow"]);
    expect((await recovered.runs()).map((run) => run.id)).toEqual(["run-1"]);
    expect(await recovered.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "index.json", reason: expect.stringContaining("Unexpected end") }),
      expect.objectContaining({ source: "runs.json", reason: expect.stringContaining("Unexpected end") })
    ]));
  });

  it("quarantines malformed records while retaining valid definitions and runs", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const store = new HarnessStore("/workspace", state); const created = await store.create("Flow");
    await store.saveRun({ id: "valid-run", harnessId: created.id, harnessVersion: 1, input: "work", status: "succeeded", createdAt: "now", blocks: [] });
    const key = crypto.createHash("sha256").update("/workspace").digest("hex"); const directory = path.join(state, "harnesses", key);
    await writeFile(path.join(directory, "index.json"), `${JSON.stringify({ schemaVersion: 1, definitions: [created, { id: "broken" }] })}\n`, "utf8");
    await writeFile(path.join(directory, "runs.json"), `${JSON.stringify({ schemaVersion: 1, runs: [{ id: "broken" }, { id: "valid-run", harnessId: created.id, harnessVersion: 1, input: "work", status: "succeeded", createdAt: "now", blocks: [] }] })}\n`, "utf8");

    expect((await store.list()).map((definition) => definition.id)).toEqual([created.id]);
    expect((await store.runs()).map((run) => run.id)).toEqual(["valid-run"]);
    const quarantined = await readdir(path.join(directory, "quarantine"));
    expect(quarantined).toHaveLength(2);
  });

  it("recovers from an unsupported current schema using the last valid backup", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-"));
    const store = new HarnessStore("/workspace", state); const created = await store.create("Flow");
    await store.update({ ...created, name: "Updated" });
    const key = crypto.createHash("sha256").update("/workspace").digest("hex"); const directory = path.join(state, "harnesses", key);
    await writeFile(path.join(directory, "index.json"), `${JSON.stringify({ schemaVersion: 999, definitions: [] })}\n`, "utf8");

    expect((await store.list())[0]?.name).toBe("Flow");
    expect(await readdir(path.join(directory, "quarantine"))).toHaveLength(1);
  });

  it("turns orphaned active runs into honest terminal state after restart", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-state-")); const store = new HarnessStore("/workspace", state);
    await store.saveRun({ id: "run", harnessId: "flow", harnessVersion: 1, input: "work", status: "running", createdAt: "now", blocks: [{ blockId: "done", status: "succeeded" }, { blockId: "active", status: "running" }, { blockId: "later", status: "waiting" }] });
    const recovered = await new HarnessStore("/workspace", state).recoverInterruptedRuns();
    expect(recovered).toHaveLength(1); expect(recovered[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Core restarted") });
    expect(recovered[0]?.blocks.map((block) => block.status)).toEqual(["succeeded", "failed", "cancelled"]);
    expect(await new HarnessStore("/workspace", state).recoverInterruptedRuns()).toEqual([]);
  });

  it("recovers persisted pause states instead of leaving runs looking active", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-harness-paused-")); const store = new HarnessStore("/workspace", state);
    await store.saveRun({ id: "run", harnessId: "flow", harnessVersion: 1, input: "work", status: "awaiting_permission", createdAt: "now", blocks: [{ blockId: "approval", status: "awaiting_permission", provider: "codex", sessionId: "session", workspace: "/workflow", pendingPermission: { id: "request", title: "Run command", toolCallId: "tool", options: [] } }] });
    const recovered = await new HarnessStore("/workspace", state).recoverInterruptedRuns();
    expect(recovered[0]).toMatchObject({ status: "failed", blocks: [{ status: "failed", failureReason: "permission_required" }] });
  });
});
