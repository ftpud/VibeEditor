import { describe, expect, it } from "vitest";
import { withAppTools } from "./server.js";

describe("built-in app tool access", () => {
  it("does not grant tools without an explicit agent allowlist entry", () => {
    expect(withAppTools("/workspace", "/workspace").servers).toEqual([]);
    expect(withAppTools("/workspace", "/workspace/task", [], { name: "No tools", instructions: "", mcpServers: [] }).servers).toEqual([]);
  });

  it("adds the Vibe Editor server when explicitly allowed", () => {
    const result = withAppTools("/workspace", "/workspace/task", [], { name: "Coordinator", instructions: "", mcpServers: ["vibe-editor"] });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({ name: "vibe-editor", transport: "stdio", env: { VIBE_EDITOR_ROOT_WORKSPACE: "/workspace", VIBE_EDITOR_CURRENT_WORKSPACE: "/workspace/task" } });
    expect(result.agent?.mcpServers).toEqual(["vibe-editor"]);
  });
});
