import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolInstallation } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { ToolsPanel } from "./ToolsPanel";

afterEach(() => cleanup());
it("downloads the Java tools with progress, offers updates and deletes them", async () => {
  let tools: ToolInstallation[] = [
    { id: "java", name: "Java runtime", description: "JRE", status: "installed", version: "21.0.7", availableVersion: "21.0.8" },
    { id: "jdtls", name: "Java language server", description: "JDT LS", status: "not_installed", availableVersion: "1.61", requires: ["java"] }
  ];
  const request = vi.fn(async (operation: string, payload: { tool?: string }) => {
    if (operation === "tools.install") tools = tools.map((tool) => tool.id === payload.tool ? { ...tool, status: "installing", progress: 42 } : tool);
    if (operation === "tools.uninstall") tools = tools.map((tool) => tool.id === payload.tool ? { ...tool, status: "removing" } : tool);
    return { tools };
  });
  render(<ToolsPanel client={{ request } as unknown as CoreClient} onClose={vi.fn()} />);
  const java = await screen.findByRole("article", { name: "Java runtime" });
  expect(within(java).getByText("Update available")).toBeTruthy();
  const server = screen.getByRole("article", { name: "Java language server" });
  expect(within(server).getByText("Requires Java runtime")).toBeTruthy();
  fireEvent.click(within(server).getByRole("button", { name: /Install/ }));
  await within(server).findByText("Downloading 42%");
  tools = tools.map((tool) => tool.id === "jdtls" ? { ...tool, status: "installed", version: "1.61", progress: undefined } : tool);
  await within(server).findByText("Installed", {}, { timeout: 3000 });
  fireEvent.click(within(java).getByRole("button", { name: /Delete/ }));
  fireEvent.click(within(within(java).getByRole("alertdialog")).getByRole("button", { name: /Delete/ }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("tools.uninstall", { tool: "java" }));
});
