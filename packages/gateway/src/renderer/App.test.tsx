import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, ConnectionDialog, DiagnosticsCopyButton, GatewayErrorNotice, RepositoryDialog, WorkspaceDialog, ProvisioningLog, gatewayErrorMessage } from "./App";

beforeEach(() => { Object.defineProperty(window, "alert", { configurable: true, writable: true, value: vi.fn() }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Gateway dialogs", () => {
  it("discovers remote workspaces on open and fills the form from a selection", async () => {
    window.gateway = { discoverWorkspaceDirectories: vi.fn().mockResolvedValue(["/home/dev/projects/api", "/home/dev/projects/configured"]) } as unknown as Window["gateway"];
    render(<WorkspaceDialog value={{ remotePort: 7331 }} connectionId="connection-1" discoverOnOpen configuredDirectories={["/home/dev/projects/configured"]} onClose={vi.fn()} onSave={vi.fn()} onFailure={vi.fn()} />);

    const discovered = await screen.findByRole("combobox", { name: "Discovered workspaces" });
    expect(window.gateway.discoverWorkspaceDirectories).toHaveBeenCalledWith("connection-1");
    expect(screen.queryByRole("option", { name: "/home/dev/projects/configured" })).toBeNull();
    fireEvent.change(discovered, { target: { value: "/home/dev/projects/api" } });
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("api");
    expect((screen.getByRole("textbox", { name: "Remote directory" }) as HTMLInputElement).value).toBe("/home/dev/projects/api");
  });

  it("names the modal, moves focus inside, closes with Escape, and restores focus", () => {
    const opener = document.body.appendChild(document.createElement("button"));
    opener.focus();
    const onClose = vi.fn();
    const view = render(<ConnectionDialog value={{ port: 22, authenticationMethod: "password", password: "", passphrase: "" }} onClose={onClose} onSave={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "New connection" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close New connection" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Connection type" }));

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps Tab focus within the dialog", () => {
    render(<ConnectionDialog value={{ port: 22, authenticationMethod: "password", password: "", passphrase: "" }} onClose={vi.fn()} onSave={vi.fn()} />);
    const first = screen.getByRole("button", { name: "Close New connection" });
    const last = screen.getByRole("button", { name: "Save connection" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("offers a local Mac connection without SSH fields", () => {
    render(<ConnectionDialog value={{ kind: "ssh", port: 22, authenticationMethod: "password", password: "", passphrase: "" }} onClose={vi.fn()} onSave={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Connection type" }), { target: { value: "local" } });
    expect(screen.getByText(/run Core and Vibe Editor directly on this Mac/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Host" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("chooses a local project directory and derives its name", async () => {
    window.gateway = { pickWorkspaceDirectory: vi.fn().mockResolvedValue("/Users/me/Projects/api") } as unknown as Window["gateway"];
    render(<WorkspaceDialog value={{ remotePort: 7331 }} connectionId="local-1" local onClose={vi.fn()} onSave={vi.fn()} onFailure={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose local project directory" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Local project directory" }) as HTMLInputElement).value).toBe("/Users/me/Projects/api"));
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("api");
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
    await screen.findByRole("heading", { name: "Project", level: 2 });

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


describe("Gateway workspace page", () => {
  it("keeps many workspaces and long provisioning output in separate named regions", async () => {
    const workspaces = Array.from({ length: 40 }, (_, index) => ({ id: `w${index}`, connectionId: "local", name: `Project ${index}`, directory: `/Projects/project-${index}`, remotePort: 7331 + index }));
    window.gateway = {
      get: vi.fn().mockResolvedValue({ state: { connections: [{ id: "local", kind: "local", name: "This Mac" }], workspaces, portTunnels: [] }, runtimes: { w0: { status: "working", message: "Installing", logs: ["FIRST OUTPUT", ...Array.from({ length: 1000 }, (_, index) => `line ${index}`)] }, w39: { status: "server", message: "Ready", logs: ["LAST OUTPUT"] } }, connectionRuntimes: {}, tunnelRuntimes: {} }),
      onStatus: vi.fn(() => () => undefined), onTunnelStatus: vi.fn(() => () => undefined), onConnectionStatus: vi.fn(() => () => undefined),
    } as unknown as Window["gateway"];
    const view = render(<App />);
    const list = await screen.findByRole("region", { name: "Workspaces" });
    expect(within(list).getAllByRole("article")).toHaveLength(40);
    expect(within(list).queryByText(/FIRST OUTPUT/)).toBeNull();
    expect(screen.getByRole("region", { name: "Provisioning output for Project 0" }).textContent).toContain("line 999");
    fireEvent.click(screen.getByRole("button", { name: "View provisioning log for Project 39" }));
    expect(screen.getByRole("region", { name: "Provisioning output for Project 39" }).textContent).toBe("LAST OUTPUT");
    expect(view.container.querySelector(".topbar")).toBeNull();
  });

  it.each([false, true])("accepts a manually entered missing workspace directory (local=%s)", async (local) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceDialog value={{ remotePort: 7331 }} connectionId="connection" local={local} onClose={vi.fn()} onSave={onSave} onFailure={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "New project" } });
    fireEvent.change(screen.getByRole("textbox", { name: local ? "Local project directory" : "Remote directory" }), { target: { value: "/new/parent/project" } });
    expect(screen.getByText(/Missing folders, including parent folders, are created when you save/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ directory: "/new/parent/project", name: "New project" })));
  });

  it("preserves the reader's scroll position when new log lines arrive", () => {
    const workspace = { id: "w", connectionId: "c", name: "Project", directory: "/project", remotePort: 7331 };
    const runtime = { status: "working" as const, message: "Installing", logs: ["first"] };
    const view = render(<ProvisioningLog workspace={workspace} workspaces={[workspace]} runtime={runtime} onSelect={vi.fn()} />);
    const output = screen.getByRole("region", { name: "Provisioning output for Project" });
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(output, "clientHeight", { configurable: true, value: 200 });
    output.scrollTop = 100;
    fireEvent.scroll(output);
    view.rerender(<ProvisioningLog workspace={workspace} workspaces={[workspace]} runtime={{ ...runtime, logs: ["first", "second"] }} onSelect={vi.fn()} />);
    expect(output.scrollTop).toBe(100);
    output.scrollTop = 800;
    fireEvent.scroll(output);
    view.rerender(<ProvisioningLog workspace={workspace} workspaces={[workspace]} runtime={{ ...runtime, logs: ["first", "second", "third"] }} onSelect={vi.fn()} />);
    expect(output.scrollTop).toBe(1000);
  });
});
