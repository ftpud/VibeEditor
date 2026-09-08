import { diffLines } from "diff";

type Change = { start: number; end: number; text: string };
export type MergeBlock = { start: number; end: number; base: string; ours: string; theirs: string; conflict: boolean; oursLine: number; theirsLine: number };
export function lines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }

function changes(base: string, value: string): Change[] {
  const diff = diffLines(base, value, { timeout: 200 });
  if (!diff) throw new Error("This file is too large to compare interactively. You can still edit the result manually.");
  const result: Change[] = [];
  let position = 0;
  let pending: Change | undefined;
  for (const part of diff) {
    if (!part.added && !part.removed) { pending = undefined; position += part.count; continue; }
    if (!pending) { pending = { start: position, end: position, text: "" }; result.push(pending); }
    if (part.removed) { position += part.count; pending.end = position; }
    else pending.text += part.value;
  }
  return result;
}

function project(base: string[], edits: Change[], start: number, end: number): string {
  let cursor = start;
  let result = "";
  for (const edit of edits.filter((item) => item.start >= start && item.end <= end)) {
    result += base.slice(cursor, edit.start).join("") + edit.text;
    cursor = edit.end;
  }
  return result + base.slice(cursor, end).join("");
}

export function mergeBlocks(base: string, ours: string, theirs: string): MergeBlock[] {
  const original = lines(base);
  const a = changes(base, ours), b = changes(base, theirs);
  const groups: { start: number; end: number }[] = [];
  for (const edit of [...a, ...b].sort((x, y) => x.start - y.start || x.end - y.end)) {
    const previous = groups.at(-1);
    // Touching edits are grouped conservatively, including insertions at a replacement boundary.
    if (previous && edit.start <= previous.end) previous.end = Math.max(previous.end, edit.end);
    else groups.push({ start: edit.start, end: edit.end });
  }
  const sourceLine = (edits: Change[], start: number) => start + 1 + edits.filter((edit) => edit.end < start).reduce((offset, edit) => offset + lines(edit.text).length - (edit.end - edit.start), 0);
  return groups.map(({ start, end }) => {
    const originalText = original.slice(start, end).join("");
    const oursText = project(original, a, start, end), theirsText = project(original, b, start, end);
    return { start, end, base: originalText, ours: oursText, theirs: theirsText, conflict: oursText !== originalText && theirsText !== originalText && oursText !== theirsText, oursLine: sourceLine(a, start), theirsLine: sourceLine(b, start) };
  });
}

export function resultRange(base: string, result: string, block: MergeBlock): { start: number; end: number } | undefined {
  let start = block.start, end = block.end;
  for (const edit of changes(base, result)) {
    const delta = lines(edit.text).length - (edit.end - edit.start);
    if (edit.end < block.start || (edit.end === block.start && edit.start < block.start)) { start += delta; end += delta; }
    else if (edit.start <= block.end && edit.end >= block.start) {
      if (edit.start < block.start || edit.end > block.end) return undefined;
      end += delta;
    }
  }
  return { start, end };
}

export function applyBlock(base: string, result: string, block: MergeBlock, side: "ours" | "theirs"): string {
  const range = resultRange(base, result, block);
  if (!range) throw new Error("Manual edits span multiple blocks. Undo those edits or finish this block in the result editor.");
  const content = lines(result);
  return content.slice(0, range.start).join("") + block[side] + content.slice(range.end).join("");
}

export function mergeNonConflicting(base: string, result: string, blocks: MergeBlock[]): string {
  let next = result;
  for (const block of [...blocks].reverse()) {
    if (block.conflict) continue;
    const range = resultRange(base, next, block);
    // Preserve manual edits and changes Git has already merged into the working copy.
    if (!range || lines(next).slice(range.start, range.end).join("") !== block.base) continue;
    next = applyBlock(base, next, block, block.ours !== block.base ? "ours" : "theirs");
  }
  return next;
}
