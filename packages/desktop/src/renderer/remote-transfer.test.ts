import { describe, expect, it } from "vitest";
import { remoteUploadDestination, treeContainsPath } from "./remote-transfer";

describe("remote project transfer UI policy", () => {
  it("uploads into a selected directory or a file's parent", () => { expect(remoteUploadDestination({ type: "directory", path: "assets" }, "photo.png")).toBe("assets/photo.png"); expect(remoteUploadDestination({ type: "file", path: "src/app.ts" }, "data.bin")).toBe("src/data.bin"); });
  it("does not allow a local name to choose a remote path", () => { expect(() => remoteUploadDestination({ type: "directory", path: "assets" }, "../secret")).toThrow("invalid name"); });
  it("detects nested overwrite collisions", () => { expect(treeContainsPath([{ name: "assets", path: "assets", type: "directory", children: [{ name: "a.bin", path: "assets/a.bin", type: "file" }] }], "assets/a.bin")).toBe(true); });
});
