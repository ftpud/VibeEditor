import { describe, expect, it } from "vitest";
import type { RequestType } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { validateRequestPayload } from "./request-validation.js";

const rejectsPayload = (type: RequestType, payload: unknown) => {
  expect(() => validateRequestPayload(type, payload)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
};

describe("validateRequestPayload", () => {
  it("requires a scan identity and a typed storage cleanup selection", () => {
    expect(() => validateRequestPayload("storage.cleanup", { scanId: "scan", category: "tasks", age: "finished" })).not.toThrow();
    for (const payload of [{ category: "tasks", age: "finished" }, { scanId: "scan", category: "unknown", age: "older" }, { scanId: "scan", category: ["tasks"], age: "finished" }, { scanId: "scan", category: "logs", age: "all" }]) rejectsPayload("storage.cleanup", payload);
  });
  it("requires a plain object envelope for targeted and envelope-only operations", () => {
    for (const payload of [null, [], "payload", 1]) {
      rejectsPayload("tasks.list", payload);
      rejectsPayload("tasks.create", payload);
    }
    rejectsPayload("tasks.list", new Date());
    expect(() => validateRequestPayload("tasks.list", { unexpected: true })).not.toThrow();
  });

  it("validates handshake compatibility ranges and optional strings", () => {
    expect(() => validateRequestPayload("protocol.handshake", {
      compatibility: { minimum: 3, maximum: 8 }, token: "ticket", clientVersion: "1.2.3", extension: true
    })).not.toThrow();
    for (const compatibility of [
      null,
      { minimum: 0, maximum: 8 },
      { minimum: 3, maximum: Number.MAX_SAFE_INTEGER + 1 },
      { minimum: 9, maximum: 8 }
    ]) rejectsPayload("protocol.handshake", { compatibility });
    rejectsPayload("protocol.handshake", { compatibility: { minimum: 1, maximum: 2 }, token: false });
  });

  it("rejects malformed task flags and unsafe delete IDs", () => {
    expect(() => validateRequestPayload("tasks.create", { branch: "feature/x", existing: true, remote: false })).not.toThrow();
    rejectsPayload("tasks.create", { branch: "feature", existing: "false" });
    rejectsPayload("tasks.create", { branch: "feature", remote: 0 });
    expect(() => validateRequestPayload("tasks.delete", { taskId: "task-123" })).not.toThrow();
    for (const taskId of ["", ".", "..", "nested/task", "nested\\task", "bad\0id"]) rejectsPayload("tasks.delete", { taskId });
  });

  it("validates prompt configuration and optional nested ACP field shapes", () => {
    expect(() => validateRequestPayload("tasks.createFromPrompt", {
      prompt: "Implement the request", configuration: { model: "model-a" }, provider: "codex",
      content: [], mcpServers: [{ name: "local", command: "mcp", args: ["serve"], env: { MODE: "test" } }],
      skillIds: ["local/skill"], agent: { name: "Reviewer", instructions: "Review changes", description: "Checks code", mcpServers: ["local"] },
      agentPreset: { scope: "workspace", name: "reviewer" }, extension: "kept"
    })).not.toThrow();
    expect(() => validateRequestPayload("tasks.createFromPrompt", {
      prompt: " ", configuration: {}, content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]
    })).not.toThrow();
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: [] });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go" });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, provider: "" });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, skillIds: ["ok", 2] });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, agentPreset: null });
    rejectsPayload("tasks.createFromPrompt", { prompt: " ", configuration: {}, content: [] });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, content: [{ type: "text", text: 1 }] });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, content: [{ type: "unknown" }] });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, content: [{ type: "resource_link", uri: "uri", name: "file", size: -1 }] });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: { nested: { value: "bad" } } });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: { value: null } });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: { value: Number.NaN } });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, agent: { name: "Reviewer" } });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, agentPreset: { scope: "provider", name: "reviewer" } });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, mcpServers: [null] });
    rejectsPayload("tasks.createFromPrompt", { prompt: "go", configuration: {}, mcpServers: [{ transport: "http", name: "remote", url: "https://example.test", headers: { Authorization: 5 } }] });
    rejectsPayload("tasks.createFromPrompt", { prompt: `go${"x".repeat(100_000)}`, configuration: {} });
  });

  it("requires explicit boolean confirmation and well-shaped transfer items", () => {
    expect(() => validateRequestPayload("filesystem.transferApply", {
      kind: "move", confirmed: true, items: [{ source: "a.txt", destination: "b.txt" }], overwritePaths: [], openFiles: [], dirtyFiles: []
    })).not.toThrow();
    rejectsPayload("filesystem.transferApply", { kind: "copy", confirmed: "false", items: [] });
    rejectsPayload("filesystem.transferApply", { kind: "copy", confirmed: false, items: [null] });
    rejectsPayload("filesystem.transferApply", { kind: "move", confirmed: false, items: [{ source: "a.txt" }] });
    rejectsPayload("filesystem.transferApply", { kind: "link", confirmed: true, items: [] });
    rejectsPayload("filesystem.transferApply", { kind: "move", confirmed: false, items: [], dirtyFiles: [1] });
  });

  it("validates remote transfer options before a ticket can be created", () => {
    expect(() => validateRequestPayload("filesystem.remoteTransferBegin", {
      direction: "upload", path: "assets/data.bin", size: 0, overwrite: false, mode: 0o600
    })).not.toThrow();
    expect(() => validateRequestPayload("filesystem.remoteTransferBegin", { direction: "download", path: "data.bin" })).not.toThrow();
    rejectsPayload("filesystem.remoteTransferBegin", { direction: "upload", path: "data.bin", size: 1, overwrite: "false" });
    rejectsPayload("filesystem.remoteTransferBegin", { direction: "upload", path: "data.bin", size: -1 });
    rejectsPayload("filesystem.remoteTransferBegin", { direction: "upload", path: "data.bin", mode: 0o1000 });
    rejectsPayload("filesystem.remoteTransferBegin", { direction: "copy", path: "data.bin" });
  });

  it("leaves other operations at envelope validation without rejecting extensions", () => {
    expect(() => validateRequestPayload("git.commit", { futureProtocolField: { value: true } })).not.toThrow();
  });

  it("uses CoreError with INVALID_REQUEST for validation failures", () => {
    try {
      validateRequestPayload("tasks.create", { branch: " " });
      throw new Error("expected request validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });
});
