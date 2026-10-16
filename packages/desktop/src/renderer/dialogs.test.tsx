import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DialogHost, gitRefNameError, requestConfirm, requestFields, requestText } from "./dialogs";

afterEach(cleanup);
it("collects validated text, supports cancel, choices and confirmation", async () => {
  render(<DialogHost />);
  let name!: Promise<string | undefined>;
  act(() => { name = requestText({ title: "Create branch", label: "Branch name", validate: gitRefNameError, confirmLabel: "Create" }); });
  const input = await screen.findByRole("textbox", { name: "Branch name" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "bad name" } });
  expect(screen.getByRole("alert").textContent).toBe("Spaces are not allowed");
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: " feature/ok " } });
  fireEvent.submit(input.closest("form")!);
  await expect(name).resolves.toBe("feature/ok");

  let cancelled!: Promise<string | undefined>;
  act(() => { cancelled = requestText({ title: "Rename", label: "Name", defaultValue: "x" }); });
  fireEvent.keyDown(window, { key: "Escape" });
  await expect(cancelled).resolves.toBeUndefined();

  let fields!: Promise<Record<string, string> | undefined>;
  act(() => { fields = requestFields({ title: "Upstream", fields: [{ id: "root", label: "Root", choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }, { id: "dir", label: "Directory", optional: true }] }); });
  fireEvent.change(await screen.findByRole("combobox", { name: "Root" }), { target: { value: "b" } });
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  await expect(fields).resolves.toEqual({ root: "b", dir: "" });

  let confirmed!: Promise<boolean>;
  act(() => { confirmed = requestConfirm({ title: "Delete tag?", message: "Delete v1?", confirmLabel: "Delete", danger: true }); });
  expect((await screen.findByRole("alertdialog")).textContent).toContain("Delete v1?");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await expect(confirmed).resolves.toBe(true);
});
it("rejects invalid Git names", () => {
  for (const name of ["a..b", "a b", "-x", "x.lock", "x/", "a~1", "@"]) expect(gitRefNameError(name)).toBeTruthy();
  for (const name of ["feature/x", "v1.0.0", "fix-123"]) expect(gitRefNameError(name)).toBeUndefined();
});
