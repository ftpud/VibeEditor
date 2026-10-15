import type { LayoutModel } from "./model";

/** Only live output from a terminal the user isn't viewing needs attention. */
export function markTerminalActivity(layout: LayoutModel, terminalId: string): LayoutModel {
  const group = layout.terminalGroup;
  const tab = group.tabs.find((tab) => tab.terminalId === terminalId);
  if (!tab || tab.hasUnreadOutput || (tab.id === group.activeTabId && layout.panels.some((panel) => panel.type === "terminal"))) return layout;
  return { ...layout, terminalGroup: { ...group, tabs: group.tabs.map((item) => item.id === tab.id ? { ...item, hasUnreadOutput: true } : item) } };
}

export function clearViewedTerminalActivity(layout: LayoutModel): LayoutModel {
  const group = layout.terminalGroup;
  if (!layout.panels.some((panel) => panel.type === "terminal") || !group.tabs.some((tab) => tab.id === group.activeTabId && tab.hasUnreadOutput)) return layout;
  return { ...layout, terminalGroup: { ...group, tabs: group.tabs.map((tab) => tab.id === group.activeTabId ? { ...tab, hasUnreadOutput: false } : tab) } };
}
