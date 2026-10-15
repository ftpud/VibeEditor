import type { RequestType } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

type JsonRecord = Record<string, unknown>;

/**
 * Validate the request envelope and the high-risk payloads whose malformed
 * values could otherwise reach a mutating service. Other request types receive
 * envelope validation only; their service-specific validators remain in place.
 */
export function validateRequestPayload(type: RequestType, payload: unknown): void {
  const record = requireRecord(payload, `${type} payload must be an object`);

  switch (type) {
    case "storage.cleanup":
      requireNonEmptyString(record.scanId, "Storage scan ID is required");
      if (typeof record.category !== "string" || typeof record.age !== "string" || !["tasks", "sessions", "workflows", "checkpoints", "logs", "provider", "runtime", "other"].includes(record.category) || !["finished", "week", "older"].includes(record.age)) invalid("Invalid storage cleanup selection");
      return;
    case "protocol.handshake": {
      const compatibility = requireRecord(record.compatibility, "Handshake compatibility must be an object");
      const minimum = compatibility.minimum;
      const maximum = compatibility.maximum;
      if (!isPositiveSafeInteger(minimum) || !isPositiveSafeInteger(maximum) || minimum > maximum) {
        invalid("Handshake compatibility must contain an ordered positive integer range");
      }
      optionalString(record, "token", "Handshake token must be a string");
      optionalString(record, "clientVersion", "Client version must be a string");
      return;
    }
    case "tasks.create":
      requireNonEmptyString(record.branch, "Task branch must be a non-empty string");
      optionalBoolean(record, "existing", "Task existing flag must be a boolean");
      optionalBoolean(record, "remote", "Task remote flag must be a boolean");
      return;
    case "tasks.delete": {
      const taskId = requireNonEmptyString(record.taskId, "Task ID must be a non-empty string");
      if (taskId === "." || taskId === ".." || /[\\/\0]/.test(taskId)) invalid("Task ID must not contain path separators or NUL");
      return;
    }
    case "tasks.createFromPrompt": {
      const prompt = requireString(record.prompt, "Prompt must be a string");
      if (prompt.length > 100_000) invalid("Prompt must not exceed 100000 characters");
      const configuration = requireRecord(record.configuration, "Task configuration must be an object");
      for (const value of Object.values(configuration)) {
        if (typeof value !== "string" && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) {
          invalid("Task configuration values must be strings, finite numbers, or booleans");
        }
      }
      optionalNonEmptyString(record, "provider", "Provider must be a non-empty string");
      if (record.content !== undefined) {
        if (!Array.isArray(record.content)) invalid("Prompt content must be an array");
        for (const block of record.content) validateContentBlock(block);
      }
      if (!prompt.trim() && (!Array.isArray(record.content) || record.content.length === 0)) {
        invalid("Prompt must be non-blank when no content blocks are supplied");
      }
      if (record.mcpServers !== undefined) {
        if (!Array.isArray(record.mcpServers)) invalid("MCP servers must be an array");
        for (const server of record.mcpServers) validateMcpServer(server);
      }
      optionalStringArray(record, "skillIds", "Skill IDs must be an array of strings");
      if (record.agent !== undefined) {
        const agent = requireRecord(record.agent, "Agent must be an object");
        requireString(agent.name, "Agent name must be a string");
        requireString(agent.instructions, "Agent instructions must be a string");
        optionalString(agent, "description", "Agent description must be a string");
        optionalStringArray(agent, "mcpServers", "Agent MCP servers must be an array of strings");
      }
      if (record.agentPreset !== undefined) {
        const preset = requireRecord(record.agentPreset, "Agent preset must be an object");
        if (preset.scope !== "global" && preset.scope !== "local" && preset.scope !== "workspace") {
          invalid("Agent preset scope must be global, local, or workspace");
        }
        requireString(preset.name, "Agent preset name must be a string");
      }
      return;
    }
    case "filesystem.transferApply": {
      if (record.kind !== "copy" && record.kind !== "move") invalid("Transfer kind must be copy or move");
      if (typeof record.confirmed !== "boolean") invalid("Transfer confirmation must be a boolean");
      if (!Array.isArray(record.items)) invalid("Transfer items must be an array");
      for (const item of record.items) {
        const transfer = requireRecord(item, "Each transfer item must be an object");
        requireString(transfer.source, "Transfer source must be a string");
        requireString(transfer.destination, "Transfer destination must be a string");
      }
      optionalStringArray(record, "overwritePaths", "Overwrite paths must be an array of strings");
      optionalStringArray(record, "openFiles", "Open files must be an array of strings");
      optionalStringArray(record, "dirtyFiles", "Dirty files must be an array of strings");
      return;
    }
    case "filesystem.remoteTransferBegin":
      if (record.direction !== "upload" && record.direction !== "download") invalid("Transfer direction must be upload or download");
      requireNonEmptyString(record.path, "Transfer path must be a non-empty string");
      optionalBoolean(record, "overwrite", "Transfer overwrite flag must be a boolean");
      if (record.size !== undefined && (!Number.isSafeInteger(record.size) || (record.size as number) < 0)) invalid("Transfer size must be a non-negative safe integer");
      if (record.mode !== undefined && (!Number.isInteger(record.mode) || (record.mode as number) < 0 || (record.mode as number) > 0o777)) invalid("Transfer mode must be an integer from 0 to 0777");
      return;
    default:
      return;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, message: string): JsonRecord {
  if (!isRecord(value)) invalid(message);
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") invalid(message);
  return value;
}

function requireNonEmptyString(value: unknown, message: string): string {
  const text = requireString(value, message);
  if (!text.trim()) invalid(message);
  return text;
}

function optionalString(record: JsonRecord, key: string, message: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string") invalid(message);
}

function optionalNonEmptyString(record: JsonRecord, key: string, message: string): void {
  if (record[key] !== undefined) requireNonEmptyString(record[key], message);
}

function optionalBoolean(record: JsonRecord, key: string, message: string): void {
  if (record[key] !== undefined && typeof record[key] !== "boolean") invalid(message);
}

function optionalStringArray(record: JsonRecord, key: string, message: string): void {
  const value = record[key];
  if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string"))) invalid(message);
}

function validateContentBlock(value: unknown): void {
  const block = requireRecord(value, "Each prompt content block must be an object");
  switch (block.type) {
    case "text":
      requireString(block.text, "Text content must contain a string");
      return;
    case "image":
      requireString(block.data, "Image content data must be a string");
      requireString(block.mimeType, "Image content MIME type must be a string");
      optionalString(block, "name", "Image content name must be a string");
      return;
    case "resource":
      requireString(block.uri, "Resource URI must be a string");
      requireString(block.text, "Resource text must be a string");
      optionalString(block, "mimeType", "Resource MIME type must be a string");
      optionalString(block, "name", "Resource name must be a string");
      return;
    case "resource_link":
      requireString(block.uri, "Resource link URI must be a string");
      requireString(block.name, "Resource link name must be a string");
      optionalString(block, "mimeType", "Resource link MIME type must be a string");
      if (block.size !== undefined && (typeof block.size !== "number" || !Number.isFinite(block.size) || block.size < 0)) {
        invalid("Resource link size must be a non-negative finite number");
      }
      return;
    default:
      invalid("Prompt content block type is invalid");
  }
}

function validateMcpServer(value: unknown): void {
  const server = requireRecord(value, "Each MCP server must be an object");
  const transport = server.transport;
  if (transport === undefined || transport === "stdio") {
    requireString(server.name, "MCP server name must be a string");
    requireString(server.command, "MCP server command must be a string");
    optionalStringArray(server, "args", "MCP server args must be an array of strings");
    optionalStringRecord(server, "env", "MCP server env must contain string values");
  } else if (transport === "http" || transport === "sse") {
    requireString(server.name, "MCP server name must be a string");
    requireString(server.url, "MCP server URL must be a string");
    optionalStringRecord(server, "headers", "MCP server headers must contain string values");
  } else {
    invalid("MCP server transport must be stdio, http, or sse");
  }
  optionalBoolean(server, "enabled", "MCP server enabled flag must be a boolean");
}

function optionalStringRecord(record: JsonRecord, key: string, message: string): void {
  const value = record[key];
  if (value === undefined) return;
  const values = requireRecord(value, message);
  if (!Object.values(values).every((item) => typeof item === "string")) invalid(message);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function invalid(message: string): never {
  throw new CoreError("INVALID_REQUEST", message);
}
