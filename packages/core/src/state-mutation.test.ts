import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializedStateMutation } from "./root-mutation.js";

const exec = promisify(execFile);
const rootMutationUrl = pathToFileURL(fileURLToPath(new URL("./root-mutation.ts", import.meta.url))).href;
const childSource = `
import { readFile, writeFile } from "node:fs/promises";
import { serializedStateMutation } from ${JSON.stringify(rootMutationUrl)};
const [mode, file, iterations] = process.argv.slice(1);
if (mode === "hold") {
  await serializedStateMutation(file, async () => {
    // An unresolved promise alone does not keep a Node process alive.
    const keepAlive = setInterval(() => {}, 1000);
    console.log("LEASED");
    try {
      await new Promise(() => {});
    } finally {
      clearInterval(keepAlive);
    }
  });
} else {
  for (let index = 0; index < Number(iterations); index += 1) {
    await serializedStateMutation(file, async () => {
      const state = JSON.parse(await readFile(file, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.count += 1;
      await writeFile(file, JSON.stringify(state));
    });
  }
}
`;

let directory: string;
let stateFile: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "vibe-state-lock-"));
  stateFile = path.join(directory, "nested", "state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

function runChild(mode: string, iterations = "0") {
  return exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource, mode, stateFile, iterations], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });
}

describe("serialized state mutation locking", () => {
  it("preserves read-modify-write updates made by overlapping processes", async () => {
    await writeFile(stateFile, JSON.stringify({ count: 0 }));
    await Promise.all([runChild("increment", "12"), runChild("increment", "12")]);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({ count: 24 });
  });

  it("recovers a lease abandoned by a SIGKILLed process", async () => {
    await writeFile(stateFile, JSON.stringify({ count: 0 }));
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource, "hold", stateFile], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("LEASED")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Lock holder exited before acquiring its lease (${code ?? signal}): ${stderr}`)));
    });
    expect(JSON.parse(await readFile(`${stateFile}.lock`, "utf8")).pid).toBe(child.pid);
    child.kill("SIGKILL");
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (_code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`Expected SIGKILL, got ${signal}`)));
    });

    await expect(runChild("increment", "1")).resolves.toMatchObject({ stdout: "" });
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual({ count: 1 });
    await expect(readFile(`${stateFile}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves legacy empty directory locks instead of guessing their ownership", async () => {
    await mkdir(`${stateFile}.lock`);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 30_001);
    const operation = vi.fn();
    await expect(serializedStateMutation(stateFile, operation)).rejects.toThrow("State file is locked by an unknown owner");
    expect(operation).not.toHaveBeenCalled();
    await expect(readFile(`${stateFile}.lock`, "utf8")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("releases the in-process queue and owned lock when an operation fails", async () => {
    await writeFile(stateFile, JSON.stringify({ count: 0 }));
    await expect(serializedStateMutation(stateFile, async () => { throw new Error("state write failed"); })).rejects.toThrow("state write failed");
    await expect(serializedStateMutation(stateFile, async () => "next operation")).resolves.toBe("next operation");
    await expect(readFile(`${stateFile}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
