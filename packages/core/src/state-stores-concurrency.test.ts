import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { AiTimerStore } from "./ai-timers.js";
import { WorkspaceStateStore } from "./workspace-state.js";

it("preserves timer mutations and coherent option backups across independent Core processes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "state-store-processes-"));
  const timersModule = new URL("./ai-timers.ts", import.meta.url).href;
  const optionsModule = new URL("./workspace-state.ts", import.meta.url).href;
  const run = (name: string, cancel = false) => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { AiTimerStore } from ${JSON.stringify(timersModule)};
    import { WorkspaceStateStore } from ${JSON.stringify(optionsModule)};
    const timers = new AiTimerStore('/workspace', process.argv[1]);
    const options = new WorkspaceStateStore('/workspace', process.argv[1]);
    for (let index = 0; index < 8; index++) {
      ${cancel ? "await timers.removeWorkspace('/task/first-' + index);" : `await timers.set('/task/${name}-' + index, 'provider', 'continue', 60);`}
      await options.save({openFiles:[],gitCommitMessage:${JSON.stringify(name)} + '-' + index});
    }
  `, directory], { timeout: 20_000 });
  try {
    await Promise.all([run("first"), run("second")]);
    const timers = new AiTimerStore("/workspace", directory);
    expect(await timers.list()).toHaveLength(16);
    await Promise.all([run("remove", true), run("third")]);
    const remaining = await timers.list();
    expect(remaining).toHaveLength(16);
    expect(remaining.some((timer) => timer.workspace.startsWith("/task/first-"))).toBe(false);
    expect(remaining.filter((timer) => timer.workspace.startsWith("/task/third-"))).toHaveLength(8);
    const options = await new WorkspaceStateStore("/workspace", directory).load();
    expect(options.gitCommitMessage).toMatch(/^(remove|third)-[0-7]$/);
    const optionsFile = path.join(directory, `${createHash("sha256").update("/workspace").digest("hex")}.json`);
    expect(JSON.parse(await readFile(`${optionsFile}.bak`, "utf8")).gitCommitMessage).toMatch(/^(remove|third)-[0-7]$/);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
