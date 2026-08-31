import type { FileTreeNode } from "@remote-ide/protocol";

/** A single tree selection drives both its menu and keyboard commands. */
export type ProjectTreeAction = "createFile" | "createDirectory" | "rename" | "open" | "duplicate" | "copyTo" | "moveTo" | "copyRelativePath" | "copyAbsolutePath" | "delete";
export type ProjectTreeSelection = { node: FileTreeNode; count?: number };

export function projectTreeActions(selection: ProjectTreeSelection): Record<ProjectTreeAction, boolean> {
  const { node } = selection;
  return {
    // A file selection creates alongside that file; a directory creates within it.
    createFile: true,
    createDirectory: true,
    rename: Boolean(node.path),
    open: node.type === "file",
    duplicate: Boolean(node.path),
    copyTo: Boolean(node.path),
    moveTo: Boolean(node.path),
    copyRelativePath: Boolean(node.path),
    copyAbsolutePath: Boolean(node.path),
    delete: Boolean(node.path)
  };
}
