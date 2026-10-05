import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JavaPanel } from "./JavaPanel";

afterEach(cleanup);

it("expands nested objects, loads more array values, and clears them on resume", async () => {
  const inspect = vi.fn()
    .mockResolvedValueOnce({ variables: [{ name: "items", value: "int[51]", reference: "array" }] })
    .mockResolvedValueOnce({ variables: [{ name: "[0]", value: "42" }], nextStart: 50 })
    .mockResolvedValueOnce({ variables: [{ name: "[50]", value: "99" }] });
  const props = {
    height: 250, log: "", running: true,
    options: { type: "maven" as const, pomPath: "pom.xml", mavenExecutable: "mvn", sourceRoots: [], outputPath: "target/classes", testOutputPath: "target/test-classes", runConfigurations: [] },
    debugState: { status: "paused" as const, variables: [{ name: "obj", value: "instance of Probe(id=1)", reference: "object" }] },
    onApplyChanges: vi.fn().mockResolvedValue({ appliedClasses: [], deferredClasses: [], failedClasses: [], restartRequired: false }), onInspect: inspect, onConfigure: vi.fn(), onBuild: vi.fn(), onRun: vi.fn(), onDebug: vi.fn(), onStop: vi.fn(), onDebugCommand: vi.fn(), onClear: vi.fn(), onResizeStart: vi.fn()
  };
  const view = render(<JavaPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand obj" }));
  fireEvent.click(await screen.findByRole("button", { name: "Expand items" }));
  expect(await screen.findByText("42")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more elements" }));
  expect(await screen.findByText("99")).toBeTruthy();
  await waitFor(() => expect(inspect).toHaveBeenLastCalledWith("array", 50));
  view.rerender(<JavaPanel {...props} debugState={{ status: "running", variables: [] }} />);
  expect(screen.queryByText("42")).toBeNull();
});

function applyProps(onApplyChanges: React.ComponentProps<typeof JavaPanel>["onApplyChanges"]): React.ComponentProps<typeof JavaPanel> {
  return {
    height: 250, log: "", running: true,
    options: { type: "maven", pomPath: "pom.xml", mavenExecutable: "mvn", sourceRoots: [], outputPath: "target/classes", testOutputPath: "target/test-classes", runConfigurations: [] },
    debugState: { status: "paused", variables: [] },
    onApplyChanges, onInspect: vi.fn(), onConfigure: vi.fn(), onBuild: vi.fn(), onRun: vi.fn(), onDebug: vi.fn(), onStop: vi.fn(), onDebugCommand: vi.fn(), onClear: vi.fn(), onResizeStart: vi.fn()
  };
}

it("locks execution controls while applying and reports partial reloads", async () => {
  let resolve!: (result: Awaited<ReturnType<React.ComponentProps<typeof JavaPanel>["onApplyChanges"]>>) => void;
  const apply = vi.fn(() => new Promise<Awaited<ReturnType<React.ComponentProps<typeof JavaPanel>["onApplyChanges"]>>>((done) => { resolve = done; }));
  render(<JavaPanel {...applyProps(apply)} />);
  fireEvent.click(screen.getByRole("button", { name: "Apply code changes" }));
  expect((screen.getByTitle("Continue") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Applying code changes…" }) as HTMLButtonElement).disabled).toBe(true);
  resolve({ appliedClasses: ["App"], deferredClasses: ["Unused"], failedClasses: [{ className: "Model", message: "schema change not implemented" }], restartRequired: true });
  expect(await screen.findByText(/Applied 1 class/)).toBeTruthy();
  expect(screen.getByText(/first loaded/)).toBeTruthy();
  expect(screen.getByText(/Some changes require restarting/)).toBeTruthy();
  expect(screen.getByText(/Model: schema change/)).toBeTruthy();
  expect((screen.getByTitle("Continue") as HTMLButtonElement).disabled).toBe(false);
});

it("shows compilation errors and allows retry without restarting", async () => {
  const apply = vi.fn().mockRejectedValueOnce(new Error("Compilation failed. No code changes were applied.")).mockResolvedValueOnce({ appliedClasses: [], deferredClasses: [], failedClasses: [], restartRequired: false });
  render(<JavaPanel {...applyProps(apply)} />);
  fireEvent.click(screen.getByRole("button", { name: "Apply code changes" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Compilation failed. No code changes were applied.");
  fireEvent.click(screen.getByRole("button", { name: "Apply code changes" }));
  expect(await screen.findByText("No compiled code changes.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("disables Apply while running and ignores responses from a stopped session", async () => {
  let resolve!: (result: Awaited<ReturnType<React.ComponentProps<typeof JavaPanel>["onApplyChanges"]>>) => void;
  const apply = vi.fn(() => new Promise<Awaited<ReturnType<React.ComponentProps<typeof JavaPanel>["onApplyChanges"]>>>((done) => { resolve = done; }));
  const props = applyProps(apply);
  const view = render(<JavaPanel {...props} debugState={{ status: "running", variables: [] }} />);
  expect((screen.getByRole("button", { name: "Apply code changes" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<JavaPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Apply code changes" }));
  view.rerender(<JavaPanel {...props} debugState={{ status: "stopped", variables: [] }} />);
  resolve({ appliedClasses: ["App"], deferredClasses: [], failedClasses: [], restartRequired: false });
  await waitFor(() => expect(screen.queryByText(/Applied 1 class/)).toBeNull());
});
