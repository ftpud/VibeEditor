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
    onApplyChanges: vi.fn().mockResolvedValue({ appliedClasses: [], deferredClasses: [], failedClasses: [], restartRequired: false }), onInspect: inspect, onBuild: vi.fn(), onRun: vi.fn(), onDebug: vi.fn(), onStop: vi.fn(), onDebugCommand: vi.fn(), onClear: vi.fn(), onResizeStart: vi.fn()
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
