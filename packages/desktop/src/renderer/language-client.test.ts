import { expect, it } from "vitest";
import { toJavaProjectNode } from "./language-client";

it("restores Java type metadata from language project nodes", () => {
  expect(toJavaProjectNode({ name: "src", path: "src", type: "sourceRoot", sourceKind: "source", children: [{ name: "A.java", path: "src/A.java", type: "file", extra: { javaType: { kind: "interface" } } }] }))
    .toEqual({ name: "src", path: "src", type: "sourceRoot", sourceKind: "source", children: [{ name: "A.java", path: "src/A.java", type: "file", javaType: { kind: "interface" } }] });
});
