import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BranchSelectorGroup } from "./App.js";

const noop = () => undefined;

describe("BranchSelectorGroup", () => {
  it("offers local lifecycle actions but keeps remote actions scoped to deletion", () => {
    const local = renderToStaticMarkup(<BranchSelectorGroup title="Local" branches={[{ name: "feature/demo", current: false, remote: false }]} selected="feature/demo" onSelect={noop} onCheckout={noop} onRename={noop} onDelete={noop} onPublish={noop} onSetUpstream={noop} />);
    expect(local).toContain("Publish");
    expect(local).toContain("Upstream");
    expect(local).toContain("Delete");
    const remote = renderToStaticMarkup(<BranchSelectorGroup title="Remote" branches={[{ name: "origin/feature/demo", current: false, remote: true }]} selected="origin/feature/demo" onSelect={noop} onCheckout={noop} onRename={noop} onDelete={noop} onPublish={noop} onSetUpstream={noop} />);
    expect(remote).toContain("Delete");
    expect(remote).not.toContain("Publish");
    expect(remote).not.toContain("Upstream");
  });
});
