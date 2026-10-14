import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { HarnessBlock } from "@remote-ide/protocol";
import { TerminalSessionHost } from "./process-manager.js";
import { executeTerminalControl } from "./workflow-terminal.js";
import { WorkflowAppService } from "./workflow-app.js";

it("starts a named terminal and executes its command in one call", async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "terminal-command-")));
  const host = new TerminalSessionHost(() => {});
  try {
    const opened = JSON.parse(executeTerminalControl(JSON.stringify({ action: "open_and_run", name: "Command", command: "pwd > command-result.txt" }), workspace, host, () => {}).messages[0]!.text);
    expect(opened).toMatchObject({ terminalId: expect.any(String), displayName: "Command", status: "running" });
    await vi.waitFor(async () => expect((await readFile(path.join(workspace, "command-result.txt"), "utf8")).trim()).toBe(workspace));
    expect(host.attach(workspace, opened.terminalId)?.status).toBe("running");
    expect(host.attach("/another", opened.terminalId)).toBeUndefined();
  } finally { host.closeAll(); await rm(workspace, { recursive: true, force: true }); }
});

it("validates open_and_run before opening a terminal and preserves existing newlines", () => {
  const write = vi.fn();
  const kill = vi.fn();
  const factory = vi.fn(() => ({ write, resize: vi.fn(), kill, onData: vi.fn(), onExit: vi.fn() }));
  const host = new TerminalSessionHost(() => {}, factory);
  const call = (args: unknown) => executeTerminalControl(JSON.stringify(args), "/task", host, () => {});
  for (const command of [undefined, "", "  ", 12, "x".repeat(100001), "echo\0bad"]) {
    expect(() => call({ action: "open_and_run", name: "Command", command })).toThrow("command");
  }
  expect(() => call({ action: "open_and_run", name: "", command: "echo ready" })).toThrow("name");
  expect(() => executeTerminalControl('{"action":"open_and_run","name":"Command","command":"echo ready"}', "/task", host, () => { throw new Error("cancelled"); })).toThrow("cancelled");
  expect(factory).not.toHaveBeenCalled();
  call({ action: "open_and_run", name: "Command", command: "echo ready" });
  call({ action: "open_and_run", name: "Command", command: "echo ready\n" });
  expect(write.mock.calls).toEqual([["echo ready\n"], ["echo ready\n"]]);
  write.mockImplementationOnce(() => { throw new Error("write failed"); });
  expect(() => call({ action: "open_and_run", name: "Failed", command: "echo ready" })).toThrow("write failed");
  expect(kill).toHaveBeenCalledTimes(1);
  expect(host.list("/task")).toHaveLength(2);
  host.closeAll();
});

it("opens named task terminals, lists, writes and reads while rejecting other workspaces", () => {
  let data: ((value: string) => void) | undefined;
  const write = vi.fn();
  const events = vi.fn();
  const factory = vi.fn(() => ({ write, resize: vi.fn(), kill: vi.fn(), onData: (callback: (value: string) => void) => { data = callback; return { dispose() {} }; }, onExit: vi.fn() }));
  const host = new TerminalSessionHost(events, factory);
  const call = (args: unknown, workspace = "/task") => JSON.parse(executeTerminalControl(JSON.stringify(args), workspace, host, () => {}).messages[0]!.text);
  const opened = call({ action: "open", name: "Dev server" });
  expect(factory).toHaveBeenCalledWith("/task", 100, 30);
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "opened", workspace: "/task", session: expect.objectContaining({ displayName: "Dev server" }) }));
  expect(call({ action: "list" }).terminals).toEqual([expect.objectContaining({ terminalId: opened.terminalId, displayName: "Dev server" })]);
  expect(call({ action: "list" }, "/another").terminals).toEqual([]);
  expect(() => call({ action: "write", terminal_id: opened.terminalId, data: "secret" }, "/another")).toThrow("not found");
  call({ action: "write", terminal_id: opened.terminalId, data: "npm run dev\n" });
  expect(write).toHaveBeenCalledWith("npm run dev\n");
  data!("first\r\nsecond\r\nthird");
  expect(call({ action: "read", terminal_id: opened.terminalId, lines: 2 }).output).toBe("second\nthird");
  expect(() => call({ action: "read", terminal_id: opened.terminalId, lines: 0 })).toThrow("lines");
  expect(() => call({ action: "open", name: "" })).toThrow("name");
  expect(() => executeTerminalControl('{"action":"open","name":"blocked"}', "/task", host, () => { throw new Error("cancelled"); })).toThrow("cancelled");
  expect(factory).toHaveBeenCalledTimes(1);
  host.closeAll();
});

it("runs apps in a writable PTY in the task workspace and exposes their named terminal", async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "terminal-app-")));
  const host = new TerminalSessionHost(() => {});
  const apps = new WorkflowAppService(host);
  try {
    const block: HarnessBlock = { id: "app", type: "run_app", label: "App", prompt: "", position: { x: 0, y: 0 }, app: { name: "Interactive", actions: ["start"] }, command: 'test -t 0 && test -t 1 && printf "PTY_READY\\n"; read -r answer; printf "ANSWER:%s|%s\\n" "$answer" "$PWD"; exec sleep 300' };
    await apps.execute(block, "", workspace, () => {});
    const terminal = host.list(workspace)[0]!;
    expect(terminal.displayName).toBe("Interactive");
    await vi.waitFor(() => expect(host.attach(workspace, terminal.terminalId)?.output).toContain("PTY_READY"));
    executeTerminalControl(JSON.stringify({ action: "write", terminal_id: terminal.terminalId, data: "hello\n" }), workspace, host, () => {});
    await vi.waitFor(() => expect(apps.read("Interactive", workspace).output).toContain(`ANSWER:hello|${workspace}`));
    expect(host.list("/another")).toEqual([]);
  } finally { await apps.closeAll(); host.closeAll(); await rm(workspace, { recursive: true, force: true }); }
});
