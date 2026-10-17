import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILT_IN = /["'](codex|claude|copilot)["']/;

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return full.endsWith(path.join("ai", "providers")) ? [] : sources(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("provider isolation", () => {
  it("keeps built-in provider IDs out of shared Core code", () => {
    // Starter/fallback defaults and the legacy Codex runtime cache migration are the only tolerated mentions.
    const allowed = new Set(["harness-runner.ts", "configuration.ts", "storage-versions.ts", "provider-definitions.ts"]);
    const offenders = sources(SRC).filter((file) => !allowed.has(path.basename(file))).filter((file) => BUILT_IN.test(readFileSync(file, "utf8"))).map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
