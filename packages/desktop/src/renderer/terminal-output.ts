import type { Terminal } from "@xterm/xterm";

/** Historical queries restore display state without replying to the live PTY. */
export function createTerminalOutput(terminal: Pick<Terminal, "parser" | "write">) {
  const pending: { data: string; replay: boolean }[] = [];
  let writing = false, replaying = false, historicalReply = false, disposed = false;
  let generation = 0;
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
    writing = true; replaying = next.replay;
    terminal.write(next.data, () => {
      writing = false; replaying = false; historicalReply = false; generation++;
      flush();
    });
  };
  return {
    write(data: string, replay = false) { if (disposed) return; pending.push({ data, replay }); flush(); },
    isHistoricalReply: () => historicalReply,
    dispose() { disposed = true; pending.length = 0; historicalReply = false; generation++; hooks.forEach((hook) => hook.dispose()); }
  };
}
