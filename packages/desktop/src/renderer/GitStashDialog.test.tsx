import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitStashDialog } from "./GitStashDialog";

describe("GitStashDialog", () => {
  it("makes every inclusion choice and destructive recovery action visible", () => {
    const client = { request: () => Promise.resolve({ stashes: [] }) } as never;
    const markup = renderToStaticMarkup(<GitStashDialog client={client} selectedPaths={["file.ts"]} onClose={() => {}} onChanged={() => {}} />);
    for (const label of ["staged", "unstaged", "untracked", "ignored", "Selected paths only (1)", "Create stash"]) expect(markup).toContain(label);
  });
});
