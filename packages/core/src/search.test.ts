import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceFileSystem } from "./filesystem.js";
import { WorkspaceSearch } from "./search.js";

describe("WorkspaceSearch", () => {
  it("searches recursively inside a selected directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-search-"));
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "const target = 1;\n");
    await writeFile(path.join(root, "src", "nested", "b.ts"), "TARGET value\n");
    await writeFile(path.join(root, "outside.ts"), "target outside\n");
    const filesystem = new WorkspaceFileSystem();
    await filesystem.open(root);
    const result = await new WorkspaceSearch(filesystem).search("target", "src", false);
    expect(result.matches.map((match) => match.path)).toEqual(["src/a.ts", "src/nested/b.ts"]);
    expect(result.matches[0]).toMatchObject({ line: 1, column: 7 });
    expect(result.matches[0]?.context).toEqual({
      before: [],
      after: [{ line: 2, text: "", truncated: false }],
      truncatedBefore: false,
      truncatedAfter: false
    });
  });

  it("returns bounded surrounding context and marks omitted or shortened content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-search-"));
    const longLine = "a".repeat(201);
    await writeFile(path.join(root, "a.txt"), `one\ntwo\nthree\n${longLine}\ntarget\nsix\nseven\neight\n`);
    const filesystem = new WorkspaceFileSystem();
    await filesystem.open(root);

    const result = await new WorkspaceSearch(filesystem).search("target", "", false);

    expect(result.matches[0]?.context).toEqual({
      before: [
        { line: 3, text: "three", truncated: false },
        { line: 4, text: "a".repeat(200), truncated: true }
      ],
      after: [
        { line: 6, text: "six", truncated: false },
        { line: 7, text: "seven", truncated: false }
      ],
      truncatedBefore: true,
      truncatedAfter: true
    });
  });

  it("supports case-sensitive matching", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-search-"));
    await writeFile(path.join(root, "a.txt"), "Target\ntarget\n");
    const filesystem = new WorkspaceFileSystem();
    await filesystem.open(root);
    const result = await new WorkspaceSearch(filesystem).search("Target", "", true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ line: 1, column: 1 });
  });

  it("returns every non-overlapping occurrence on a line", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "remote-ide-search-"));
    await writeFile(path.join(root, "a.txt"), "target target TARGET\ntargettarget\n");
    const filesystem = new WorkspaceFileSystem();
    await filesystem.open(root);

    const result = await new WorkspaceSearch(filesystem).search("target", "", false);

    expect(result.truncated).toBe(false);
    expect(result.matches.map(({ line, column }) => ({ line, column }))).toEqual([
      { line: 1, column: 1 },
      { line: 1, column: 8 },
      { line: 1, column: 15 },
      { line: 2, column: 1 },
      { line: 2, column: 7 }
    ]);
  });
});
