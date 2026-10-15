import { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalOutput, terminalBufferText } from "./terminal-output";

const terminals: Terminal[] = [];
afterEach(() => terminals.splice(0).forEach((terminal) => terminal.dispose()));

const settleActivity = () => new Promise<void>((resolve) => setTimeout(resolve, 170));

it("ignores replay, control-only traffic, and split redraws of the same prompt", async () => {
  const terminal = new Terminal(); terminals.push(terminal);
  const onChange = vi.fn();
  const output = createTerminalOutput(terminal, { text: () => terminalBufferText(terminal), isViewed: () => false, onChange });
  output.write("Prompt$ ", true);
  await vi.waitFor(() => expect(terminalBufferText(terminal)).toBe("Prompt$"));
  output.write("\x1b[?25l\x1b[31m\x1b]0;new window title\x07");
  output.write("\r\x1b[2K");
  await vi.waitFor(() => expect(terminalBufferText(terminal)).toBe(""));
  output.write("Prompt$ ");
  await vi.waitFor(() => expect(terminalBufferText(terminal)).toBe("Prompt$"));
  await settleActivity();
  expect(onChange).not.toHaveBeenCalled();
  output.write("echo hello\r\nhello\r\nPrompt$ ");
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  output.dispose();
});

it("does not mark output received while viewed after the user switches away", async () => {
  const terminal = new Terminal(); terminals.push(terminal);
  let viewed = true;
  const onChange = vi.fn();
  const output = createTerminalOutput(terminal, { text: () => terminalBufferText(terminal), isViewed: () => viewed, onChange });
  output.write("Foreground output");
  viewed = false;
  await settleActivity();
  expect(onChange).not.toHaveBeenCalled();
  output.write("\r\nBackground output");
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  output.dispose();
});

it("clears pending activity when viewed and still tracks later output while hidden", async () => {
  const terminal = new Terminal(); terminals.push(terminal);
  const onChange = vi.fn();
  const output = createTerminalOutput(terminal, { text: () => terminalBufferText(terminal), isViewed: () => false, onChange });
  output.write("Already viewed");
  await vi.waitFor(() => expect(terminalBufferText(terminal)).toBe("Already viewed"));
  output.acknowledge();
  await settleActivity();
  expect(onChange).not.toHaveBeenCalled();
  output.write("\r\nNew output while hidden");
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  output.write("\r\nDisposed output");
  output.dispose();
  await settleActivity();
  expect(onChange).toHaveBeenCalledOnce();
});

it("ignores rewrapping on resize and an identical live redraw after queued replay", async () => {
  const terminal = new Terminal({ cols: 20, rows: 5 }); terminals.push(terminal);
  const onChange = vi.fn();
  const output = createTerminalOutput(terminal, { text: () => terminalBufferText(terminal), isViewed: () => false, onChange });
  const prompt = "A long prompt that wraps$ ";
  output.write(prompt, true);
  output.write("\x1b[?25h");
  await vi.waitFor(() => expect(terminalBufferText(terminal)).toBe(prompt.trimEnd()));
  terminal.resize(40, 5);
  output.write(`\x1b[1A\r\x1b[J${prompt}`);
  await settleActivity();
  expect(onChange).not.toHaveBeenCalled();
  output.write("\r\nActual new output");
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  output.dispose();
});

it("does not feed historical cursor/device responses into the shell and answers queued live queries", async () => {
  const terminal = new Terminal(); terminals.push(terminal);
  const output = createTerminalOutput(terminal);
  const received: string[] = [];
  terminal.onData((data) => { if (!output.isHistoricalReply()) received.push(data); });
  output.write("Prompt$ \x1b[6n\x1b[c\x1b[>c\x1b[?6n\x1b[?25$p\x1bP$qm\x1b\\", true);
  output.write("\x1b[6n\x1b[>c");
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[0]).toMatch(/^\x1b\[\d+;\d+R$/);
  expect(received[1]).toBe("\x1b[>0;276;0c");
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("Prompt$ ");
  output.dispose();
});

it("preserves user input between asynchronous replay chunks", async () => {
  const terminal = new Terminal(); terminals.push(terminal);
  const output = createTerminalOutput(terminal);
  const received: string[] = [];
  terminal.onData((data) => { if (!output.isHistoricalReply()) received.push(data); });
  output.write("\x1b[", true);
  await new Promise<void>((resolve) => terminal.write("", resolve));
  terminal.input("typed while reconnecting");
  output.write("6n", true);
  output.write("\x1b[6n");
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[0]).toBe("typed while reconnecting");
  expect(received[1]).toMatch(/^\x1b\[\d+;\d+R$/);
  output.dispose();
});

it("ignores colour replies while preserving default handling of replayed palette changes", async () => {
  const handlers = new Map<number, () => boolean>();
  const writes: { data: string; done: () => void }[] = [];
  const terminal = {
    parser: { registerCsiHandler: () => ({ dispose() {} }), registerDcsHandler: () => ({ dispose() {} }), registerOscHandler: (id: number, handler: () => boolean) => { handlers.set(id, handler); return { dispose() {} }; } },
    write: (data: string, done: () => void) => writes.push({ data, done })
  };
  const output = createTerminalOutput(terminal as unknown as Terminal);
  output.write("\x1b]4;1;#ff0000;2;?\x07\x1b]10;?\x07\x1b]11;?\x07", true);
  for (const id of [4, 10, 11, 12]) {
    expect(handlers.get(id)!()).toBe(false);
    expect(output.isHistoricalReply()).toBe(true);
  }
  await Promise.resolve();
  expect(output.isHistoricalReply()).toBe(false);
  writes[0]!.done();
  output.write("live"); handlers.get(10)!();
  expect(output.isHistoricalReply()).toBe(false);
  output.dispose();
});
