import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATE, AgentsStore, parseAgent } from "./agents.js";

describe("AgentsStore", () => {
  it("creates templated global and local agents and discovers workspace agents", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "remote-ide-agents-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-agents-state-"));
    await mkdir(path.join(workspace, ".agents"));
    await writeFile(path.join(workspace, ".agents", "reviewer.md"), "---\nname: Code Reviewer\ndescription: Reviews changes\n---\n\nReview carefully.\n");
    const store = new AgentsStore(workspace, state);

    await store.create("global", "planner", workspace);
    await store.create("local", "tester.md", workspace);
    const agents = await store.list(workspace);

    expect(agents.map((agent) => `${agent.scope}:${agent.name}`)).toEqual(["global:planner.md", "local:tester.md", "workspace:reviewer.md"]);
    expect(agents.find((agent) => agent.scope === "workspace")?.agent).toEqual({ name: "Code Reviewer", description: "Reviews changes", instructions: "Review carefully." });
    expect(await store.read("global", "planner.md", workspace)).toBe(AGENT_TEMPLATE);
  });

  it("parses MCP restrictions and falls back to the file name", () => {
    expect(parseAgent("security-review.md", "---\nmcpServers:\n  - github\n  - 'docs'\n---\nCheck security.")).toEqual({ name: "Security Review", instructions: "Check security.", mcpServers: ["github", "docs"] });
  });

  it("renames and updates managed agents", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "remote-ide-agents-workspace-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-agents-state-"));
    const store = new AgentsStore(workspace, state);
    await store.create("local", "old", workspace);
    await store.write("local", "old.md", "Instructions", workspace);
    expect(await store.rename("local", "old.md", "new", workspace)).toBe("new.md");
    expect(await store.read("local", "new.md", workspace)).toBe("Instructions");
  });
});
