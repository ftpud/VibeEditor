import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { UsefulFile, UsefulFileScope } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

export class UsefulFilesStore {
  private readonly root: string;
  constructor(workspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(workspace).digest("hex");
    this.root = path.join(stateDirectory, "useful-files");
    this.localDirectory = path.join(this.root, "local", key);
  }
  private readonly localDirectory: string;

  async list(): Promise<UsefulFile[]> {
    const collect = async (scope: UsefulFileScope) => { try { return (await readdir(this.directory(scope), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => ({ scope, name: entry.name })); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } };
    return [...await collect("global"), ...await collect("local")].sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  }
  async read(scope: UsefulFileScope, name: string): Promise<string> { try { return await readFile(this.target(scope, name), "utf8"); } catch (error) { throw new CoreError("READ_FAILED", `Could not read useful file: ${error instanceof Error ? error.message : String(error)}`); } }
  async create(scope: UsefulFileScope, name: string): Promise<void> { const target = this.target(scope, name); await mkdir(path.dirname(target), { recursive: true }); try { await writeFile(target, "", { encoding: "utf8", flag: "wx" }); } catch (error) { throw new CoreError("WRITE_FAILED", `Could not create useful file: ${error instanceof Error ? error.message : String(error)}`); } }
  async write(scope: UsefulFileScope, name: string, content: string): Promise<void> { if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new CoreError("FILE_TOO_LARGE", "Useful file exceeds 2 MB"); try { await writeFile(this.target(scope, name), content, "utf8"); } catch (error) { throw new CoreError("WRITE_FAILED", `Could not write useful file: ${error instanceof Error ? error.message : String(error)}`); } }
  async rename(scope: UsefulFileScope, name: string, newName: string): Promise<void> { try { const destination = this.target(scope, newName); try { await access(destination); throw new CoreError("WRITE_FAILED", `Useful file already exists: ${newName}`); } catch (error) { if (error instanceof CoreError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await rename(this.target(scope, name), destination); } catch (error) { if (error instanceof CoreError) throw error; throw new CoreError("WRITE_FAILED", `Could not rename useful file: ${error instanceof Error ? error.message : String(error)}`); } }
  async delete(scope: UsefulFileScope, name: string): Promise<void> { try { await rm(this.target(scope, name)); } catch (error) { throw new CoreError("WRITE_FAILED", `Could not delete useful file: ${error instanceof Error ? error.message : String(error)}`); } }
  private directory(scope: UsefulFileScope): string { if (scope !== "global" && scope !== "local") throw new CoreError("INVALID_REQUEST", "Invalid useful file scope"); return scope === "global" ? path.join(this.root, "global") : this.localDirectory; }
  private target(scope: UsefulFileScope, name: string): string { if (!name || name.length > 180 || name !== path.basename(name) || name === "." || name === ".." || name.includes("\0")) throw new CoreError("INVALID_REQUEST", "Useful file name must be a plain file name"); return path.join(this.directory(scope), name); }
}
