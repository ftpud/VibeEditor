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

it("switches a provider between ACP v1 and the experimental v2 and explains preview channels", async () => {
  let codex: AiProviderInstallation = { ...base("codex", "Codex ACP"), status: "installed", source: "managed", version: "2.2.2", protocol: "v1", protocols: ["v1", "v2"] };
  const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    if (operation === "ai.installations.list") return { installations: [codex, base("copilot", "Copilot ACP")] };
    if (operation === "ai.installations.setProtocol") { codex = { ...codex, protocol: payload.protocol as "v1" | "v2", channel: payload.protocol === "v2" ? "preview" : undefined, latestVersion: payload.protocol === "v2" ? "2.2.3-preview.14" : "2.2.2" }; return { installation: codex }; }
    if (operation === "ai.auth.get") return { authentication: { status: "authenticated", methods: [] } };
    throw new Error(operation);
  });
  const client = { getRoot: () => "workspace", request } as unknown as CoreClient;
  render(<AuthenticationClientContext.Provider value={client}><AiProvidersPanel client={client} onClose={vi.fn()} onChanged={vi.fn()} /></AuthenticationClientContext.Provider>);
  const card = await screen.findByRole("article", { name: "Codex ACP" });
  expect(within(screen.getByRole("article", { name: "Copilot ACP" })).queryByRole("group", { name: /ACP protocol/ })).toBeNull();
  fireEvent.click(within(within(card).getByRole("group", { name: "Codex ACP ACP protocol" })).getByRole("button", { name: "ACP v2 · experimental" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("ai.installations.setProtocol", { provider: "codex", protocol: "v2" }));
  expect((await within(card).findByText(/ships ACP v2 in preview builds/)).textContent).toContain("Update installs 2.2.3-preview.14");
  expect(within(card).getByRole("button", { name: "ACP v2 · experimental" }).getAttribute("aria-pressed")).toBe("true");
});

it("warns when an API key overrides the subscription and switches Claude to its own sign-in", async () => {
  let claude: AiProviderInstallation = { ...base("claude", "Claude ACP"), status: "installed", source: "managed", version: "0.93.0", credentials: "environment", credentialVariables: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], credentialVariablesSet: ["ANTHROPIC_API_KEY"] };
  const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    if (operation === "ai.installations.list") return { installations: [claude] };
    if (operation === "ai.installations.setCredentials") { claude = { ...claude, credentials: payload.credentials as "login" }; return { installation: claude }; }
    if (operation === "ai.auth.get") return { authentication: { status: "authenticated", methods: [] } };
    throw new Error(operation);
  });
  const client = { getRoot: () => "workspace", request } as unknown as CoreClient;
  render(<AuthenticationClientContext.Provider value={client}><AiProvidersPanel client={client} onClose={vi.fn()} onChanged={vi.fn()} /></AuthenticationClientContext.Provider>);
  const card = await screen.findByRole("article", { name: "Claude ACP" });
  expect(within(card).getByText(/ANTHROPIC_API_KEY is set on the Core host/).textContent).toContain("instead of your subscription");
  const checks = () => request.mock.calls.filter(([operation, payload]) => operation === "ai.auth.get" && (payload as { discover?: boolean }).discover).length;
  await waitFor(() => expect(checks()).toBe(1));
  fireEvent.click(within(card).getByRole("button", { name: "Subscription login" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("ai.installations.setCredentials", { provider: "claude", credentials: "login" }));
  expect((await within(card).findByText(/uses its own sign-in/)).textContent).toContain("ANTHROPIC_API_KEY on the Core host is ignored");
  // The account is checked again with the new credentials.
  await waitFor(() => expect(checks()).toBe(2));
});
