import type { FileTreeNode } from "@remote-ide/protocol";

/** The focused node and stable selection count drive both menus and keyboard commands. */
export type ProjectTreeAction = "createFile" | "createDirectory" | "rename" | "open" | "duplicate" | "copyTo" | "moveTo" | "copyRelativePath" | "copyAbsolutePath" | "delete";
export type ProjectTreeSelection = { node: FileTreeNode; count?: number };

export function projectTreeActions(selection: ProjectTreeSelection): Record<ProjectTreeAction, boolean> {
  const { node } = selection;
  const single = (selection.count ?? 1) === 1;
  const mutablePath = Boolean(node.path);
  return {
    // A file selection creates alongside that file; a directory creates within it.
    createFile: single,
    createDirectory: single,
    rename: single && mutablePath,
    open: single && node.type === "file",
    duplicate: mutablePath,
    copyTo: mutablePath,
    moveTo: mutablePath,
    copyRelativePath: mutablePath,
    copyAbsolutePath: mutablePath,
    delete: single && mutablePath
  };
}
