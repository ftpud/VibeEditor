import type { FilesystemSnapshotEntry, FileTreeNode } from "@remote-ide/protocol";

/** Applies Core's current-state snapshot; watcher ordering is intentionally ignored. */
export function reconcileProjectTree(tree: FileTreeNode[], entries: FilesystemSnapshotEntry[]): FileTreeNode[] {
  const root = structuredClone(tree) as FileTreeNode[];
  const remove = (nodes: FileTreeNode[], target: string): boolean => {
    const index = nodes.findIndex((node) => node.path === target);
    if (index >= 0) { nodes.splice(index, 1); return true; }
    return nodes.some((node) => node.children && remove(node.children, target));
  };
  const ensureDirectory = (directory: string) => {
    let nodes = root;
    let current = "";
    for (const part of directory.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      let node = nodes.find((item) => item.path === current);
      if (!node) { node = { name: part, path: current, type: "directory", children: [] }; nodes.push(node); }
      if (node.type !== "directory") return undefined;
      nodes = node.children ??= [];
    }
    return nodes;
  };
  for (const entry of entries) {
    remove(root, entry.path);
    if (!entry.type) continue;
    const segments = entry.path.split("/");
    const parent = ensureDirectory(segments.slice(0, -1).join("/"));
    if (!parent) continue;
    parent.push({ name: segments.at(-1)!, path: entry.path, type: entry.type, ...(entry.type === "directory" ? { children: [] } : {}) });
  }
  const sort = (nodes: FileTreeNode[]) => { nodes.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1); nodes.forEach((node) => node.children && sort(node.children)); };
  sort(root);
  return root;
}
