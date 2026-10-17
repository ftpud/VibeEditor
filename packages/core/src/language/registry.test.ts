import { describe, expect, it, vi } from "vitest";
import { LanguageRegistry, LanguageSessions } from "./registry.js";
import type { LanguageDescriptor, LanguageService } from "./service.js";

const none = { projectTree: false, build: false, run: false, debug: false, lsp: false, workspaceSymbols: false, configuration: false };
const descriptor = (id: string, extensions: string[], markers: string[], capabilities = none): LanguageDescriptor => ({ id, name: id, extensions, projectMarkers: markers, capabilities });
const service = (d: LanguageDescriptor): LanguageService => ({ descriptor: d, dispose: vi.fn(async () => undefined) } as unknown as LanguageService);

describe("LanguageRegistry", () => {
  const java = descriptor("java", ["java"], ["pom.xml"], { ...none, build: true });
  const registry = new LanguageRegistry().register(java, () => service(java)).register(descriptor("python", ["py", "pyi"], ["pyproject.toml"]), () => service(descriptor("python", ["py"], [])));

  it("rejects duplicate and malformed ids", () => {
    expect(() => registry.register(java, () => service(java))).toThrow("already registered");
    expect(() => new LanguageRegistry().register(descriptor("Bad Id", [], []), () => service(java))).toThrow("Invalid language id");
  });

  it("detects languages by extension and project marker", () => {
    expect(registry.forFile("src/Main.JAVA")?.id).toBe("java");
    expect(registry.forFile("a/b.pyi")?.id).toBe("python");
    expect(registry.forFile("README")).toBeUndefined();
    expect(registry.detectMarkers(["pom.xml", "src"]).map((d) => d.id)).toEqual(["java"]);
    expect(() => registry.descriptor("go")).toThrow("Unknown language");
  });
});

describe("LanguageSessions", () => {
  it("creates services lazily, enforces capabilities and disposes everything", async () => {
    const java = descriptor("java", ["java"], [], { ...none, build: true });
    const create = vi.fn(() => service(java));
    const sessions = new LanguageSessions(new LanguageRegistry().register(java, create), "/workspace");
    expect(create).not.toHaveBeenCalled();
    expect(() => sessions.require("java", "debug")).toThrow("does not support debug");
    expect(create).not.toHaveBeenCalled();
    const built = sessions.require("java", "build");
    expect(sessions.get("java")).toBe(built);
    expect(create).toHaveBeenCalledTimes(1);
    await sessions.dispose();
    expect(built.dispose).toHaveBeenCalledTimes(1);
    expect(sessions.get("java")).not.toBe(built);
  });
});

describe("LanguageSessions disposal", () => {
  it("disposes every service even when one throws synchronously", async () => {
    const make = (id: string, dispose: () => Promise<void>) => { const d = descriptor(id, [], []); return { d, svc: { descriptor: d, dispose } as unknown as LanguageService }; };
    const good = vi.fn(async () => undefined);
    const bad = make("bad", () => { throw new Error("sync failure"); });
    const fine = make("fine", good);
    const sessions = new LanguageSessions(new LanguageRegistry().register(bad.d, () => bad.svc).register(fine.d, () => fine.svc), "/w");
    sessions.get("bad"); sessions.get("fine");
    await expect(sessions.dispose()).rejects.toThrow("Could not dispose");
    expect(good).toHaveBeenCalledTimes(1);
  });
});
