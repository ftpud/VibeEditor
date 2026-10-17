export type TaskPanelLayout = "classic" | "ai-focused";
export type ClassicTaskPanel = "project" | "git" | "taskGit" | "java" | "useful" | "agents" | "harness" | "workflowRuns" | "timers" | "triggers" | "proc";

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
  return value !== null && ["project", "git", "taskGit", "java", "useful", "agents", "harness", "workflowRuns", "timers", "triggers", "proc"].includes(value);
}

export type FocusedLeftPanels = { tasks: boolean; ai: boolean; harness: boolean; timers: boolean; triggers: boolean; proc: boolean };

/** Restore one primary tool window while preserving the independent Tasks panel. */
export function restoredFocusedLeftPanels(current: FocusedLeftPanels, saved: Partial<FocusedLeftPanels>): FocusedLeftPanels {
  const panels = { ...current, ...saved };
  const proc = panels.proc === true;
  const harness = panels.harness === true && !proc;
  const timers = panels.timers === true && !proc && !harness;
  const triggers = panels.triggers === true && !proc && !harness && !timers;
  return { tasks: panels.tasks === true, proc, harness, timers, triggers, ai: panels.ai === true && !proc && !harness && !timers && !triggers };
}
