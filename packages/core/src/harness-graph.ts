import type { HarnessDefinition, HarnessValidationIssue } from "@remote-ide/protocol";

export function validateHarness(harness: HarnessDefinition): { valid: boolean; issues: HarnessValidationIssue[]; order: string[] } {
  const issues: HarnessValidationIssue[] = [];
  if (!harness.blocks.length) issues.push({ code: "empty", message: "Add at least one block before running this harness" });
  const ids = new Set<string>();
  for (const block of harness.blocks) { if (ids.has(block.id)) issues.push({ code: "duplicate-id", blockId: block.id, message: `Block ID '${block.id}' is duplicated` }); ids.add(block.id); }
  const edgeKeys = new Set<string>(); const outgoing = new Map<string, string[]>(); const indegree = new Map(harness.blocks.map((block) => [block.id, 0]));
  for (const edge of harness.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) { issues.push({ code: "missing-endpoint", edgeId: edge.id, message: "Connection refers to a block that no longer exists" }); continue; }
    if (edge.from === edge.to) issues.push({ code: "self-edge", edgeId: edge.id, blockId: edge.from, message: "A block cannot connect to itself" });
    const key = `${edge.from}\0${edge.to}`; if (edgeKeys.has(key)) issues.push({ code: "duplicate-edge", edgeId: edge.id, message: "This connection already exists" }); edgeKeys.add(key);
    outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge.to]); indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  for (const block of harness.blocks.filter((item) => item.routing === "ai")) {
    const outgoingEdges = harness.edges.filter((edge) => edge.from === block.id); const labels = new Set<string>();
    for (const edge of outgoingEdges) { const label = edge.label?.trim(); if (!label || labels.has(label)) issues.push({ code: "route-label", blockId: block.id, edgeId: edge.id, message: `AI-routed block '${block.label}' needs a unique label on every outgoing path` }); else labels.add(label); }
  }
  const queue = harness.blocks.filter((block) => (indegree.get(block.id) ?? 0) === 0).map((block) => block.id); const order: string[] = []; const pending = new Map(indegree);
  while (queue.length) { const id = queue.shift()!; order.push(id); for (const next of outgoing.get(id) ?? []) { const count = (pending.get(next) ?? 0) - 1; pending.set(next, count); if (count === 0) queue.push(next); } }
  if (order.length !== harness.blocks.length && harness.blocks.length) issues.push({ code: "cycle", message: "Harness connections contain a cycle" });
  return { valid: issues.length === 0, issues, order: issues.some((issue) => issue.code === "cycle") ? [] : order };
}

export function renderHarnessPrompt(template: string, input: string, outputs: ReadonlyMap<string, string>): string {
  return template.replace(/\{\{\s*(input|blocks\.([A-Za-z0-9_-]+)\.output)\s*\}\}/g, (_match, key: string, blockId?: string) => key === "input" ? input : outputs.get(blockId!) ?? "");
}
