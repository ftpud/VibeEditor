import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiContextSnapshot, AiSession } from "@remote-ide/protocol";
import { AiPanel } from "./AiPanel";
import { BlockRunDetails } from "./HarnessPanel";
import { ContextInspector } from "./ContextInspector";

afterEach(cleanup);
const context: AiContextSnapshot = {
  sections: [
    { id: "conversation", characters: 100, count: 1, entries: [] },
    { id: "files", characters: 400, count: 1, entries: [{ id: "file", label: "src/main.ts", characters: 400, preview: "export const captured = true;", timestamp: "2026-10-15T10:00:00Z" }] },
  ],
  history: [{ timestamp: "2026-10-15T10:00:00Z", used: 500, limit: 1000, characters: 2000 }, { timestamp: "2026-10-15T10:01:00Z", used: 200, limit: 1000, characters: 2200 }],
  compactions: 1,
};
const session: AiSession = { id: "one", model: "test", reasoning: "", status: "done", messages: [], context, contextUsed: 200, contextLimit: 1000 };
const callbacks = { onProviderChange: vi.fn(), onConfigurationChange: vi.fn(), onAttachmentsChange: vi.fn(), onSend: vi.fn(), onSteer: vi.fn(), onInterrupt: vi.fn(), onNewSession: vi.fn(), onSwitchSession: vi.fn(), onRemoveSession: vi.fn(), onResolvePermission: vi.fn() };

describe("context inspector", () => {
  it("opens under the AI header, inspects file bars, and closes when the session changes", () => {
    const props = { ...callbacks, provider: "test", providers: [], session, sessions: [session], models: [], attachments: [], permissionOwner: { provider: "test" } };
    const view = render(<AiPanel {...props} />);
    const toggle = screen.getByRole("button", { name: /Inspect context.*20%/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const inspector = screen.getByRole("region", { name: "Context inspector" });
    expect(inspector.previousElementSibling?.classList.contains("ai-toolbar")).toBe(true);
    expect(toggle.getAttribute("aria-controls")).toBe(inspector.id);
    fireEvent.click(screen.getByRole("button", { name: "Files & attachments: 400 captured characters" }));
    fireEvent.click(screen.getByText("src/main.ts"));
    expect(screen.getByText("export const captured = true;")).toBeTruthy();
    expect(screen.getByText(/last change -300 tokens/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Provider-reported context token usage history" })).toBeTruthy();
    view.rerender(<AiPanel {...props} session={{ ...session, id: "two" }} />);
    expect(screen.queryByRole("region", { name: "Context inspector" })).toBeNull();
  });

  it("offers the same clickable context pie in a working workflow Chatbox", () => {
    render(<BlockRunDetails block={{ id: "chat", type: "chatbox", label: "Chat", prompt: "", position: { x: 0, y: 0 } }} state={{ blockId: "chat", status: "running", context, contextUsed: 200, contextLimit: 1000 }} onClose={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /Inspect context.*20%/ });
    fireEvent.click(toggle);
    const inspector = screen.getByRole("region", { name: "Context inspector" });
    expect(inspector.previousElementSibling?.tagName).toBe("HEADER");
    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "Context inspector" })).toBeNull();
  });

  it("keeps unknown provider usage available for inspection without inventing totals", () => {
    render(<ContextInspector session={{}} id="unknown-context" />);
    expect(screen.getByText("Provider usage unavailable")).toBeTruthy();
    expect(screen.getByText(/Provider system prompt and hidden context are unavailable/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
