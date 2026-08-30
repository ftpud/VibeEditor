import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiSession } from "@remote-ide/protocol";
import { AiPanel, ContextUsageIndicator, contextUsage } from "./AiPanel";

afterEach(cleanup);

const session = (id: string, prompt: string): AiSession => ({ id, model: "test", reasoning: "low", status: "done", messages: [{ id: `${id}-message`, role: "user", text: prompt, timestamp: "2026-08-30T12:00:00.000Z" }] });

describe("context usage indicator", () => {
  it("calculates and clamps the active session percentage", () => {
    expect(contextUsage({ ...session("one", "First"), contextUsed: 250, contextLimit: 1_000 })).toEqual({ used: 250, limit: 1_000, percent: 25 });
    expect(contextUsage({ ...session("one", "First"), contextUsed: 1_500, contextLimit: 1_000 })?.percent).toBe(100);
  });

  it("hides when the provider has not reported a usable context window", () => {
    const { container } = render(<ContextUsageIndicator session={session("one", "First")} />);
    expect(container.firstChild).toBeNull();
    expect(contextUsage({ ...session("one", "First"), contextUsed: 10, contextLimit: 0 })).toBeUndefined();
  });

  it("updates accessible context output when the active session changes", () => {
    const first = { ...session("one", "First"), contextUsed: 250, contextLimit: 1_000 };
    const second = { ...session("two", "Second"), contextUsed: 950, contextLimit: 1_000 };
    const { rerender } = render(<ContextUsageIndicator session={first} />);
    expect(screen.getByRole("img", { name: "Context window: 25% used (250 of 1,000 tokens)" }).getAttribute("title")).toBe("Context window: 25% used (250 of 1,000 tokens)");
    rerender(<ContextUsageIndicator session={second} />);
    expect(screen.getByRole("img", { name: "Context window: 95% used (950 of 1,000 tokens)" }).className).toContain("near-full");
  });
});

describe("timed task session controls", () => {
  it("disables new, switch, and remove while a continuation timer owns the session", () => {
    const sessions = [session("one", "First conversation"), session("two", "Second conversation")];
    const { container } = render(<AiPanel provider="codex" providers={[]} session={sessions[0]!} sessions={sessions} models={[]} attachments={[]} permissionOwner={{ provider: "codex", taskId: "task-a" }} sessionChangesDisabled onProviderChange={vi.fn()} onConfigurationChange={vi.fn()} onAttachmentsChange={vi.fn()} onSend={vi.fn()} onSteer={vi.fn()} onInterrupt={vi.fn()} onNewSession={vi.fn()} onSwitchSession={vi.fn()} onRemoveSession={vi.fn()} onResolvePermission={vi.fn()} />);

    fireEvent.click(screen.getByTitle("Manage sessions"));
    expect((screen.getByRole("button", { name: "New" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /First conversation/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Second conversation/ }) as HTMLButtonElement).disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>(".ai-session-remove")].every((button) => button.disabled)).toBe(true);
  });
});

describe("response provenance", () => {
  it("shows the effective response model next to the provider name", () => {
    const conversation: AiSession = { id: "one", model: "model-b", reasoning: "high", status: "done", messages: [{ id: "answer", role: "assistant", text: "Done", model: "model-a", reasoning: "low", timestamp: "2026-08-30T12:00:00.000Z" }] };
    render(<AiPanel provider="codex" providers={[{ id: "codex", name: "Codex", description: "", settings: { title: "", description: "", sections: [] }, options: [], capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true } }]} session={conversation} sessions={[conversation]} models={[{ id: "model-a", name: "Model A", defaultReasoning: "low", reasoningLevels: ["low"] }]} attachments={[]} permissionOwner={{ provider: "codex" }} onProviderChange={vi.fn()} onConfigurationChange={vi.fn()} onAttachmentsChange={vi.fn()} onSend={vi.fn()} onSteer={vi.fn()} onInterrupt={vi.fn()} onNewSession={vi.fn()} onSwitchSession={vi.fn()} onRemoveSession={vi.fn()} onResolvePermission={vi.fn()} />);
    expect(screen.getByText("Codex · Model A")).toBeTruthy();
  });

  it("labels automated prompts with their sender model and always labels responses with their effective model", () => {
    const conversation: AiSession = { id: "one", model: "model-b", reasoning: "high", status: "done", messages: [
      { id: "prompt", role: "user", text: "Continue", senderModel: "model-a", timestamp: "2026-08-30T12:00:00.000Z" },
      { id: "answer", role: "assistant", text: "Done", timestamp: "2026-08-30T12:00:01.000Z" }
    ] };
    render(<AiPanel provider="codex" providers={[{ id: "codex", name: "Codex", description: "", settings: { title: "", description: "", sections: [] }, options: [], capabilities: { models: true, usage: true, mcp: true, agents: true, contextWindow: true } }]} session={conversation} sessions={[conversation]} models={[{ id: "model-a", name: "Model A", defaultReasoning: "low", reasoningLevels: ["low"] }, { id: "model-b", name: "Model B", defaultReasoning: "high", reasoningLevels: ["high"] }]} attachments={[]} permissionOwner={{ provider: "codex" }} onProviderChange={vi.fn()} onConfigurationChange={vi.fn()} onAttachmentsChange={vi.fn()} onSend={vi.fn()} onSteer={vi.fn()} onInterrupt={vi.fn()} onNewSession={vi.fn()} onSwitchSession={vi.fn()} onRemoveSession={vi.fn()} onResolvePermission={vi.fn()} />);
    expect(screen.getByText("Model A")).toBeTruthy();
    expect(screen.getByText("Codex · Model B")).toBeTruthy();
  });
});

describe("activity terminal links", () => {
  it("opens an activity terminal by its opaque reference and disables a stale link", async () => {
    const onOpenTerminal = vi.fn().mockResolvedValue(false);
    const conversation: AiSession = { id: "one", model: "model-a", reasoning: "low", status: "done", messages: [{ id: "tool", role: "activity", text: "Run build", terminalId: "terminal-1", timestamp: "2026-08-30T12:00:00.000Z" }] };
    render(<AiPanel provider="codex" providers={[]} session={conversation} sessions={[conversation]} models={[]} attachments={[]} permissionOwner={{ provider: "codex" }} onProviderChange={vi.fn()} onConfigurationChange={vi.fn()} onAttachmentsChange={vi.fn()} onSend={vi.fn()} onSteer={vi.fn()} onInterrupt={vi.fn()} onNewSession={vi.fn()} onSwitchSession={vi.fn()} onRemoveSession={vi.fn()} onResolvePermission={vi.fn()} onOpenTerminal={onOpenTerminal} />);
    fireEvent.click(screen.getByTitle("Open this activity's terminal"));
    await vi.waitFor(() => expect(onOpenTerminal).toHaveBeenCalledWith("terminal-1"));
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "Terminal unavailable" }) as HTMLButtonElement).disabled).toBe(true));
  });
});
