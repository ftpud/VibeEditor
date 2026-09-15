import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiSession } from "@remote-ide/protocol";
import { AiPanel, ContextUsageIndicator, contextUsage, resolveAiLink } from "./AiPanel";

afterEach(cleanup);

const session = (id: string, prompt: string): AiSession => ({ id, model: "test", reasoning: "low", status: "done", messages: [{ id: `${id}-message`, role: "user", text: prompt, timestamp: "2026-08-30T12:00:00.000Z" }] });

describe("chat links", () => {
  it("resolves workspace files with line locations and rejects paths outside the workspace", () => {
    expect(resolveAiLink("/work/project/src/App.tsx:42:7", "/work/project")).toEqual({ type: "file", path: "src/App.tsx", line: 42, column: 7 });
    expect(resolveAiLink("packages/core/src/server.ts:10", "/work/project")).toEqual({ type: "file", path: "packages/core/src/server.ts", line: 10 });
    expect(resolveAiLink("README.md:5", "/work/project")).toEqual({ type: "file", path: "README.md", line: 5 });
    expect(resolveAiLink("/work/other/secret.txt:1", "/work/project")).toEqual({ type: "unsupported" });
  });

  it("prevents renderer navigation and routes file and web links", () => {
    const onOpenFile = vi.fn();
    const onOpenExternal = vi.fn();
    const conversation: AiSession = { id: "one", model: "test", reasoning: "low", status: "done", messages: [{ id: "answer", role: "assistant", text: "[Source](/work/project/src/App.tsx:42) [Docs](https://example.com/)", timestamp: "2026-08-30T12:00:00.000Z" }] };
    render(<AiPanel provider="codex" providers={[]} session={conversation} sessions={[conversation]} models={[]} attachments={[]} workspacePath="/work/project" permissionOwner={{ provider: "codex" }} onProviderChange={vi.fn()} onConfigurationChange={vi.fn()} onAttachmentsChange={vi.fn()} onSend={vi.fn()} onSteer={vi.fn()} onInterrupt={vi.fn()} onNewSession={vi.fn()} onSwitchSession={vi.fn()} onRemoveSession={vi.fn()} onResolvePermission={vi.fn()} onOpenFile={onOpenFile} onOpenExternal={onOpenExternal} />);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "Source" }).dispatchEvent(click);
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    expect(click.defaultPrevented).toBe(true);
    expect(onOpenFile).toHaveBeenCalledWith("src/App.tsx", 42, undefined);
    expect(onOpenExternal).toHaveBeenCalledWith("https://example.com/");
  });
});

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
