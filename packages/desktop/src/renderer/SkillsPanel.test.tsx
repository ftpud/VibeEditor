import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "./SkillsPanel";
import { SkillChatChips, SkillChatControls as SkillChatPicker } from "./SkillChatControls";
import { skillAllowedForAgent } from "@remote-ide/protocol";
import type { SkillCatalog } from "@remote-ide/protocol";

afterEach(cleanup);
const catalog: SkillCatalog = {
  skills: [
    { id: "global/review", scope: "global", name: "review", title: "Reviewer", description: "Review changes", path: "/state/skills/global/review/SKILL.md" },
    { id: "local/style", scope: "local", name: "style", title: "Style", description: "Project conventions", path: "/project/.agents/skills/style/SKILL.md" }
  ],
  policy: { allowed: ["global/review", "local/style"], defaults: ["local/style"] }
};
const actions = () => ({ read: vi.fn(async () => "Review carefully"), write: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), policy: vi.fn(async () => undefined) });

describe("skills panel", () => {
  it("separates scopes and updates project defaults independently of chat selections", async () => {
    const handlers = actions(); const onSelection = vi.fn(async () => undefined);
    render(<SkillsPanel catalog={catalog} selected={[]} running onRefresh={vi.fn()} onSelection={onSelection} actions={handlers} />);
    expect(screen.getByText("Global")).toBeTruthy(); expect(screen.getByText("Local")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Settings for Reviewer"));
    expect(screen.getByText(/Changes apply to the next turn/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Use Reviewer by default"));
    await waitFor(() => expect(handlers.policy).toHaveBeenCalledWith({ allowed: catalog.policy.allowed, defaults: ["local/style", "global/review"] }));
    expect(onSelection).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByLabelText("Enable Reviewer") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Enable Reviewer"));
    await waitFor(() => expect(onSelection).toHaveBeenCalledWith(["global/review"]));
  });

  it("removing project availability also removes the default without changing existing chats", async () => {
    const handlers = actions();
    render(<SkillsPanel catalog={catalog} selected={["local/style"]} running={false} onRefresh={vi.fn()} onSelection={vi.fn()} actions={handlers} />);
    fireEvent.click(screen.getByTitle("Settings for Style"));
    fireEvent.click(screen.getByLabelText("Allow Style in project"));
    await waitFor(() => expect(handlers.policy).toHaveBeenCalledWith({ allowed: ["global/review"], defaults: [] }));
  });

  it("assigns skill access to specific agents or no agent and preserves it when defaults change", async () => {
    const handlers = actions();
    const preset = { scope: "workspace" as const, name: "reviewer.md" };
    const restricted = { ...catalog, policy: { ...catalog.policy, agents: { "global/review": [preset] } } };
    render(<SkillsPanel catalog={restricted} selected={[]} agentPreset={null} agents={[{ ...preset, agent: { name: "Code Reviewer", instructions: "Review" } }]} running={false} onRefresh={vi.fn()} onSelection={vi.fn()} actions={handlers} />);
    fireEvent.click(screen.getByTitle("Settings for Reviewer"));
    expect((screen.getByLabelText("Enable Reviewer") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("No agent for Reviewer"));
    await waitFor(() => expect(handlers.policy).toHaveBeenCalledWith({ ...restricted.policy, agents: { "global/review": [preset, null] } }));
    await waitFor(() => expect((screen.getByLabelText("Use Reviewer by default") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Use Reviewer by default"));
    await waitFor(() => expect(handlers.policy).toHaveBeenLastCalledWith({ ...restricted.policy, defaults: ["local/style", "global/review"] }));
  });

  it("creates and edits SKILL.md instructions through Core actions", async () => {
    const handlers = actions();
    render(<SkillsPanel catalog={catalog} selected={[]} running={false} onRefresh={vi.fn()} onSelection={vi.fn()} actions={handlers} />);
    fireEvent.click(screen.getByTitle("Create local skill"));
    fireEvent.change(screen.getByLabelText("Skill ID"), { target: { value: "local/testing" } });
    fireEvent.change(screen.getByLabelText("Skill instructions"), { target: { value: "Run focused tests" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(handlers.write).toHaveBeenCalledWith("local/testing", "Run focused tests"));
    await waitFor(() => expect(screen.queryByLabelText("Skill instructions")).toBeNull());
    fireEvent.click(screen.getByTitle("Edit Reviewer"));
    await waitFor(() => expect((screen.getByLabelText("Skill instructions") as HTMLTextAreaElement).value).toBe("Review carefully"));
  });
});

function SkillChatControls(props: React.ComponentProps<typeof SkillChatPicker>) {
  return <><SkillChatPicker {...props} /><SkillChatChips {...props} /></>;
}

describe("chat skills", () => {
  it("shows active chips and allows changing skills while a turn is running", async () => {
    const onChange = vi.fn(async () => undefined); const onOpen = vi.fn();
    render(<SkillChatControls skills={catalog.skills} selected={["local/style"]} running onChange={onChange} onOpen={onOpen} />);
    expect(screen.getByRole("group", { name: "Enabled chat skills" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skills · 1 active" }));
    expect(screen.getByText(/Applies next turn/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Enable Reviewer for chat"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(["local/style", "global/review"]));
    fireEvent.click(screen.getByText("Manage skills")); expect(onOpen).toHaveBeenCalledOnce();
    await waitFor(() => expect((screen.getByLabelText("Disable Style") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Disable Style"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([]));
  });

  it("hides inaccessible skills and their active chips as the selected agent changes", () => {
    const preset = { scope: "workspace" as const, name: "reviewer.md" };
    const policy = { ...catalog.policy, agents: { "global/review": [preset], "local/style": [null] } };
    const visible = (agent: typeof preset | null) => catalog.skills.filter((skill) => skillAllowedForAgent(policy, skill.id, agent));
    const { rerender } = render(<SkillChatControls skills={visible(preset)} selected={["global/review", "local/style"]} running={false} onChange={vi.fn()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Skills · 1 active" }));
    expect(screen.getByLabelText("Enable Reviewer for chat")).toBeTruthy();
    expect(screen.queryByLabelText("Enable Style for chat")).toBeNull();
    rerender(<SkillChatControls skills={visible(null)} selected={["global/review", "local/style"]} running={false} onChange={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByLabelText("Enable Reviewer for chat")).toBeNull();
    expect(screen.queryByLabelText("Disable Reviewer")).toBeNull();
    expect(screen.getByLabelText("Enable Style for chat")).toBeTruthy();
  });

  it("surfaces failed selection updates without displaying an optimistic active skill", async () => {
    render(<SkillChatControls skills={catalog.skills} selected={[]} running={false} onChange={async () => { throw new Error("Project disallowed this skill"); }} onOpen={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Enabled chat skills" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skills · 0 active" }));
    fireEvent.click(screen.getByLabelText("Enable Reviewer for chat"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Project disallowed this skill"));
    expect(screen.getByRole("button", { name: "Skills · 0 active" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Enabled chat skills" })).toBeNull();
  });
});
