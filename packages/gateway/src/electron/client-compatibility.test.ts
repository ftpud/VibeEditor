import assert from "node:assert/strict";
import test from "node:test";
import { compatibleClient, readCompatibility } from "./client-compatibility.js";

test("cached client compatibility requires an overlapping valid range", () => {
  assert.equal(compatibleClient({ minimum: 1, maximum: 2 }, { minimum: 2, maximum: 3 }), true);
  assert.equal(compatibleClient({ minimum: 1, maximum: 1 }, { minimum: 2, maximum: 2 }), false);
  assert.equal(compatibleClient({ minimum: 3, maximum: 1 }, { minimum: 1, maximum: 3 }), false);
});

test("client manifest parser rejects malformed cache metadata", () => {
  assert.deepEqual(readCompatibility({ compatibility: { minimum: 1, maximum: 1 } }), { minimum: 1, maximum: 1 });
  assert.equal(readCompatibility({ compatibility: { minimum: "1", maximum: 1 } }), undefined);
});
