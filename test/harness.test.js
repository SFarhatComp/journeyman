import test from "node:test";
import assert from "node:assert/strict";

test("the container test harness runs ESM and node:test", () => {
  assert.equal(typeof structuredClone, "function", "Node 17+ builtin expected");
  assert.ok(process.version.startsWith("v22"), `expected Node 22, got ${process.version}`);
});
