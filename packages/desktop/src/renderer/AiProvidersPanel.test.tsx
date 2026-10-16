import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AiProviderInstallation } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { AiProvidersPanel } from "./AiProvidersPanel";
import { AuthenticationClientContext } from "./AiAuthentication";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const base = (provider: string, name: string): AiProviderInstallation => ({ provider, name, description: `${name} agent`, package: `@vendor/${provider}`, status: "not_installed" });

it("installs, updates and deletes providers, refreshes the app when a change finishes and checks installed accounts", async () => {
  let installations: AiProviderInstallation[] = [
    { ...base("codex", "Codex ACP"), status: "installed", source: "managed", version: "1.0.0", latestVersion: "1.1.0" },
    base("claude", "Claude ACP"),
    { ...base("copilot", "Copilot ACP"), status: "installed", source: "external", location: "/usr/bin/copilot" }
  ];
  const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    if (operation === "ai.installations.list") return { installations };
    if (operation === "ai.installations.install" || operation === "ai.installations.uninstall") {
      installations = installations.map((item) => item.provider === payload.provider ? { ...item, status: operation.endsWith("uninstall") ? "removing" : "installing" } : item);
      return { installation: installations.find((item) => item.provider === payload.provider) };
    }
    if (operation === "ai.auth.get") return { authentication: payload.provider === "codex" ? { status: "authenticated", methods: [] } : { status: "required", methods: [{ id: "login", name: "Log in", type: "agent" }] } };
    throw new Error(`Unexpected ${operation}`);
  });
  const client = { getRoot: () => "workspace", request } as unknown as CoreClient;
  const onChanged = vi.fn();
  render(<AuthenticationClientContext.Provider value={client}><AiProvidersPanel client={client} onClose={vi.fn()} onChanged={onChanged} /></AuthenticationClientContext.Provider>);

  const codex = await screen.findByRole("article", { name: "Codex ACP" });
  expect(within(codex).getByText("Update available")).toBeTruthy();
  await within(codex).findByText("Signed in");
  expect(request).toHaveBeenCalledWith("ai.auth.get", { provider: "codex", discover: true }, { timeoutMs: 210000 });
  const copilot = screen.getByRole("article", { name: "Copilot ACP" });
  expect(within(copilot).queryByRole("button", { name: /Delete/ })).toBeNull();
  expect(within(copilot).getByText("/usr/bin/copilot")).toBeTruthy();
  await within(copilot).findByText("Sign in to continue");

  const claude = screen.getByRole("article", { name: "Claude ACP" });
  expect(within(claude).queryByText("Account")).toBeNull();
  fireEvent.click(within(claude).getByRole("button", { name: /Install/ }));
  await within(claude).findByText("Installing…");
  installations = installations.map((item) => item.provider === "claude" ? { ...item, status: "installed", source: "managed", version: "2.0.0" } : item);
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce(), { timeout: 4000 });
  await within(claude).findByText("Installed");

  fireEvent.click(within(codex).getByRole("button", { name: /Delete/ }));
  const confirm = within(codex).getByRole("alertdialog");
  fireEvent.click(within(confirm).getByRole("button", { name: /Delete/ }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("ai.installations.uninstall", { provider: "codex" }));
  await within(codex).findByText("Deleting…");
});

it("reports installation errors from Core", async () => {
  const request = vi.fn(async (operation: string) => {
    if (operation === "ai.installations.list") return { installations: [{ ...base("codex", "Codex ACP"), error: "Could not install @vendor/codex: offline" }] };
    throw new Error("Another installation change is already running for this provider");
  });
  const client = { getRoot: () => "workspace", request } as unknown as CoreClient;
  render(<AiProvidersPanel client={client} onClose={vi.fn()} onChanged={vi.fn()} />);
  expect((await screen.findByText(/offline/)).textContent).toContain("Could not install");
  fireEvent.click(screen.getByRole("button", { name: /Install/ }));
  expect(await screen.findByText(/already running/)).toBeTruthy();
});
