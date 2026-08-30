import { describe, expect, it } from "vitest";
import { projectTreeActions } from "./project-tree-actions";

describe("projectTreeActions", () => {
  it("shares supported actions for a file selection and keeps unsafe delete disabled", () => {
    expect(projectTreeActions({ node: { name: "readme.md", path: "readme.md", type: "file" } })).toEqual({
      createFile: true, createDirectory: true, rename: true, open: true, delete: false
    });
  });

  it("allows creation within a directory selection", () => {
    expect(projectTreeActions({ node: { name: "src", path: "src", type: "directory" } })).toMatchObject({
      createFile: true, createDirectory: true, rename: true, open: false, delete: false
    });
  });
});
