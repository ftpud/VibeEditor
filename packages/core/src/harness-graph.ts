import type { HarnessDataSchema, HarnessDefinition, HarnessValidationIssue } from "@remote-ide/protocol";

export function validateHarness(harness: HarnessDefinition): { valid: boolean; issues: HarnessValidationIssue[]; order: string[] } {
  const issues: HarnessValidationIssue[] = [];
  if (harness.settings?.concurrency !== undefined && (!Number.isInteger(harness.settings.concurrency) || harness.settings.concurrency < 1 || harness.settings.concurrency > 32)) issues.push({ code: "invalid-settings", message: "Workflow concurrency must be an integer from 1 to 32" });
  if (harness.settings?.retry?.maxAttempts !== undefined && (!Number.isInteger(harness.settings.retry.maxAttempts) || harness.settings.retry.maxAttempts < 1 || harness.settings.retry.maxAttempts > 10)) issues.push({ code: "invalid-settings", message: "Workflow retry attempts must be an integer from 1 to 10" });
  if (harness.settings?.outputLimitChars !== undefined && (!Number.isInteger(harness.settings.outputLimitChars) || harness.settings.outputLimitChars < 1_000 || harness.settings.outputLimitChars > 200_000)) issues.push({ code: "invalid-settings", message: "Workflow output limit must be an integer from 1,000 to 200,000 characters" });
  if (harness.settings?.logLimitEntries !== undefined && (!Number.isInteger(harness.settings.logLimitEntries) || harness.settings.logLimitEntries < 10 || harness.settings.logLimitEntries > 500)) issues.push({ code: "invalid-settings", message: "Workflow log limit must be an integer from 10 to 500 entries" });
  if (harness.settings?.maxRunDurationMs !== undefined && (!Number.isInteger(harness.settings.maxRunDurationMs) || harness.settings.maxRunDurationMs < 60_000 || harness.settings.maxRunDurationMs > 24 * 60 * 60_000)) issues.push({ code: "invalid-settings", message: "Workflow run duration must be an integer from 1 minute to 24 hours" });
  if (harness.settings?.tokenBudget !== undefined && (!Number.isInteger(harness.settings.tokenBudget) || harness.settings.tokenBudget < 1_000 || harness.settings.tokenBudget > 10_000_000)) issues.push({ code: "invalid-settings", message: "Workflow token budget must be an integer from 1,000 to 10,000,000" });
  if (!harness.blocks.length) issues.push({ code: "empty", message: "Add at least one block before running this harness" });
  const ids = new Set<string>();
  const watchdogs = harness.blocks.filter((block) => block.watchdog);
  for (const block of harness.blocks) {
    if (ids.has(block.id)) issues.push({ code: "duplicate-id", blockId: block.id, message: `Block ID '${block.id}' is duplicated` }); ids.add(block.id);
    if (!block.label.trim()) issues.push({ code: "empty-label", blockId: block.id, message: "Every block needs a name" });
    if (!["text", "timer", "script", "markdown", "start_input"].includes(block.type) && !block.watchdog && !block.prompt.trim()) issues.push({ code: "empty-prompt", blockId: block.id, message: `Block '${block.label || block.id}' needs a prompt` });
    if (block.type === "review" && (!block.review || !isCommit(block.review.revision) || (block.review.baseRevision !== undefined && !isCommit(block.review.baseRevision)))) issues.push({ code: "invalid-gate", blockId: block.id, message: `Review block '${block.label || block.id}' needs an exact commit SHA and optional base SHA` });
    if (block.review?.correction && (!harness.blocks.some((item) => item.id === block.review!.correction!.ownerBlockId) || block.review.correction.ownerBlockId === block.id || (block.review.correction.maxCycles !== undefined && (!Number.isInteger(block.review.correction.maxCycles) || block.review.correction.maxCycles < 1 || block.review.correction.maxCycles > 20)) || (block.review.correction.verificationBlockId !== undefined && !harness.blocks.some((item) => item.id === block.review!.correction!.verificationBlockId)))) issues.push({ code: "invalid-gate", blockId: block.id, message: `Review correction settings need an existing owner block, optional verification block, and a cycle limit from 1 to 20` });
    if (block.type === "verification" && (!block.verification || !block.verification.command.trim() || (block.verification.revision !== undefined && !isCommit(block.verification.revision)) || (block.verification.timeoutMs !== undefined && (!Number.isInteger(block.verification.timeoutMs) || block.verification.timeoutMs < 1 || block.verification.timeoutMs > 30 * 60_000)) || (block.verification.workingDirectory !== undefined && (!block.verification.workingDirectory.trim() || block.verification.workingDirectory.includes("\\0"))))) issues.push({ code: "invalid-gate", blockId: block.id, message: `Verification block '${block.label || block.id}' needs a command, valid optional revision, working directory, and timeout` });
    if (block.type === "timer" && (!Number.isFinite(block.seconds) || block.seconds! < 0 || block.seconds! > 86400)) issues.push({ code: "invalid-gate", blockId: block.id, message: "Timer duration must be between 0 and 86400 seconds" });
    if (block.type === "script" && !block.command?.trim()) issues.push({ code: "invalid-gate", blockId: block.id, message: "Script execution needs a command" });
    for (const [name, schema] of [["input", block.inputSchema], ["output", block.outputSchema]] as const) if (schema && !validDataSchema(schema)) issues.push({ code: "invalid-schema", blockId: block.id, message: `Block '${block.label || block.id}' has an invalid ${name} schema` });
    for (const match of block.prompt.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      const variable = match[1]!; const reference = /^blocks\.([A-Za-z0-9_-]+)\.output$/.exec(variable);
      if (variable === "input" || variable === "iteration") continue;
      if (!reference) issues.push({ code: "unknown-template", blockId: block.id, message: `Block '${block.label || block.id}' uses unsupported template '{{${variable}}}'` });
      else if (!harness.blocks.some((item) => item.id === reference[1])) issues.push({ code: "missing-template-block", blockId: block.id, message: `Template refers to missing block '${reference[1]}'` });
    }
  }
  if (watchdogs.length > 1) for (const block of watchdogs.slice(1)) issues.push({ code: "invalid-watchdog", blockId: block.id, message: "A workflow can have only one Core watchdog" });
  if (watchdogs.length && watchdogs.length === harness.blocks.length) for (const block of watchdogs) issues.push({ code: "invalid-watchdog", blockId: block.id, message: "A Core watchdog needs at least one delivery block to supervise" });
  const edgeIds = new Set<string>(); const edgeKeys = new Set<string>(); const outgoing = new Map<string, string[]>(); const indegree = new Map(harness.blocks.map((block) => [block.id, 0]));
  for (const edge of harness.edges) {
    if (edgeIds.has(edge.id)) issues.push({ code: "duplicate-edge-id", edgeId: edge.id, message: `Connection ID '${edge.id}' is duplicated` }); edgeIds.add(edge.id);
    if (!ids.has(edge.from) || !ids.has(edge.to)) { issues.push({ code: "missing-endpoint", edgeId: edge.id, message: "Connection refers to a block that no longer exists" }); continue; }
    if (harness.blocks.find((block) => block.id === edge.from)?.watchdog || harness.blocks.find((block) => block.id === edge.to)?.watchdog) issues.push({ code: "invalid-watchdog", edgeId: edge.id, message: "A Core watchdog runs independently and cannot have workflow connections" });
    if (edge.from === edge.to) issues.push({ code: "self-edge", edgeId: edge.id, blockId: edge.from, message: "A block cannot connect to itself" });
    if (edge.type === "use" || edge.type === "path") {
      if (harness.blocks.find((block) => block.id === edge.from)?.type !== "ai") issues.push({ code: "invalid-gate", edgeId: edge.id, message: "Use and path connections must start at an AI Agent" });
    }
    const key = `${edge.from}\0${edge.to}\0${edge.type ?? "follow"}`; if (edgeKeys.has(key)) issues.push({ code: "duplicate-edge", edgeId: edge.id, message: "This connection already exists" }); edgeKeys.add(key);
    if (edge.type && edge.loop) issues.push({ code: "invalid-loop", edgeId: edge.id, message: "Typed connections cannot be legacy loop edges" });
    if (edge.loop && !hasNonLoopPath(harness, edge.to, edge.from)) issues.push({ code: "invalid-loop", edgeId: edge.id, message: "A loop must return to an earlier block on an existing forward path" });
    if (!edge.loop && edge.type !== "use" && harness.blocks.find((block) => block.id === edge.from)?.type !== "timer") { outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge.to]); indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1); }
  }
  for (const block of harness.blocks.filter((item) => item.routing === "ai" || harness.edges.some((edge) => edge.from === item.id && edge.type === "path"))) {
    const outgoingEdges = harness.edges.filter((edge) => edge.from === block.id && (block.type !== "ai" || edge.type === "path")); const labels = new Set<string>();
    for (const edge of outgoingEdges) { const label = edge.label?.trim(); if (!label || labels.has(label)) issues.push({ code: "route-label", blockId: block.id, edgeId: edge.id, message: `AI-routed block '${block.label}' needs a unique label on every outgoing path` }); else labels.add(label); }
  }
  const queue = harness.blocks.filter((block) => (indegree.get(block.id) ?? 0) === 0).map((block) => block.id); const order: string[] = []; const pending = new Map(indegree);
  while (queue.length) { const id = queue.shift()!; order.push(id); for (const next of outgoing.get(id) ?? []) { const count = (pending.get(next) ?? 0) - 1; pending.set(next, count); if (count === 0) queue.push(next); } }
  if (order.length !== harness.blocks.length && harness.blocks.length) issues.push({ code: "cycle", message: "Harness connections contain a cycle" });
  return { valid: issues.length === 0, issues, order: issues.some((issue) => issue.code === "cycle") ? [] : order };
}

function isCommit(value: string): boolean { return /^[0-9a-f]{7,64}$/i.test(value); }

function hasNonLoopPath(harness: HarnessDefinition, from: string, to: string): boolean {
  const pending = [from]; const visited = new Set<string>();
  while (pending.length) { const current = pending.pop()!; if (current === to) return true; if (visited.has(current)) continue; visited.add(current); pending.push(...harness.edges.filter((edge) => !edge.loop && edge.from === current).map((edge) => edge.to)); }
  return false;
}

export function renderHarnessPrompt(template: string, input: string, outputs: ReadonlyMap<string, string>): string {
  return template.replace(/\{\{\s*(input|blocks\.([A-Za-z0-9_-]+)\.output)\s*\}\}/g, (_match, key: string, blockId?: string) => key === "input" ? input : outputs.get(blockId!) ?? "");
}

export function parseHarnessData(value: string, schema: HarnessDataSchema | undefined, label: string): unknown {
  if (!schema) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new HarnessSchemaError(`${label} must be valid JSON matching its declared schema`); }
  const issue = validateHarnessData(parsed, schema);
  if (issue) throw new HarnessSchemaError(`${label} ${issue}`);
  return parsed;
}

export class HarnessSchemaError extends Error {}

export function validateHarnessData(value: unknown, schema: HarnessDataSchema): string | undefined {
  if (schema.type === "string" && typeof value !== "string") return "must be a string";
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return "must be a finite number";
  if (schema.type === "boolean" && typeof value !== "boolean") return "must be a boolean";
  if (schema.type === "array") {
    if (!Array.isArray(value)) return "must be an array";
    for (const [index, item] of value.entries()) { const issue = schema.items && validateHarnessData(item, schema.items); if (issue) return `item ${index + 1} ${issue}`; }
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "must be an object";
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) return `is missing required field '${key}'`;
    for (const [key, property] of Object.entries(schema.properties ?? {})) if (key in record) { const issue = validateHarnessData(record[key], property); if (issue) return `field '${key}' ${issue}`; }
  }
  return undefined;
}

export function validDataSchema(schema: HarnessDataSchema, depth = 0): boolean {
  if (depth > 10 || !['string', 'number', 'boolean', 'object', 'array'].includes(schema.type)) return false;
  if (schema.required && (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string" && key.length > 0))) return false;
  if (schema.properties && (!isPlainObject(schema.properties) || !Object.values(schema.properties).every((property) => validDataSchema(property, depth + 1)))) return false;
  return schema.items === undefined || validDataSchema(schema.items, depth + 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
