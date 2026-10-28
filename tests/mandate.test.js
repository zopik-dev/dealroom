import test from "node:test";
import assert from "node:assert/strict";
import { createMandate, checkMandate, describeMandate } from "../src/mandate.js";

test("createMandate rejects garbage budgets (NaN must never pass)", () => {
  for (const v of [NaN, 0, -10, "abc", undefined, Infinity]) {
    assert.throws(() => createMandate({ maxBudget: v }), /positive/);
  }
});

test("checkMandate enforces budget, expiry and category", () => {
  const m = createMandate({ maxBudget: 100, categories: ["design"] });
  assert.equal(checkMandate(m, { amount: 50, category: "design" }).ok, true);
  assert.equal(checkMandate(m, { amount: 100, category: "design" }).ok, true);
  assert.equal(checkMandate(m, { amount: 101, category: "design" }).ok, false);
  assert.equal(checkMandate(m, { amount: 50, category: "code" }).ok, false);
  const expired = createMandate({ maxBudget: 100, expiresInMinutes: -1 });
  assert.equal(checkMandate(expired, { amount: 10 }).ok, false);
});

test("describeMandate never leaks the budget value", () => {
  const d = describeMandate(createMandate({ maxBudget: 999 }));
  assert.ok(!JSON.stringify(d).includes("999"));
  assert.equal(d.hasBudget, true);
});
