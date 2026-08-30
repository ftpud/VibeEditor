import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/renderer/styles.css", "utf8");

function declarations(selector: string): string {
  const match = styles.match(new RegExp(selector.replace(".", "\\.") + "\\s*\\{([^}]*)\\}"));
  if (!match) throw new Error(`Missing ${selector} layout rule`);
  return match[1]!;
}

describe("horizontal editor layout containment", () => {
  it("allows the workspace row and editor area to shrink, and clips editor overflow", () => {
    expect(declarations(".workspace-row")).toContain("min-width: 0");
    const editorArea = declarations(".editor-area");
    expect(editorArea).toContain("min-width: 0");
    expect(editorArea).toContain("overflow: hidden");
  });
});
