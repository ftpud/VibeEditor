import type { HarnessBlock, HarnessBlockRun, HarnessMeetingMessage } from "@remote-ide/protocol";

/** Synchronous mutations are atomic between callers; all state is saved with its run. */
export function useMeeting(state: HarnessBlockRun, caller: HarnessBlock, args: Record<string, unknown>) {
  const action = args.action ?? "diff";
  if (!["publish", "tail", "diff"].includes(String(action))) throw new Error("Meeting action must be publish, tail, or diff");
  const lines = args.lines ?? 20;
  if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 50) throw new Error("Meeting lines must be from 1 to 50");
  const after = args.after;
  if (after !== undefined && (action !== "diff" || typeof after !== "number" || !Number.isSafeInteger(after) || after < 0)) throw new Error("Meeting after must be a nonnegative sequence number with action diff");
  const meeting = state.meeting ?? { sequence: 0, messages: [], cursors: {} };
  if (typeof after === "number" && after > meeting.sequence) throw new Error("Meeting after exceeds the latest sequence number");
  if (action === "publish") {
    const text = args.message ?? args.input;
    if (typeof text !== "string" || !text.trim() || text.length > 10000) throw new Error("Meeting publish needs a message of 1 to 10000 characters");
    const message: HarnessMeetingMessage = { sequence: meeting.sequence + 1, blockId: caller.id, author: caller.label, provider: caller.provider, model: caller.model, text, timestamp: new Date().toISOString() };
    if (JSON.stringify(message).length > 16000) throw new Error("Meeting message exceeds the 16000 character serialized limit");
    meeting.sequence = message.sequence;
    meeting.messages = [...meeting.messages, message].slice(-1000);
    state.meeting = meeting;
    return { published: message.sequence, latestSequence: meeting.sequence };
  }
  const savedCursor = Object.hasOwn(meeting.cursors, caller.id) ? meeting.cursors[caller.id]! : 0;
  const cursor = typeof after === "number" ? after : savedCursor;
  const candidates = action === "tail" ? meeting.messages.slice(-lines) : meeting.messages.filter((message) => message.sequence > cursor);
  const messages: HarnessMeetingMessage[] = [];
  let size = 0;
  // Bound serialized output before advancing the cursor so unread messages are never lost
  // to generic workflow context truncation, including heavily escaped message text.
  for (const message of action === "tail" ? [...candidates].reverse() : candidates) {
    const length = JSON.stringify(message).length;
    if (messages.length >= lines || size + length > 16000) break;
    if (action === "tail") messages.unshift(message);
    else messages.push(message);
    size += length;
  }
  const next = messages.at(-1)?.sequence ?? (action === "tail" ? meeting.sequence : cursor);
  meeting.cursors = { ...meeting.cursors, [caller.id]: Math.max(savedCursor, next) };
  state.meeting = meeting;
  return { messages, cursor: next, latestSequence: meeting.sequence, hasMore: next < meeting.sequence, historyTruncated: action === "diff" && cursor < (meeting.messages[0]?.sequence ?? 1) - 1 };
}
