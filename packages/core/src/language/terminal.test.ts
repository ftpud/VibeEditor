import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { BUILT_IN_LANGUAGES } from "../plugins/builtin.js";
import { WorkspaceFileSystem } from "../filesystem.js";
import { WorkspaceStateStore } from "../workspace-state.js";
import { TerminalSessionHost, type TerminalPtyFactory } from "../process-manager.js";
import { runLanguageInTerminal, hasLanguageTerminalRun, stopLanguageTerminalRun } from "./terminal.js";

it("runs npm interactively in a real PTY with arguments, environment and exit reporting", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vibe-terminal-run-"));
  const terminals = new TerminalSessionHost(() => {});
  const filesystem = new WorkspaceFileSystem(); await filesystem.initialize(workspace);
  const exit = vi.fn();
  const service = BUILT_IN_LANGUAGES.find((item) => item.descriptor.id === "node")!.create({ workspace, filesystem, state: new WorkspaceStateStore(workspace, path.join(workspace, "state")), rootId: "test", events: { output: vi.fn(), exit, debugState: vi.fn(), semanticChanged: vi.fn() }, emit: vi.fn() });
  try {
    await mkdir(path.join(workspace, "web"));
    await writeFile(path.join(workspace, "web/package.json"), JSON.stringify({ scripts: { start: "node app.cjs" } }));
    await writeFile(path.join(workspace, "web/app.cjs"), `const input=require('node:readline').createInterface({input:process.stdin});input.once('line',line=>{console.log('INPUT '+line);process.exitCode=7;input.close()});console.log('READY '+JSON.stringify({stdin:process.stdin.isTTY,stdout:process.stdout.isTTY,mode:process.env.MODE,fileValue:process.env.FILE_VALUE,args:process.argv.slice(2)}));`);
    await writeFile(path.join(workspace, "run.env"), "MODE=file\nFILE_VALUE=from-file\n");
    await service.saveConfiguration(JSON.stringify({ type: "npm", packageJsonPath: "web/package.json", packageManager: "npm", runConfigurations: [{ id: "dev", name: "Development", script: "start", arguments: ["hello world", "$(literal)"], nodeOptions: ["--enable-source-maps"], environmentFile: "run.env", environment: { MODE: "override", FORCE_COLOR: "1" } }], selectedRunConfigurationId: "dev" }));
    const { terminal } = await runLanguageInTerminal(service, terminals, workspace);
    expect(terminal.displayName).toBe("Development");
    const ready = `READY ${JSON.stringify({ stdin: true, stdout: true, mode: "override", fileValue: "from-file", args: ["hello world", "$(literal)"] })}`;
    await vi.waitFor(() => expect(terminals.attach(workspace, terminal.terminalId)?.output).toContain(ready), { timeout: 5000 });
    await expect(runLanguageInTerminal(service, terminals, workspace)).rejects.toThrow("already running");
    await service.dispose(); // Renderer sessions may disconnect; Core keeps the PTY alive.
    expect(hasLanguageTerminalRun(terminals, workspace, "node")).toBe(true);
    terminals.input(workspace, terminal.terminalId, "hello terminal\n");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(7), { timeout: 5000 });
    expect(terminals.attach(workspace, terminal.terminalId)).toMatchObject({ status: "exited", exitCode: 7, output: expect.stringContaining("INPUT hello terminal") });
  } finally { await service.dispose(); terminals.closeAll(); await rm(workspace, { recursive: true, force: true }); }
  // Leave time for both bounded stage waits to report their actual assertion failure.
}, 15_000);

it("stops the run and releases its lifecycle when its terminal tab is closed", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vibe-terminal-stop-"));
  const filesystem = new WorkspaceFileSystem(); await filesystem.initialize(workspace);
  const exit = vi.fn();
  const service = BUILT_IN_LANGUAGES.find((item) => item.descriptor.id === "node")!.create({ workspace, filesystem, state: new WorkspaceStateStore(workspace, path.join(workspace, "state")), rootId: "test", events: { output: vi.fn(), exit, debugState: vi.fn(), semanticChanged: vi.fn() }, emit: vi.fn() });
  const kill = vi.fn();
  const factory = vi.fn<TerminalPtyFactory>(() => ({ write: vi.fn(), resize: vi.fn(), kill, onData: vi.fn(), onExit: vi.fn() }));
  const terminals = new TerminalSessionHost(() => {}, factory);
  try {
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { start: "node app.js" } }));
    const { terminal } = await runLanguageInTerminal(service, terminals, workspace);
    expect(stopLanguageTerminalRun(terminals, workspace, "node")).toBe(true); expect(kill).toHaveBeenCalledOnce();
    terminals.close(workspace, terminal.terminalId);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(terminals.attach(workspace, terminal.terminalId)).toBeUndefined();
    expect(factory.mock.calls[0]?.[3]).toMatchObject({ command: "npm", args: ["run", "start"] });
  } finally { await service.dispose(); terminals.closeAll(); await rm(workspace, { recursive: true, force: true }); }
});
