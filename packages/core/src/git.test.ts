import { describe, expect, it } from "vitest";
import { parseGitStatus } from "./git.js";

describe("parseGitStatus", () => {
  it("parses branch and changed file states", () => {
    const result = parseGitStatus("## main...origin/main\0 M src/app.ts\0A  src/new.ts\0?? notes.txt\0");
    expect(result.branch).toBe("main");
    expect(result.entries).toEqual([
      { path: "src/app.ts", indexStatus: " ", worktreeStatus: "M" },
      { path: "src/new.ts", indexStatus: "A", worktreeStatus: " " },
      { path: "notes.txt", indexStatus: "?", worktreeStatus: "?" }
    ]);
  });

  it("parses null-delimited rename records", () => {
    expect(parseGitStatus("## main\0R  src/new.ts\0src/old.ts\0").entries[0]).toEqual({
      path: "src/new.ts", originalPath: "src/old.ts", indexStatus: "R", worktreeStatus: " "
    });
  });
});
