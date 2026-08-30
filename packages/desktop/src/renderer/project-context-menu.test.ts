import { describe, expect, it } from "vitest";
import { copyProjectTreeActions } from "./project-context-menu";

describe("project context menu copy submenu", () => {
  it("keeps every copy action together in the Copy submenu", () => {
    expect(copyProjectTreeActions).toEqual([
      { action: "copyRelativePath", label: "Copy Workspace-Relative Path" },
      { action: "copyAbsolutePath", label: "Copy Remote Absolute Path" }
    ]);
  });
});
