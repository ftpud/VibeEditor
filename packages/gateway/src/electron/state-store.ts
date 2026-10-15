import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export class JsonStateStore<T> {
  private transactionTail: Promise<void> = Promise.resolve();
  private readonly backupPath: string;

  constructor(
    private readonly filePath: string,
    private readonly defaults: () => T,
    private readonly decode: (text: string) => T,
  ) {
    this.backupPath = `${filePath}.bak`;
  }

  flush(): Promise<void> { return this.transactionTail; }

  async read(): Promise<T> {
    const operation = this.transactionTail.then(() => this.readUnlocked());
    this.transactionTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  update<R>(mutate: (state: T) => R | Promise<R>): Promise<{ state: T; result: R }> {
    const operation = this.transactionTail.then(async () => {
      const state = await this.readUnlocked();
      const result = await mutate(state);
      await this.writeUnlocked(state);
      return { state, result };
    });
    this.transactionTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readUnlocked(): Promise<T> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        contents = await readFile(this.backupPath, "utf8");
      } catch (backupError) {
        if (isMissing(backupError)) return this.defaults();
        throw backupError;
      }
      let recovered: T;
      try { recovered = this.decode(contents); }
      catch (error) { throw recoveryError(this.filePath, this.backupPath, error); }
      console.warn(`Gateway state file ${this.filePath} was missing; restoring last-good backup ${this.backupPath}.`);
      await this.replacePrimary(contents);
      return recovered;
    }

    try {
      return this.decode(contents);
    } catch (primaryError) {
      let backup: string;
      try { backup = await readFile(this.backupPath, "utf8"); }
      catch (backupError) {
        if (isMissing(backupError)) throw recoveryError(this.filePath, this.backupPath, primaryError);
        throw backupError;
      }
      let recovered: T;
      try { recovered = this.decode(backup); }
      catch (backupError) { throw recoveryError(this.filePath, this.backupPath, backupError, primaryError); }
      console.warn(`Gateway state file ${this.filePath} is corrupt; restoring last-good backup ${this.backupPath}.`);
      try { await this.replacePrimary(backup); }
      catch (restoreError) { throw recoveryError(this.filePath, this.backupPath, restoreError, primaryError); }
      return recovered;
    }
  }

  private async writeUnlocked(state: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const backupTemporary = `${this.backupPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      try {
        const previous = await readFile(this.filePath);
        await writeTemporary(backupTemporary, previous);
        await rename(backupTemporary, this.backupPath);
        await syncDirectory(path.dirname(this.filePath));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await writeTemporary(temporary, JSON.stringify(state, null, 2));
      await rename(temporary, this.filePath);
      await syncDirectory(path.dirname(this.filePath));
    } finally {
      await Promise.all([rm(temporary, { force: true }), rm(backupTemporary, { force: true })]);
    }
  }

  private async replacePrimary(contents: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.restore.tmp`;
    try {
      await writeTemporary(temporary, contents);
      await rename(temporary, this.filePath);
      await syncDirectory(path.dirname(this.filePath));
    } finally { await rm(temporary, { force: true }); }
  }
}

async function writeTemporary(filePath: string, contents: string | Buffer): Promise<void> {
  const file = await open(filePath, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally { await file.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Directory syncing is unsupported on some filesystems; file contents are synced before promotion.
  } finally { await handle?.close(); }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function recoveryError(primary: string, backup: string, cause: unknown, primaryCause?: unknown): Error {
  const details = [cause, primaryCause].filter(Boolean).map((error) => error instanceof Error ? error.message : String(error));
  return new Error(`Gateway state at ${primary} is corrupt and could not be restored from ${backup}${details.length ? `: ${details.join("; ")}` : ""}`, { cause });
}
