import crypto from "node:crypto";

/** Context projections are deliberately lossy; durable workflow outputs stay intact. */
export const WORKFLOW_CONTEXT_CHARS = 20_000;
export function contextPreview(text: string, limit = 8000): string {
  if (text.length <= limit) return text;
  const marker = `\n[Workflow context truncated; original ${text.length} characters. Read retained output with workflow_block_output.]\n`;
  if (limit <= marker.length) return marker.slice(0, Math.max(0, limit));
  const available = limit - marker.length;
  return (text.slice(0, Math.ceil(available / 2)) + marker + (available > 1 ? text.slice(-Math.floor(available / 2)) : "")).slice(0, limit);
}

export function contextHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

/** Preserve structured tool results where possible, with an aggregate fallback. */
export function contextResult(value: unknown): unknown {
  const original = JSON.stringify(value);
  if (!original || original.length <= WORKFLOW_CONTEXT_CHARS) return value;
  const project = (item: unknown): unknown => {
    if (typeof item === "string") return contextPreview(item);
    if (Array.isArray(item)) return item.slice(-50).map(project);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, project(entry)]));
    return item;
  };
  const projected = project(value);
  if (JSON.stringify(projected).length <= WORKFLOW_CONTEXT_CHARS - 100) return { ...(projected as object), truncated: true, originalChars: original.length };
  return { ...(value && typeof value === "object" && "blockId" in value ? { blockId: value.blockId } : {}), preview: contextPreview(original, 8000), truncated: true, originalChars: original.length };
}

export function contextOutputs(template: string, outputs: ReadonlyMap<string, string>, previous: ReadonlyMap<string, string>): Map<string, string> {
  let remaining = WORKFLOW_CONTEXT_CHARS;
  const projected = new Map<string, string>();
  const references = [...template.matchAll(/\{\{\s*blocks\.([A-Za-z0-9_-]+)\.output\s*\}\}/g)].map((match) => match[1]!);
  for (const id of new Set(references)) {
    const copies = references.filter((reference) => reference === id).length;
    const output = outputs.get(id) ?? "";
    if (output && previous.get(id) === contextHash(output)) {
      const reference = contextPreview(`[Block ${id} output unchanged; reuse the earlier result.]`, Math.floor(remaining / copies));
      projected.set(id, reference);
      remaining -= reference.length * copies;
    }
    else {
      const preview = contextPreview(output, Math.min(8000, Math.floor(remaining / copies)));
      remaining -= preview.length * copies;
      projected.set(id, preview);
    }
  }
  return projected;
}
