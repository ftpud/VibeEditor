import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiSession } from "@remote-ide/protocol";
import { AiPanel } from "./AiPanel";

afterEach(cleanup);

const session = (id: string, prompt: string): AiSession => ({ id, model: "test", reasoning: "low", status: "done", messages: [{ id: `${id}-message`, role: "user", text: prompt, timestamp: "2026-08-30T12:00:00.000Z" }] });

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
