import { describe, expect, it, vi } from "vitest";
import type { Monaco } from "@monaco-editor/react";
import { configureMonacoThemes, monacoTheme } from "./theme";

describe("editor highlighting themes", () => {
  it("selects the ftpud variant that matches the app chrome theme", () => {
    expect(monacoTheme("light", "ftpud")).toBe("ftpud");
    expect(monacoTheme("dark", "ftpud")).toBe("ftpud-dark");
  });

  it("defines dark class backgrounds and bold function names", () => {
    const themes = new Map<string, { rules: { token: string; background?: string; fontStyle?: string }[] }>();
    const monaco = {
      languages: {
        getLanguages: () => [{ id: "sap-cds" }],
        register: vi.fn(),
        setLanguageConfiguration: vi.fn(),
        setMonarchTokensProvider: vi.fn()
      },
      editor: { defineTheme: (name: string, definition: { rules: { token: string; background?: string; fontStyle?: string }[] }) => themes.set(name, definition) }
    } as unknown as Monaco;
    configureMonacoThemes(monaco);
    const dark = themes.get("ftpud-dark")!;
    expect(dark.rules.find((rule) => rule.token === "class")?.background).toBe("29384A");
    expect(dark.rules.find((rule) => rule.token === "function")?.fontStyle).toContain("bold");
    expect(dark.rules.find((rule) => rule.token === "identifier.function")?.fontStyle).toContain("bold");
    expect(themes.get("ftpud")!.rules.find((rule) => rule.token === "function")?.fontStyle).toContain("bold");
  });
});
