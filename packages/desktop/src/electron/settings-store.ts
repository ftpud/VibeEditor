import fs from "node:fs";
import path from "node:path";

/**
 * Durable store for renderer UI settings such as panel visibility, panel sizes, and fonts.
 *
 * The packaged renderer is loaded from a `file://` origin where browser storage is not guaranteed to
 * survive an application restart, so the values are kept in a JSON file inside the user data folder.
 */
export class SettingsStore {
  private readonly file: string;
  private values: Record<string, string> = {};
  private writeTimer: NodeJS.Timeout | undefined;

  constructor(file: string) {
    this.file = file;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) if (typeof value === "string") this.values[key] = value;
      }
    } catch { /* No settings stored yet, or the file is unreadable. */ }
  }

  all(): Record<string, string> { return { ...this.values }; }

  set(key: unknown, value: unknown): void {
    if (typeof key !== "string" || key.length === 0 || key.length > 1024) return;
    if (typeof value === "string") { if (value.length > 1_000_000) return; this.values[key] = value; }
    else if (value === null) delete this.values[key];
    else return;
    if (!this.writeTimer) this.writeTimer = setTimeout(() => { this.writeTimer = undefined; this.flush(); }, 250);
  }

  flush(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = undefined; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.values), "utf8");
      fs.renameSync(temporary, this.file);
    } catch (error) { console.error("[desktop] could not persist settings", error); }
  }
}
