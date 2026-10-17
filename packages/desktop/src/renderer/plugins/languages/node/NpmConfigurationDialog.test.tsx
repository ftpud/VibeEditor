import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreClient } from "../../../client";
import { NpmConfigurationDialog } from "./NpmConfigurationDialog";
afterEach(cleanup);
const options = { type: "npm", packageJsonPath: "web/package.json", packageManager: "npm", runConfigurations: [{ id: "dev", name: "Development", script: "dev", arguments: [], environment: {} }], selectedRunConfigurationId: "dev" };
function setup(running = false) {
  const revision = { size: 20, mtimeMs: 123, hash: "revision" };
  const request = vi.fn(async (type: string, payload?: Record<string, unknown>) => {
    if (type === "language.configuration.read") return { path: ".settings/npm.json", content: JSON.stringify(options), revision };
    if (type === "language.listRunTargets") return { targets: [{ id: "dev", name: "dev" }, { id: "test", name: "test" }] };
    if (type === "language.configuration.save") return { content: payload?.content, options: JSON.parse(payload?.content as string), revision };
    if (type === "language.tools.check") return { checks: [{ tool: "npm", executable: "npm", ok: true, message: "10.0.0" }] };
    return {};
  });
  const onSaved = vi.fn();
  render(<NpmConfigurationDialog client={{ request } as unknown as CoreClient} running={running} onClose={vi.fn()} onSaved={onSaved} />);
  return { request, revision, onSaved };
}
it("saves named script configurations, arguments, env and executable with revision protection", async () => {
  const { request, revision, onSaved } = setup();
  const name = await screen.findByLabelText("Configuration name");
  fireEvent.change(name, { target: { value: "Web development" } });
  fireEvent.change(screen.getByLabelText("Script arguments — one per line"), { target: { value: "--port\n3000\n--message=hello world" } });
  fireEvent.change(screen.getByLabelText("Node options — one per line"), { target: { value: "--enable-source-maps\n--max-old-space-size=4096" } });
  fireEvent.change(screen.getByLabelText("Working directory (optional)"), { target: { value: "web" } });
  fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
  fireEvent.change(screen.getByLabelText("Environment file (optional)"), { target: { value: "config/web.env" } });
  fireEvent.change(screen.getByLabelText("Environment variables — KEY=value"), { target: { value: "NODE_ENV=development\nNODE_OPTIONS=--max-old-space-size=4096\nMESSAGE=hello=world" } });
  fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
  fireEvent.change(screen.getByLabelText("Package manager"), { target: { value: "pnpm" } });
  fireEvent.change(screen.getByLabelText("Package manager executable (optional)"), { target: { value: "/opt/pnpm" } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const payload = request.mock.calls.find(([type]) => type === "language.configuration.save")![1]!;
  expect(payload.expectedRevision).toEqual(revision);
  expect(payload.language).toBe("node");
  expect(JSON.parse(payload.content as string)).toMatchObject({ packageManager: "pnpm", executable: "/opt/pnpm", runConfigurations: [{ name: "Web development", nodeOptions: ["--enable-source-maps", "--max-old-space-size=4096"], arguments: ["--port", "3000", "--message=hello world"], workingDirectory: "web", environmentFile: "config/web.env", environment: { NODE_ENV: "development", NODE_OPTIONS: "--max-old-space-size=4096", MESSAGE: "hello=world" } }] });
});
it("supports duplicating and deleting a configuration while preserving selection", async () => {
  const { request } = setup();
  await screen.findByLabelText("Configuration name");
  fireEvent.click(screen.getByTitle("Duplicate configuration"));
  expect(screen.getByLabelText("Configuration name")).toHaveProperty("value", "Development copy");
  fireEvent.click(screen.getByTitle("Delete configuration"));
  expect(screen.getByLabelText("Configuration name")).toHaveProperty("value", "Development");
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(request.mock.calls.some(([type]) => type === "language.configuration.save")).toBe(true));
  const payload = request.mock.calls.find(([type]) => type === "language.configuration.save")![1]!;
  expect(JSON.parse(payload.content as string).selectedRunConfigurationId).toBe("dev");
});
it("blocks malformed environment input instead of saving it", async () => {
  const { request } = setup();
  await screen.findByLabelText("Configuration name");
  fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
  fireEvent.change(screen.getByLabelText("Environment variables — KEY=value"), { target: { value: "not valid" } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  expect((await screen.findByRole("alert")).textContent).toContain("KEY=value");
  expect(request.mock.calls.some(([type]) => type === "language.configuration.save")).toBe(false);
});
it("preserves edits when Core reports a save conflict", async () => {
  const { request } = setup();
  await screen.findByLabelText("Configuration name");
  const original = request.getMockImplementation()!;
  request.mockImplementation((type, payload) => type === "language.configuration.save" ? Promise.reject(new Error("Configuration changed on disk")) : original(type, payload));
  fireEvent.change(screen.getByLabelText("Configuration name"), { target: { value: "Unsaved edits" } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  expect((await screen.findByRole("alert")).textContent).toContain("changed on disk");
  expect(screen.getByLabelText("Configuration name")).toHaveProperty("value", "Unsaved edits");
});
it("disables editing while the project is running", async () => {
  setup(true);
  await screen.findByLabelText("Configuration name");
  expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("status").textContent).toContain("Stop this project");
});
