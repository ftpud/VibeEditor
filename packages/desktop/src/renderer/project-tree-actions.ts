import type { FileTreeNode } from "@remote-ide/protocol";

/** A single tree selection drives both its menu and keyboard commands. */
export type ProjectTreeAction = "createFile" | "createDirectory" | "rename" | "open" | "delete";
export type ProjectTreeSelection = { node: FileTreeNode };

export function projectTreeActions(selection: ProjectTreeSelection): Record<ProjectTreeAction, boolean> {
  const { node } = selection;
  return {
    // A file selection creates alongside that file; a directory creates within it.
    createFile: true,
    createDirectory: true,
    rename: Boolean(node.path),
    open: node.type === "file",
    // Filesystem deletion deliberately remains unavailable until safe-delete exists.
    delete: false
  };
}
