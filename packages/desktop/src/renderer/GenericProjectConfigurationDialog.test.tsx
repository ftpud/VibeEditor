import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreClient } from "./client";
import { GenericProjectConfigurationDialog } from "./GenericProjectConfigurationDialog";
afterEach(cleanup);
it("keeps plugin configuration saves revision-checked", async () => {
  const revision = { hash: "original" };
  const request = vi.fn(async (type: string) => type === "language.configuration.read" ? { path: ".settings/custom.json", content: "{}", revision } : { options: { configured: true } });
  const onSaved = vi.fn();
  render(<GenericProjectConfigurationDialog client={{ request } as unknown as CoreClient} language="custom" running={false} onClose={vi.fn()} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty("disabled", false));
  fireEvent.change(screen.getByLabelText("Configuration"), { target: { value: '{"runConfigurations":[]}' } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ configured: true }));
  expect(request).toHaveBeenCalledWith("language.configuration.save", { language: "custom", content: '{"runConfigurations":[]}', expectedRevision: revision }, undefined);
});
it("does not apply an old save after its editor is unmounted on a root change", async () => {
  let finish!: (value: { options: object }) => void;
  const saved = new Promise<{ options: object }>((resolve) => { finish = resolve; });
  const request = vi.fn(async (type: string) => type === "language.configuration.read" ? { path: "custom.json", content: "{}" } : saved);
  const onSaved = vi.fn();
  const view = render(<GenericProjectConfigurationDialog client={{ request } as unknown as CoreClient} language="custom" running={false} onClose={vi.fn()} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  view.unmount(); finish({ options: { configured: true } });
  await saved; await Promise.resolve();
  expect(onSaved).not.toHaveBeenCalled();
});
