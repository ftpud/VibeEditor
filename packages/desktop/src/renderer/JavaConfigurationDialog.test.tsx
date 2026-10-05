import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JavaConfigurationDialog } from "./JavaConfigurationDialog";
import type { CoreClient } from "./client";

const options = { type: "maven", pomPath: "pom.xml", mavenExecutable: "mvn", sourceRoots: ["src/main/java"], outputPath: "target/classes", testOutputPath: "target/test-classes", runConfigurations: [{ id: "app", name: "App", mainClass: "demo.App" }], selectedRunConfigurationId: "app" };
const revision = { identity: "file", version: "1" };
afterEach(cleanup);
function clientFixture(content = JSON.stringify(options)) {
  const request = vi.fn(async (type: string, payload?: { content?: string }) => {
    if (type === "java.configuration.read") return { path: ".project/java.json", content, revision, template: JSON.stringify(options, null, 2) };
    if (type === "java.listMainClasses") return { classes: [{ className: "demo.App", path: "src/main/java/demo/App.java" }] };
    if (type === "java.tools.check") return { checks: [{ tool: "Maven", executable: "mvn", ok: false, message: '"mvn" was not found on the Core host. Choose ./mvnw or an installed Maven executable.' }] };
    if (type === "java.configuration.save") return { options: JSON.parse(payload!.content!), content: payload!.content, revision };
    throw new Error(`Unexpected request ${type}`);
  });
  return { request, client: { request } as unknown as CoreClient };
}

it("edits tools and launch arguments without losing line breaks, and saves the remote revision", async () => {
  const { client, request } = clientFixture(); const saved = vi.fn();
  render(<JavaConfigurationDialog client={client} running={false} onClose={vi.fn()} onSaved={saved} />);
  await screen.findByLabelText("Main class");
  fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
  fireEvent.change(screen.getByLabelText("Environment file (.env, optional)"), { target: { value: "config/app.env" } });
  fireEvent.click(screen.getByRole("tab", { name: "Tools & build" }));
  fireEvent.change(screen.getByLabelText("Maven executable"), { target: { value: "./mvnw" } });
  fireEvent.change(screen.getByLabelText("JDK home (optional)"), { target: { value: "/opt/jdk" } });
  fireEvent.click(screen.getByRole("tab", { name: "Launch profiles" }));
  const argumentsField = screen.getByLabelText("Program arguments — one per line");
  fireEvent.change(argumentsField, { target: { value: "--message\n" } });
  expect((argumentsField as HTMLTextAreaElement).value).toBe("--message\n");
  fireEvent.change(argumentsField, { target: { value: "--message\nhello world" } });
  fireEvent.change(screen.getByLabelText("VM arguments — one per line"), { target: { value: "-ea\n-Dvalue=hello world" } });
  fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
  fireEvent.change(screen.getByLabelText("Application environment (JSON)"), { target: { value: '{"MODE":"dev"}' } });
  fireEvent.change(screen.getByLabelText("Active profile (optional)"), { target: { value: "dev,local" } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  const payload = request.mock.calls.find(([type]) => type === "java.configuration.save")![1] as { content: string; expectedRevision: unknown };
  expect(payload.expectedRevision).toEqual(revision);
  expect(JSON.parse(payload.content)).toMatchObject({ mavenExecutable: "./mvnw", javaHome: "/opt/jdk", runConfigurations: [{ activeProfile: "dev,local", environmentFile: "config/app.env", programArguments: ["--message", "hello world"], vmArguments: ["-ea", "-Dvalue=hello world"], environment: { MODE: "dev" } }] });
});

it("duplicates, selects, and deletes launch profiles", async () => {
  const { client } = clientFixture(); const saved = vi.fn();
  render(<JavaConfigurationDialog client={client} running={false} onClose={vi.fn()} onSaved={saved} />);
  await screen.findByLabelText("Main class"); fireEvent.click(screen.getByTitle("Duplicate launch profile"));
  expect((screen.getByLabelText("Profile name") as HTMLInputElement).value).toBe("App copy");
  fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Development" } });
  fireEvent.click(screen.getByLabelText("Use this profile for Run / Debug"));
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  const value = saved.mock.calls[0]![0]; expect(value.runConfigurations).toHaveLength(2);
  expect(value.selectedRunConfigurationId).toBe(value.runConfigurations[1].id);
  fireEvent.click(screen.getByTitle("Delete launch profile"));
  expect((screen.getByLabelText("Profile name") as HTMLInputElement).value).toBe("App");
});

it("keeps invalid JSON editable and offers a repair template", async () => {
  const { client } = clientFixture("{bad JSON");
  render(<JavaConfigurationDialog client={client} running={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  const json = await screen.findByLabelText("Configuration JSON"); expect((json as HTMLTextAreaElement).value).toBe("{bad JSON");
  fireEvent.click(screen.getByRole("button", { name: "Insert template" })); expect(JSON.parse((json as HTMLTextAreaElement).value)).toEqual(options);
  fireEvent.click(screen.getByRole("tab", { name: "Tools & build" }));
  expect(await screen.findByLabelText("Maven executable")).toHaveProperty("value", "mvn");
});

it("checks unsaved settings and displays actionable tool errors", async () => {
  const { client, request } = clientFixture();
  render(<JavaConfigurationDialog client={client} running={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByLabelText("Main class");
  fireEvent.click(screen.getByRole("tab", { name: "Tools & build" }));
  fireEvent.change(screen.getByLabelText("Maven executable"), { target: { value: "/opt/maven/bin/mvn" } });
  fireEvent.click(screen.getByRole("button", { name: "Check tools" }));
  expect(await screen.findByText(/was not found on the Core host/)).toBeTruthy();
  const payload = request.mock.calls.find(([type]) => type === "java.tools.check")![1]!;
  expect(JSON.parse(payload.content!).mavenExecutable).toBe("/opt/maven/bin/mvn");
});

it("blocks saving while Java runs and rejects invalid environment JSON", async () => {
  const { client, request } = clientFixture();
  const view = render(<JavaConfigurationDialog client={client} running={true} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByLabelText("Main class"); expect((screen.getByRole("button", { name: "Save configuration" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<JavaConfigurationDialog client={client} running={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
  fireEvent.change(screen.getByLabelText("Application environment (JSON)"), { target: { value: "{bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  expect((await screen.findByRole("alert")).textContent).toContain("application environment must be a JSON object");
  expect(request.mock.calls.some(([type]) => type === "java.configuration.save")).toBe(false);
});


it("shows one section at a time, preserves drafts across tabs, and keeps actions outside the scrolling body", async () => {
  const { client, request } = clientFixture();
  render(<JavaConfigurationDialog client={client} running={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByLabelText("Main class");
  expect(screen.queryByLabelText("Maven executable")).toBeNull();
  fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Edited profile" } });
  fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
  fireEvent.change(screen.getByLabelText("Application environment (JSON)"), { target: { value: '{"MODE":"dev"}' } });
  fireEvent.click(screen.getByRole("tab", { name: "Project paths" }));
  expect(screen.queryByLabelText("Main class")).toBeNull();
  fireEvent.change(screen.getByLabelText("Compiled classes"), { target: { value: "build/classes" } });
  fireEvent.click(screen.getByRole("tab", { name: "Launch profiles" }));
  expect(screen.getByLabelText("Profile name")).toHaveProperty("value", "Edited profile");
  fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
  expect(screen.getByLabelText("Application environment (JSON)")).toHaveProperty("value", '{"MODE":"dev"}');
  fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
  expect(JSON.parse((screen.getByLabelText("Configuration JSON") as HTMLTextAreaElement).value)).toMatchObject({ outputPath: "build/classes", runConfigurations: [{ name: "Edited profile", environment: { MODE: "dev" } }] });
  const save = screen.getByRole("button", { name: "Save configuration" });
  expect(screen.getByRole("tabpanel").contains(save)).toBe(false);
  expect(save.closest("footer")).toBeTruthy();
  fireEvent.click(save);
  await waitFor(() => expect(request.mock.calls.some(([type]) => type === "java.configuration.save")).toBe(true));
});

it("supports keyboard tab navigation", async () => {
  const { client } = clientFixture();
  render(<JavaConfigurationDialog client={client} running={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByLabelText("Main class");
  fireEvent.keyDown(screen.getByRole("tab", { name: "Launch profiles" }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Tools & build" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Maven executable")).toBeTruthy();
});
