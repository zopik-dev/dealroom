// Buyer mandate: hard limits enforced in code, NOT by the model.
// The agent can say whatever it wants; it physically cannot commit past the mandate.

export function createMandate({ maxBudget, categories = [], expiresInMinutes = 60 }) {
  const n = Number(maxBudget);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error("maxBudget must be a positive number"), { status: 400 });
  }
  return {
    maxBudget: n,
    categories,
    expiresAt: Date.now() + expiresInMinutes * 60_000,
  };
}

/** Returns { ok: true } or { ok: false, reason }. */
export function checkMandate(mandate, { amount, category }) {
  if (Date.now() > mandate.expiresAt) {
    return { ok: false, reason: "Mandate expired" };
  }
  if (amount > mandate.maxBudget) {
    return { ok: false, reason: `Amount $${amount} exceeds mandate limit $${mandate.maxBudget}` };
  }
  if (mandate.categories.length && !mandate.categories.includes(category)) {
    return { ok: false, reason: `Category "${category}" is not allowed by the mandate` };
  }
  return { ok: true };
}

/** Public view of a mandate (never leaks either secret limit). */
export function describeMandate(mandate) {
  return {
    categories: mandate.categories,
    expiresAt: new Date(mandate.expiresAt).toISOString(),
    hasBudget: true,
  };
}
