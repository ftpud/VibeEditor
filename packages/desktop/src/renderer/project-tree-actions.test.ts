import { describe, expect, it } from "vitest";
import { projectTreeActions } from "./project-tree-actions";

describe("projectTreeActions", () => {
  it("shares supported actions for a file selection", () => {
    expect(projectTreeActions({ node: { name: "readme.md", path: "readme.md", type: "file" } })).toEqual({
      createFile: true, createDirectory: true, rename: true, open: true,
      duplicate: true, copyTo: true, moveTo: true,
      copyRelativePath: true, copyAbsolutePath: true, delete: true
    });
  });

  it("allows creation within a directory selection", () => {
    expect(projectTreeActions({ node: { name: "src", path: "src", type: "directory" } })).toEqual({
      createFile: true, createDirectory: true, rename: true, open: false,
      duplicate: true, copyTo: true, moveTo: true,
      copyRelativePath: true, copyAbsolutePath: true, delete: true
    });
  });

  it("limits a multi-selection to safe bulk and path-copy actions", () => {
    expect(projectTreeActions({ node: { name: "readme.md", path: "readme.md", type: "file" }, count: 3 })).toEqual({
      createFile: false, createDirectory: false, rename: false, open: false,
      duplicate: true, copyTo: true, moveTo: true,
      copyRelativePath: true, copyAbsolutePath: true, delete: false
    });
  });

  it("keeps workspace-root creation available without exposing path mutations", () => {
    expect(projectTreeActions({ node: { name: "REMOTE WORKSPACE", path: "", type: "directory" } })).toEqual({
      createFile: true, createDirectory: true, rename: false, open: false,
      duplicate: false, copyTo: false, moveTo: false,
      copyRelativePath: false, copyAbsolutePath: false, delete: false
    });
  });
});
