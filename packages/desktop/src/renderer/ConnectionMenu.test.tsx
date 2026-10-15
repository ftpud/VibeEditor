import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionMenu } from "./ConnectionMenu";
afterEach(cleanup);
it("keeps address and disconnect within connection details", () => {
  const disconnect = vi.fn();
  render(<ConnectionMenu host="127.0.0.1" port="7331" connected onDisconnect={disconnect} />);
  expect(screen.queryByText("127.0.0.1:7331")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Core connection" }));
  expect(screen.getByText("127.0.0.1:7331")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(disconnect).toHaveBeenCalledOnce();
});
it("closes on Escape and returns focus to its control", () => {
  render(<ConnectionMenu host="server" port="7331" connected={false} onDisconnect={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Core connection" });
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
