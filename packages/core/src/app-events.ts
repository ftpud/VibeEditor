import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

export type AppEvent =
  | { type: "tasks.changed" }
  | { type: "ai.changed"; workspace: string }
  | { type: "commit-message.changed"; workspace: string; message: string };
export type AppCommand = { name: string; args: Record<string, unknown>; currentWorkspace?: string };

export class AppEventBridge {
  readonly directory: string;
  readonly commandsDirectory: string;
  readonly responsesDirectory: string;

  constructor(rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.directory = path.join(stateDirectory, `${key}-events`);
    this.commandsDirectory = path.join(stateDirectory, `${key}-commands`);
    this.responsesDirectory = path.join(stateDirectory, `${key}-responses`);
  }

  async ready(): Promise<void> { await Promise.all([this.directory, this.commandsDirectory, this.responsesDirectory].map((directory) => mkdir(directory, { recursive: true }))); }

  async emit(event: AppEvent): Promise<void> {
    await this.ready();
    const file = path.join(this.directory, `${Date.now()}-${process.pid}-${crypto.randomUUID()}.json`);
    await writeFile(file, `${JSON.stringify(event)}\n`, "utf8");
  }

  async consume(file: string): Promise<AppEvent | undefined> {
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as Partial<AppEvent>;
      if (value.type === "tasks.changed") return { type: value.type };
      if (value.type === "ai.changed" && typeof value.workspace === "string") return { type: value.type, workspace: value.workspace };
      if (value.type === "commit-message.changed" && typeof value.workspace === "string" && typeof value.message === "string") return { type: value.type, workspace: value.workspace, message: value.message };
      return undefined;
    } finally { await rm(file, { force: true }).catch(() => undefined); }
  }

  async call(command: AppCommand, timeoutMs = 30_000): Promise<unknown> {
    await this.ready();
    const id = `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
    const responseFile = path.join(this.responsesDirectory, `${id}.json`);
    await writeFile(path.join(this.commandsDirectory, `${id}.json`), `${JSON.stringify(command)}\n`, "utf8");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(await readFile(responseFile, "utf8")) as { ok: boolean; result?: unknown; error?: string };
        await rm(responseFile, { force: true });
        if (!response.ok) throw new Error(response.error ?? "Vibe Editor command failed");
        return response.result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error("Timed out waiting for the Vibe Editor core process");
  }

  async consumeCommand(file: string, execute: (command: AppCommand) => Promise<unknown>): Promise<void> {
    const id = path.basename(file, ".json");
    let response: { ok: boolean; result?: unknown; error?: string };
    try {
      const command = JSON.parse(await readFile(file, "utf8")) as AppCommand;
      if (!command || typeof command.name !== "string" || !command.args || typeof command.args !== "object") throw new Error("Invalid Vibe Editor command");
      response = { ok: true, result: await execute(command) };
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally { await rm(file, { force: true }).catch(() => undefined); }
    await writeFile(path.join(this.responsesDirectory, `${id}.json`), `${JSON.stringify(response)}\n`, "utf8");
  }
}
