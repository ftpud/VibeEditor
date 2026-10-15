import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WorkflowError } from "./WorkflowError";

afterEach(cleanup);
it("keeps long ACP errors collapsed with a one-line preview and retains the full diagnostic", () => {
  const message = `ACP failed\n${"Long diagnostic details\n".repeat(200)}`;
  const view = render(<WorkflowError message={message} />);
  const details = screen.getByLabelText("Error details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  const summary = view.container.querySelector("summary")!;
  expect(summary.textContent!.length).toBeLessThan(250);
  expect(summary.textContent).not.toContain("\n");
  expect(view.container.querySelector("pre")!.textContent).toBe(message);
  expect(view.container.querySelector("pre")!.tabIndex).toBe(0);
});
