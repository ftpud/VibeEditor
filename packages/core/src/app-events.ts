import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

export type AppEvent =
  | { type: "tasks.changed" }
  | { type: "ai.changed"; workspace: string }
  | { type: "commit-message.changed"; workspace: string; message: string };

export class AppEventBridge {
  readonly directory: string;

  constructor(rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.directory = path.join(stateDirectory, `${key}-events`);
  }

  async ready(): Promise<void> { await mkdir(this.directory, { recursive: true }); }

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
}
