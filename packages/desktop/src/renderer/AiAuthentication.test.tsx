import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AiAuthentication as Authentication } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { AiAuthentication, AuthenticationClientContext } from "./AiAuthentication";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("discovers advertised methods, opens a login link only on click, and confirms the active request", async () => {
  let authentication: Authentication = { status: "required", methods: [{ id: "browser", name: "Use browser", type: "agent" }] };
  const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    if (operation === "ai.auth.start") authentication = { ...authentication, status: "authenticating", requestId: "login-1", url: "https://example.com/login", awaitingConfirmation: true };
    if (operation === "ai.auth.input") authentication = { status: payload.action === "accept" ? "authenticated" : "required", methods: [] };
    return { authentication };
  });
  const openExternal = vi.fn(async () => {});
  vi.stubGlobal("desktop", { openExternal });
  const client = { getRoot: () => "workspace", request } as unknown as CoreClient;
  render(<AuthenticationClientContext.Provider value={client}><AiAuthentication provider="fixture" /></AuthenticationClientContext.Provider>);
  fireEvent.click(await screen.findByRole("button", { name: "Use browser" }));
  const link = await screen.findByRole("button", { name: "https://example.com/login" });
  expect(openExternal).not.toHaveBeenCalled();
  fireEvent.click(link);
  expect(openExternal).toHaveBeenCalledWith("https://example.com/login");
  fireEvent.click(screen.getByRole("button", { name: "Continue after signing in" }));
  await screen.findByText("Signed in");
  expect(request).toHaveBeenCalledWith("ai.auth.input", { provider: "fixture", requestId: "login-1", action: "accept" });
});
it("shows discovery failures and supports cancelling a pending sign-in", async () => {
  const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    if (payload.discover) throw new Error("Agent unavailable");
    return { authentication: operation === "ai.auth.input" ? { status: "required", methods: [] } : { status: "authenticating", methods: [], requestId: "pending" } };
  });
  const client = { getRoot: () => "workspace", request } as unknown as CoreClient;
  render(<AuthenticationClientContext.Provider value={client}><AiAuthentication provider="fixture" /></AuthenticationClientContext.Provider>);
  await screen.findByText("Signing in…");
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("ai.auth.input", { provider: "fixture", requestId: "pending", action: "cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Agent unavailable");
});
