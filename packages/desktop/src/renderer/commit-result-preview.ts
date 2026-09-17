import { blockStates, lines, mergeBlocks, type MergeBlock } from "./conflict-merge";

export type CommitResultPreview = { base: string; local: string; initial: string; blocks: MergeBlock[] };
const terminated = (value: string) => value && !value.endsWith("\n") ? value + "\n" : value;
export function buildCommitResultPreview(base: string, local: string, incoming: string): CommitResultPreview {
  const blocks = mergeBlocks(base, local, incoming).filter((block) => block.theirs !== block.base);
  const result = lines(local);
  for (const block of [...blocks].reverse()) {
    const text = block.conflict ? `<<<<<<< LOCAL\n${terminated(block.ours)}=======\n${terminated(block.theirs)}>>>>>>> COMMIT\n` : block.theirs;
    result.splice(block.oursLine - 1, lines(block.ours).length, text);
  }
  return { base, local, initial: result.join(""), blocks };
}
export function commitResultStates(preview: CommitResultPreview, result: string) {
  return blockStates(preview.base, result, preview.blocks).map((state, index) => ({
    ...state,
    conflict: state.status === "conflict" || state.status === "review" || (preview.blocks[index]!.conflict && state.status === "pending")
  }));
}
export function hasConflictMarkers(result: string) { return /^(?:<<<<<<< LOCAL|=======|>>>>>>> COMMIT)$/m.test(result); }
