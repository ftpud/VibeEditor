import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, ConnectionDialog, DiagnosticsCopyButton, GatewayErrorNotice, RepositoryDialog, gatewayErrorMessage } from "./App";

afterEach(cleanup);

describe("Gateway dialogs", () => {
  it("names the modal, moves focus inside, closes with Escape, and restores focus", () => {
    const opener = document.body.appendChild(document.createElement("button"));
    opener.focus();
    const onClose = vi.fn();
    const view = render(<ConnectionDialog value={{ port: 22, authenticationMethod: "password", password: "", passphrase: "" }} onClose={onClose} onSave={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "New SSH connection" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close New SSH connection" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps Tab focus within the dialog", () => {
    render(<ConnectionDialog value={{ port: 22, authenticationMethod: "password", password: "", passphrase: "" }} onClose={vi.fn()} onSave={vi.fn()} />);
    const first = screen.getByRole("button", { name: "Close New SSH connection" });
    const last = screen.getByRole("button", { name: "Save connection" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("connection diagnostics", () => {
  it("copies without blocking and announces success", async () => {
    let finish!: () => void;
    const onCopy = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<DiagnosticsCopyButton onCopy={onCopy} onFailure={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Copy connection diagnostics" });
    fireEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Copying connection diagnostics");
    finish();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Connection diagnostics copied"));
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("announces and exposes copy failures", async () => {
    const onFailure = vi.fn();
    render(<DiagnosticsCopyButton onCopy={() => Promise.reject(new Error("clipboard unavailable"))} onFailure={onFailure} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy connection diagnostics" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Connection diagnostics could not be copied"));
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "clipboard unavailable" }));
  });
});

describe("Gateway error presentation", () => {
  it("bounds and redacts unexpected error text", () => {
    const message = gatewayErrorMessage(new Error(`Error invoking remote method 'gateway:test': Error: password=hunter2 token:abc ${"x".repeat(400)}`));
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("abc");
    expect(message).toContain("password=[redacted]");
    expect(message.length).toBeLessThanOrEqual(320);
  });

  it("renders an assertive, atomic, dismissible floating notice", () => {
    const onDismiss = vi.fn();
    render(<GatewayErrorNotice message="Connection failed" onDismiss={onDismiss} />);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("routes connection and settings failures out of modal content", async () => {
    const connectionFailure = vi.fn();
    render(<ConnectionDialog value={{ name: "Host", host: "example.test", username: "me", port: 22, authenticationMethod: "password", password: "secret", passphrase: "" }} onClose={vi.fn()} onSave={vi.fn()} onFailure={connectionFailure} />);
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(connectionFailure).toHaveBeenCalled());
    expect(screen.queryByText(/failed/i)).toBeNull();
    cleanup();

    const settingsFailure = vi.fn();
    render(<RepositoryDialog value={{ repository: "https://example.test/repo.git", branch: "dev", autoUpdate: true }} onClose={vi.fn()} onSave={() => Promise.reject(new Error("settings failed"))} onFailure={settingsFailure} />);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(settingsFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "settings failed" })));
    expect(screen.queryByText("settings failed")).toBeNull();
  });

  it("surfaces provisioning, diagnostics, and unexpected failures without browser dialogs", async () => {
    const state = {
      connections: [{ id: "connection-1", name: "Server", host: "example.test", port: 22, username: "me", authenticationMethod: "agent" as const }],
      workspaces: [{ id: "workspace-1", connectionId: "connection-1", name: "Project", directory: "/srv/project", remotePort: 7331 }],
      portTunnels: [],
    };
    const gateway = {
      get: vi.fn().mockResolvedValue({ state, repository: { repository: "https://example.test/repo.git", branch: "dev", autoUpdate: true }, runtimes: {}, tunnelRuntimes: {}, connectionRuntimes: {} }),
      startServer: vi.fn().mockRejectedValue(new Error("provisioning password=hidden failed")),
      copyDiagnostics: vi.fn().mockRejectedValue(new Error("clipboard failed")),
      onStatus: vi.fn(() => () => undefined), onTunnelStatus: vi.fn(() => () => undefined), onConnectionStatus: vi.fn(() => () => undefined),
    } as unknown as Window["gateway"];
    window.gateway = gateway;
    const alertSpy = vi.spyOn(window, "alert");
    render(<App />);
    await screen.findByText("Project");

    fireEvent.click(screen.getByRole("button", { name: /Start server/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("provisioning password=[redacted] failed"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

    fireEvent.click(screen.getByRole("button", { name: "Copy connection diagnostics" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not copy diagnostics: clipboard failed"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));

    const unexpected = new Event("unhandledrejection", { cancelable: true }) as PromiseRejectionEvent;
    Object.defineProperty(unexpected, "reason", { value: new Error("render loop failed") });
    window.dispatchEvent(unexpected);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unexpected Gateway error: render loop failed"));
    expect(unexpected.defaultPrevented).toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
