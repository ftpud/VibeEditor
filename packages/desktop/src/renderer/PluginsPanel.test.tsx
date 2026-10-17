import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreClient } from "./client";
import { PluginsPanel } from "./PluginsPanel";

afterEach(cleanup);
const client = (result: unknown) => ({ request: vi.fn(async () => result) }) as unknown as CoreClient;

it("lists loaded and failed plugins with their contributions", async () => {
  render(<PluginsPanel client={client({ enabled: true, plugins: [
    { id: "demo", name: "Demo", version: "1.0.0", state: "loaded", providers: ["acme"], languages: ["demo-lang"] },
    { id: "broken", state: "failed", error: "boom", providers: [], languages: [] }
  ] })} onClose={vi.fn()} />);
  expect((await screen.findByRole("article", { name: "Demo" })).textContent).toContain("Providers: acme");
  expect(screen.getByRole("article", { name: "broken" }).textContent).toContain("boom");
});

it("explains that plugins are opt-in on the Core host", async () => {
  render(<PluginsPanel client={client({ enabled: false, plugins: [] })} onClose={vi.fn()} />);
  expect(await screen.findByText("Plugins are not enabled on this Core host.")).toBeTruthy();
});
