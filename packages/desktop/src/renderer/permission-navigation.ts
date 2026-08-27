export function openTaskFromSummary({ taskId, pendingPermission, sideLayout, openClassicAi, openFocusedAi, switchTask }: {
  taskId?: string;
  pendingPermission: boolean;
  sideLayout: "classic" | "ai-focused";
  openClassicAi(): void;
  openFocusedAi(): void;
  switchTask(taskId?: string): void;
}) {
  if (pendingPermission) {
    if (sideLayout === "classic") openClassicAi();
    else openFocusedAi();
  }
  switchTask(taskId);
}
