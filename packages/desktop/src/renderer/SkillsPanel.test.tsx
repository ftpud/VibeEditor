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
    { id: "local/style", scope: "local", name: "style", title: "Style", description: "Project conventions", path: "/state/skills/local/project-hash/style/SKILL.md" }
  ],
  policy: { allowed: ["global/review", "local/style"], defaults: ["local/style"] }
};
const actions = () => ({ write: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), policy: vi.fn(async () => undefined) });

describe("skills panel", () => {
  it("separates scopes and updates project defaults independently of chat selections", async () => {
    const handlers = actions(); const onSelection = vi.fn(async () => undefined);
    render(<SkillsPanel catalog={catalog} selected={[]} running onRefresh={vi.fn()} onSelection={onSelection} onOpen={vi.fn()} actions={handlers} />);
    expect(screen.getByText("Global")).toBeTruthy(); expect(screen.getByText("Local")).toBeTruthy(); expect(screen.getByText("Workspace")).toBeTruthy();
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
    render(<SkillsPanel catalog={catalog} selected={["local/style"]} running={false} onRefresh={vi.fn()} onSelection={vi.fn()} onOpen={vi.fn()} actions={handlers} />);
    fireEvent.click(screen.getByTitle("Settings for Style"));
    fireEvent.click(screen.getByLabelText("Allow Style in project"));
    await waitFor(() => expect(handlers.policy).toHaveBeenCalledWith({ allowed: ["global/review"], defaults: [] }));
  });

  it("assigns skill access to specific agents or no agent and preserves it when defaults change", async () => {
    const handlers = actions();
    const preset = { scope: "workspace" as const, name: "reviewer.md" };
    const restricted = { ...catalog, policy: { ...catalog.policy, agents: { "global/review": [preset] } } };
    render(<SkillsPanel catalog={restricted} selected={[]} agentPreset={null} agents={[{ ...preset, agent: { name: "Code Reviewer", instructions: "Review" } }]} running={false} onRefresh={vi.fn()} onSelection={vi.fn()} onOpen={vi.fn()} actions={handlers} />);
    fireEvent.click(screen.getByTitle("Settings for Reviewer"));
    expect((screen.getByLabelText("Enable Reviewer") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("No agent for Reviewer"));
    await waitFor(() => expect(handlers.policy).toHaveBeenCalledWith({ ...restricted.policy, agents: { "global/review": [preset, null] } }));
    await waitFor(() => expect((screen.getByLabelText("Use Reviewer by default") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText("Use Reviewer by default"));
    await waitFor(() => expect(handlers.policy).toHaveBeenLastCalledWith({ ...restricted.policy, defaults: ["local/style", "global/review"] }));
  });

  it("opens skills in the shared editor and creates a template before opening edit mode", async () => {
    const handlers = actions();
    const onOpen = vi.fn(async () => undefined);
    render(<SkillsPanel catalog={catalog} selected={[]} running={false} onRefresh={vi.fn()} onSelection={vi.fn()} onOpen={onOpen} actions={handlers} />);
    fireEvent.click(screen.getByTitle("Review changes"));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("global/review", "preview"));
    await waitFor(() => expect((screen.getByTitle("Edit Reviewer") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTitle("Edit Reviewer"));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("global/review", "edit"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect((screen.getByTitle("Create local skill") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTitle("Create local skill"));
    fireEvent.change(screen.getByLabelText("Skill ID"), { target: { value: "local/testing" } });
    expect(screen.queryByLabelText("Skill instructions")).toBeNull();
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(handlers.write).toHaveBeenCalledWith("local/testing", expect.stringContaining("name: New Skill")));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("local/testing", "edit"));
    expect(handlers.write.mock.invocationCallOrder[0]).toBeLessThan(onOpen.mock.invocationCallOrder[2]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
