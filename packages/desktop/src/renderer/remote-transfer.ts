import type { FileTreeNode } from "@remote-ide/protocol";

export function remoteUploadDestination(node: Pick<FileTreeNode, "type" | "path">, localName: string): string {
  if (!localName || localName === "." || localName === ".." || /[\\/\0]/.test(localName)) throw new Error("The selected local file has an invalid name");
  const directory = node.type === "directory" ? node.path : node.path.split("/").slice(0, -1).join("/");
  return [directory, localName].filter(Boolean).join("/");
}

export function treeContainsPath(nodes: FileTreeNode[], target: string): boolean { return nodes.some((node) => node.path === target || treeContainsPath(node.children ?? [], target)); }
