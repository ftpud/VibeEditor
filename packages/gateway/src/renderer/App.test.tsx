import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionDialog } from "./App";

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
