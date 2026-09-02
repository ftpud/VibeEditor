import { describe, expect, it, vi } from "vitest";
import type { Monaco } from "@monaco-editor/react";
import { configureMonacoThemes, monacoTheme } from "./theme";

describe("editor highlighting themes", () => {
  it("selects the dark ftpud variant independently of the app chrome theme", () => {
    expect(monacoTheme("light", "ftpud-dark")).toBe("ftpud-dark");
    expect(monacoTheme("dark", "ftpud")).toBe("ftpud");
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
    expect(dark.rules.find((rule) => rule.token === "class")?.background).toBe("294D78");
    expect(dark.rules.find((rule) => rule.token === "function")?.fontStyle).toContain("bold");
    expect(themes.get("ftpud")!.rules.find((rule) => rule.token === "function")?.fontStyle).toContain("bold");
  });
});
