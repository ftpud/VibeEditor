export type TaskPanelLayout = "classic" | "ai-focused";
export type ClassicTaskPanel = "project" | "git" | "taskGit" | "java" | "useful" | "agents";

export function taskPanelPreferenceKey(layout: TaskPanelLayout, taskId: string): string {
  return `taskPanel.${layout}.${taskId}`;
}

export function initialTaskPanel(
  layout: TaskPanelLayout,
  taskId: string | undefined,
  readPreference: (key: string) => string | null
): { classic?: ClassicTaskPanel; focusedTaskGit?: boolean } {
  if (!taskId) return {};
  const saved = readPreference(taskPanelPreferenceKey(layout, taskId));
  if (layout === "ai-focused") return { focusedTaskGit: saved === null ? true : saved === "open" };
  return { classic: isClassicTaskPanel(saved) ? saved : "taskGit" };
}

export function switchedTaskPanel(taskId: string | undefined): { classic?: "taskGit"; focusedTaskGit?: true } {
  return taskId ? { classic: "taskGit", focusedTaskGit: true } : {};
}

function isClassicTaskPanel(value: string | null): value is ClassicTaskPanel {
  return value !== null && ["project", "git", "taskGit", "java", "useful", "agents"].includes(value);
}
