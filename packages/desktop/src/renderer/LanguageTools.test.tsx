import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LanguageDescriptor, ServerEvent } from "@remote-ide/protocol";
import type { CoreClient } from "./client";
import { LanguageTools } from "./LanguageTools";

afterEach(cleanup);
const node: LanguageDescriptor = { id: "third-party", name: "Example language", extensions: ["ex"], projectMarkers: [], capabilities: { build: true, run: true, debug: false, projectTree: true, lsp: false, workspaceSymbols: false, configuration: false } };
function setup(languages = [node]) {
  let listener: ((event: ServerEvent) => void) | undefined;
  const request = vi.fn(async (type: string) => {
    if (type === "language.projectTree") return { tree: [{ path: "hello.ex", name: "hello.ex", type: "file" }] };
    if (type === "language.listRunTargets") return { targets: [{ id: "hello", name: "Hello" }] };
    if (type === "language.options") return { options: { runConfigurations: [{ id: "existing", name: "Existing" }], selectedRunConfigurationId: "existing" } };
    if (type === "language.addRunConfiguration" || type === "language.selectRunConfiguration") return { options: { runConfigurations: [{ id: "added", name: "New configuration" }], selectedRunConfigurationId: "added" } };
    if (type === "language.configuration.read") return { path: ".settings/example.json", content: "{}", revision: { hash: "old" } };
    if (type === "language.configuration.save") return { content: "{\"saved\":true}", revision: { hash: "new" } };
    return {};
  });
  const client = { request, getRoot: () => "root", subscribeServerEvents: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; } } as unknown as CoreClient;
  const beforeLaunch = vi.fn(async () => {});
  const onOpenFile = vi.fn();
  const props = { client, languages, open: true, onSelect: vi.fn(), onClose: vi.fn(), onOpenFile, beforeLaunch };
  const view = render(<LanguageTools {...props} />);
  return { ...view, props, request, beforeLaunch, onOpenFile, event: (event: ServerEvent) => listener?.(event) };
}

it("uses plugin descriptors for trees and hides unsupported controls", async () => {
  const { request, onOpenFile } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "hello.ex" }));
  expect(onOpenFile).toHaveBeenCalledWith("hello.ex");
  expect(screen.getByText("Hello")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Debug" })).toBeNull();
  expect(screen.queryByText("Run configurations")).toBeNull();
  expect(screen.queryByText("Configuration")).toBeNull();
  expect(request).toHaveBeenCalledWith("language.projectTree", { language: "third-party" }, undefined);
  expect(request.mock.calls.some(([type]) => type === "language.configuration.read" || type === "language.options")).toBe(false);
});

it("saves edits before launching and scopes output to the root and language", async () => {
  const { request, beforeLaunch, event } = setup();
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("language.run", { language: "third-party" }, { timeoutMs: 600000 }));
  expect(beforeLaunch.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[request.mock.calls.findIndex(([type]) => type === "language.run")]!);
  event({ type: "language.output", payload: { rootId: "other-root", language: "third-party", data: "hidden", stream: "stdout" } });
  event({ type: "language.output", payload: { rootId: "root", language: "third-party", data: "visible", stream: "stdout" } });
  expect(await screen.findByText("visible")).toBeTruthy();
  expect(screen.queryByText("hidden")).toBeNull();
});

it("preserves configuration revisions when saving", async () => {
  const { request } = setup([{ ...node, capabilities: { ...node.capabilities, configuration: true } }]);
  const editor = await screen.findByRole("textbox", { name: "Example language configuration" });
  fireEvent.change(editor, { target: { value: '{"changed":true}' } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("language.configuration.save", { language: "third-party", content: '{"changed":true}', expectedRevision: { hash: "old" } }, undefined));
});

it("uses independent capabilities to add and select run configurations", async () => {
  const { request } = setup([{ ...node, capabilities: { ...node.capabilities, runConfigurations: true, sourceRoots: true } }]);
  await screen.findByRole("option", { name: "Existing" });
  fireEvent.change(screen.getByLabelText("Target"), { target: { value: "hello" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New configuration" } });
  fireEvent.click(screen.getByRole("button", { name: "Add configuration" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("language.addRunConfiguration", { language: "third-party", name: "New configuration", target: "hello" }, undefined));
  await screen.findByRole("option", { name: "New configuration" });
  fireEvent.change(screen.getByLabelText("Selected configuration"), { target: { value: "added" } });
  await waitFor(() => expect(request).toHaveBeenCalledWith("language.selectRunConfiguration", { language: "third-party", id: "added" }, undefined));
  fireEvent.change(screen.getByLabelText("Source root"), { target: { value: "src" } });
  fireEvent.click(screen.getByRole("button", { name: "Add source root" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("language.addSourceRoot", { language: "third-party", path: "src" }, undefined));
});

it("does not launch when saving dirty editors fails", async () => {
  const { request, beforeLaunch } = setup();
  beforeLaunch.mockRejectedValueOnce(new Error("Save conflict"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Save conflict");
  expect(request.mock.calls.some(([type]) => type === "language.run")).toBe(false);
});

it("clears a failed launch even after switching to another language", async () => {
  const second = { ...node, id: "second", name: "Second language" };
  const { request, props, rerender } = setup([node, second]);
  const original = request.getMockImplementation()!;
  let reject!: (error: Error) => void;
  const running = new Promise<object>((_resolve, fail) => { reject = fail; });
  request.mockImplementation((type) => type === "language.run" ? running : original(type));
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(request.mock.calls.some(([type]) => type === "language.run")).toBe(true));
  rerender(<LanguageTools {...props} selected="second" />);
  await act(async () => { reject(new Error("Launch failed")); await Promise.resolve(); });
  rerender(<LanguageTools {...props} selected="third-party" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toHaveProperty("disabled", false));
});
