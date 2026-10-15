import { describe, expect, it } from "vitest";
import { initialLayout, type LayoutModel } from "./model";
import { clearViewedTerminalActivity, markTerminalActivity } from "./terminal-activity";

function layout(open = true): LayoutModel {
  return { ...initialLayout, panels: open ? [{ id: "terminal", type: "terminal" }] : [], terminalGroup: { id: "terminals", activeTabId: "first", tabs: [
    { id: "first", terminalId: "terminal-1", title: "Shell", status: "running" },
    { id: "second", terminalId: "terminal-2", title: "Workflow", status: "running" }
  ] } };
}

describe("terminal activity", () => {
  it("marks background output and keeps it unread until that tab is viewed", () => {
    const original = layout();
    const unread = markTerminalActivity(original, "terminal-2");
    expect(original.terminalGroup.tabs[1]?.hasUnreadOutput).toBeUndefined();
    expect(unread.terminalGroup.tabs[1]?.hasUnreadOutput).toBe(true);
    expect(unread.terminalGroup.tabs[0]?.hasUnreadOutput).toBeUndefined();
    expect(markTerminalActivity(unread, "terminal-2")).toBe(unread);
    expect(clearViewedTerminalActivity(unread)).toBe(unread);
    const viewed = clearViewedTerminalActivity({ ...unread, terminalGroup: { ...unread.terminalGroup, activeTabId: "second" } });
    expect(viewed.terminalGroup.tabs[1]?.hasUnreadOutput).toBe(false);
    expect(markTerminalActivity(viewed, "terminal-2")).toBe(viewed);
  });

  it("marks the selected terminal while the panel is hidden and clears it on reopening", () => {
    const unread = markTerminalActivity(markTerminalActivity(layout(false), "terminal-1"), "terminal-2");
    expect(unread.terminalGroup.tabs.every((tab) => tab.hasUnreadOutput)).toBe(true);
    expect(clearViewedTerminalActivity(unread)).toBe(unread);
    const viewed = clearViewedTerminalActivity({ ...unread, panels: [{ id: "terminal", type: "terminal" }] });
    expect(viewed.terminalGroup.tabs[0]?.hasUnreadOutput).toBe(false);
    expect(viewed.terminalGroup.tabs[1]?.hasUnreadOutput).toBe(true);
  });

  it("ignores visible output and terminal IDs with no open tab", () => {
    const original = layout();
    expect(markTerminalActivity(original, "terminal-1")).toBe(original);
    expect(markTerminalActivity(original, "unknown")).toBe(original);
  });
});
