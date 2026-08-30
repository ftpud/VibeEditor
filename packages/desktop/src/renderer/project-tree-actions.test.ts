import { describe, expect, it } from "vitest";
import { projectTreeActions } from "./project-tree-actions";

describe("projectTreeActions", () => {
  it("shares supported actions for a file selection", () => {
    expect(projectTreeActions({ node: { name: "readme.md", path: "readme.md", type: "file" } })).toEqual({
      createFile: true, createDirectory: true, rename: true, open: true, copyRelativePath: true, copyAbsolutePath: true, delete: true
    });
  });

  it("allows creation within a directory selection", () => {
    expect(projectTreeActions({ node: { name: "src", path: "src", type: "directory" } })).toMatchObject({
      createFile: true, createDirectory: true, rename: true, open: false, copyRelativePath: true, copyAbsolutePath: true, delete: true
    });
  });
});
