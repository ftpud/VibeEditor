import type { ProjectTreeAction } from "./project-tree-actions";

export const copyProjectTreeActions: readonly { action: ProjectTreeAction; label: string }[] = [
  { action: "copyRelativePath", label: "Copy Workspace-Relative Path" },
  { action: "copyAbsolutePath", label: "Copy Remote Absolute Path" }
];
