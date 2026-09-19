import type { HarnessDefinition, HarnessValidationIssue } from "@remote-ide/protocol";

export function validateHarness(harness: HarnessDefinition): { valid: boolean; issues: HarnessValidationIssue[]; order: string[] } {
  const issues: HarnessValidationIssue[] = [];
  if (!harness.blocks.length) issues.push({ code: "empty", message: "Add at least one block before running this harness" });
  const ids = new Set<string>();
  for (const block of harness.blocks) {
    if (ids.has(block.id)) issues.push({ code: "duplicate-id", blockId: block.id, message: `Block ID '${block.id}' is duplicated` }); ids.add(block.id);
    if (!block.label.trim()) issues.push({ code: "empty-label", blockId: block.id, message: "Every block needs a name" });
    if (!block.watchdog && !block.prompt.trim()) issues.push({ code: "empty-prompt", blockId: block.id, message: `Block '${block.label || block.id}' needs a prompt` });
    for (const match of block.prompt.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
      const variable = match[1]!; const reference = /^blocks\.([A-Za-z0-9_-]+)\.output$/.exec(variable);
      if (variable === "input" || variable === "iteration") continue;
      if (!reference) issues.push({ code: "unknown-template", blockId: block.id, message: `Block '${block.label || block.id}' uses unsupported template '{{${variable}}}'` });
      else if (!harness.blocks.some((item) => item.id === reference[1])) issues.push({ code: "missing-template-block", blockId: block.id, message: `Template refers to missing block '${reference[1]}'` });
    }
  }
  const edgeIds = new Set<string>(); const edgeKeys = new Set<string>(); const outgoing = new Map<string, string[]>(); const indegree = new Map(harness.blocks.map((block) => [block.id, 0]));
  for (const edge of harness.edges) {
    if (edgeIds.has(edge.id)) issues.push({ code: "duplicate-edge-id", edgeId: edge.id, message: `Connection ID '${edge.id}' is duplicated` }); edgeIds.add(edge.id);
    if (!ids.has(edge.from) || !ids.has(edge.to)) { issues.push({ code: "missing-endpoint", edgeId: edge.id, message: "Connection refers to a block that no longer exists" }); continue; }
    if (edge.from === edge.to) issues.push({ code: "self-edge", edgeId: edge.id, blockId: edge.from, message: "A block cannot connect to itself" });
    const key = `${edge.from}\0${edge.to}`; if (edgeKeys.has(key)) issues.push({ code: "duplicate-edge", edgeId: edge.id, message: "This connection already exists" }); edgeKeys.add(key);
    if (edge.loop && !hasNonLoopPath(harness, edge.to, edge.from)) issues.push({ code: "invalid-loop", edgeId: edge.id, message: "A loop must return to an earlier block on an existing forward path" });
    if (!edge.loop) { outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge.to]); indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1); }
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

function hasNonLoopPath(harness: HarnessDefinition, from: string, to: string): boolean {
  const pending = [from]; const visited = new Set<string>();
  while (pending.length) { const current = pending.pop()!; if (current === to) return true; if (visited.has(current)) continue; visited.add(current); pending.push(...harness.edges.filter((edge) => !edge.loop && edge.from === current).map((edge) => edge.to)); }
  return false;
}

export function renderHarnessPrompt(template: string, input: string, outputs: ReadonlyMap<string, string>): string {
  return template.replace(/\{\{\s*(input|blocks\.([A-Za-z0-9_-]+)\.output)\s*\}\}/g, (_match, key: string, blockId?: string) => key === "input" ? input : outputs.get(blockId!) ?? "");
}
