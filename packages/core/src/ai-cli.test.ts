import { describe, expect, it } from "vitest";
import { parseCopilotModels } from "./copilot.js";
import { execInShell } from "./shell-process.js";

describe("AI CLI integration", () => {
  it("discovers and deduplicates models provided by Copilot help", () => {
    const models = parseCopilotModels("--model <model> choices: GPT-5.4, claude-sonnet-4.6, gpt-5.4");
    expect(models.map((model) => model.id)).toEqual(["auto", "gpt-5.4", "claude-sonnet-4.6"]);
  });

  it("runs commands through the login shell without interpolating arguments", async () => {
    const marker = "value with spaces; $(not-a-command)";
    const result = await execInShell("printf", ["%s", marker], { encoding: "utf8", timeout: 10_000 });
    expect(result.stdout).toBe(marker);
  });
});
