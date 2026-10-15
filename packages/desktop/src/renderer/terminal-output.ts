import type { Terminal } from "@xterm/xterm";

/** Historical queries restore display state without replying to the live PTY. */
export function createTerminalOutput(terminal: Pick<Terminal, "parser" | "write">, activity?: { text(): string; isViewed(): boolean; onChange(): void }) {
  const pending: { data: string; replay: boolean; unseen: boolean; activityGeneration: number }[] = [];
  let writing = false, replaying = false, historicalReply = false, disposed = false;
  let generation = 0;
  let activityGeneration = 0;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let activityBaseline: string | undefined;
  const resetActivity = () => {
    clearTimeout(activityTimer); activityTimer = undefined; activityBaseline = undefined;
  };
  const acknowledge = () => { activityGeneration++; resetActivity(); };
  // Default parser handlers emit replies synchronously. Keep their state changes,
  // suppress their replay replies, and release input before the next event turn.
  const query = () => {
    historicalReply = replaying;
    const current = ++generation;
    queueMicrotask(() => { if (current === generation) historicalReply = false; });
    return false;
  };
  const hooks = [
    ...[{ final: "c" }, { prefix: ">", final: "c" }, { final: "n" }, { prefix: "?", final: "n" }, { final: "t" }, { intermediates: "$", final: "p" }, { prefix: "?", intermediates: "$", final: "p" }].map((id) => terminal.parser.registerCsiHandler(id, query)),
    ...[4, 10, 11, 12].map((id) => terminal.parser.registerOscHandler(id, query)),
    terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, query)
  ];
  const flush = () => {
    if (disposed || writing || !pending.length) return;
    const next = pending.shift()!;
    const before = activity && next.unseen && !next.replay && next.activityGeneration === activityGeneration && activityTimer === undefined ? activity.text() : undefined;
    writing = true; replaying = next.replay;
    terminal.write(next.data, () => {
      if (activity && !disposed) {
        if (next.replay || !next.unseen || activity.isViewed()) resetActivity();
        else if (next.activityGeneration === activityGeneration && before !== undefined && activityTimer === undefined && before !== activity.text()) {
          // Coalesce split prompt redraws; control traffic and identical redraws
          // don't represent new visible output.
          activityBaseline = before;
          activityTimer = setTimeout(() => {
            activityTimer = undefined;
            if (!disposed && !activity.isViewed() && activity.text() !== activityBaseline) activity.onChange();
            activityBaseline = undefined;
          }, 120);
        }
      }
      writing = false; replaying = false; historicalReply = false; generation++;
      flush();
    });
  };
  return {
    write(data: string, replay = false) { if (disposed) return; pending.push({ data, replay, unseen: Boolean(activity && !activity.isViewed()), activityGeneration }); flush(); },
    acknowledge,
    isHistoricalReply: () => historicalReply,
    dispose() { disposed = true; acknowledge(); pending.length = 0; historicalReply = false; generation++; hooks.forEach((hook) => hook.dispose()); }
  };
}

/** Compare visible text, ignoring cursor/style changes and soft line wrapping. */
export function terminalBufferText(terminal: Pick<Terminal, "buffer">): string {
  const buffer = terminal.buffer.active;
  let text = "";
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    if (index > 0 && !line.isWrapped) text += "\n";
    if (buffer.getLine(index + 1)?.isWrapped) {
      // A resized buffer can retain wrapped lines padded to the new width.
      // Keep typed spaces, but drop the empty cells added by resizing.
      let end = line.length;
      while (end > 0 && line.getCell(end - 1)?.getCode() === 0) end--;
      text += line.translateToString(false, 0, end);
    } else text += line.translateToString(true);
  }
  return text.trimEnd();
}
