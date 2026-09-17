import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { ModalFocusManager } from "./accessibility";

afterEach(cleanup);

function Fixture() {
  const [open, setOpen] = useState(false);
  return <><ModalFocusManager /><button onClick={() => setOpen(true)}>Open</button>{open && <section role="dialog" aria-modal="true" aria-label="Example"><button>First</button><button onClick={() => setOpen(false)}>Close</button></section>}</>;
}

describe("ModalFocusManager", () => {
  it("moves focus into a modal, contains Tab, and restores its invoker", async () => {
    render(<Fixture />);
    const invoker = screen.getByRole("button", { name: "Open" });
    invoker.focus(); fireEvent.click(invoker);
    const first = screen.getByRole("button", { name: "First" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(invoker));
  });
});
