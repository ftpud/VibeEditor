import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceFileSystem } from "../filesystem.js";
import { WorkspaceStateStore } from "../workspace-state.js";
import { JavaLanguageService } from "./java-service.js";

async function create() {
  const root = await mkdtemp(path.join(tmpdir(), "remote-ide-lang-java-"));
  await mkdir(path.join(root, "src", "main", "java", "com", "example"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>");
  await writeFile(path.join(root, "src", "main", "java", "com", "example", "App.java"), "package com.example; public interface App {}\n");
  const filesystem = new WorkspaceFileSystem();
  await filesystem.open(root);
  const events = { output: vi.fn(), exit: vi.fn(), debugState: vi.fn(), semanticChanged: vi.fn() };
  return { service: new JavaLanguageService(filesystem, new WorkspaceStateStore(root, await mkdtemp(path.join(tmpdir(), "remote-ide-lang-state-"))), events), events };
}

describe("JavaLanguageService", () => {
  it("adapts Maven loading and the project tree, keeping Java type metadata in extra", async () => {
    const { service } = await create();
    try {
      expect(await service.detect()).toBe(false);
      await expect(service.load({})).rejects.toThrow("pomPath");
      const loaded = await service.load({ pomPath: "pom.xml" });
      expect(loaded.options).toMatchObject({ type: "maven", pomPath: "pom.xml" });
      expect(await service.detect()).toBe(true);
      const tree = await service.projectTree();
      expect(tree[0]).toMatchObject({ type: "sourceRoot", sourceKind: "source" });
      expect(tree[0]?.children?.[0]?.children?.[0]).toMatchObject({ name: "App.java", extra: { javaType: { kind: "interface" } } });
      expect(await service.listRunTargets()).toEqual([]);
    } finally { await service.dispose(); }
  });

  it("requires a class name on breakpoints and advertises full capabilities", async () => {
    const { service } = await create();
    try {
      expect(service.descriptor.capabilities).toMatchObject({ build: true, run: true, debug: true, lsp: true });
      expect(() => service.validateExtra("breakpoint", {})).toThrow("className");
      await expect(service.setBreakpoints([{ path: "A.java", line: 1 }])).rejects.toThrow("className");
    } finally { await service.dispose(); }
  });
});
