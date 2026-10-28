// Isolated E2E: own port, mocked PayPal + mocked AI.
// Zero real network calls, zero real money, zero keys needed.
import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.PORT = "3457";
process.env.APP_URL = "http://localhost:3457";
process.env.PAYPAL_CLIENT_ID = "test-id";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
process.env.PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";
process.env.AI_API_KEY = "test-key";
process.env.AI_BASE_URL = "https://ai.test";
process.env.AI_MODEL = "test-model";

const BASE = "http://localhost:3457";
const realFetch = globalThis.fetch;

// Scripted AI: buyer 70 -> seller 90 -> buyer 80 -> seller accepts 80. Then arbiter: 2/2 met.
const aiQueue = [
  { action: "offer", price: 70, message: "We can do 70 for a quick start." },
  { action: "offer", price: 90, message: "Quality work costs 90." },
  { action: "offer", price: 80, message: "Meet at 80?" },
  { action: "accept", price: 80, message: "Deal at 80." },
  {
    criteria: [
      { deliverable: "Logo in SVG", met: true, note: "logo.svg present" },
      { deliverable: "Logo in PNG", met: true, note: "1024px present" },
    ],
    summary: "All deliverables met.",
  },
];

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || "GET").toUpperCase();
  if (u.startsWith(BASE)) return realFetch(url, opts);
  if (u.includes("/v1/oauth2/token")) return json({ access_token: "TOK", expires_in: 3600 });
  if (u.includes("/v2/checkout/orders/") && u.endsWith("/authorize")) {
    return json({ purchase_units: [{ payments: { authorizations: [{ id: "AUTH-1", status: "AUTHORIZED", expiration_time: "2027-01-01T00:00:00Z" }] } }] });
  }
  if (u.includes("/v2/checkout/orders") && method === "POST") {
    return json({ id: "ORDER-1", status: "CREATED", links: [{ rel: "payer-action", href: `${BASE}/fake-approve` }] });
  }
  if (u.includes("/capture")) {
    return json({ id: "CAP-1", status: "COMPLETED", amount: { currency_code: "USD", value: "80.00" } });
  }
  if (u.includes("/void")) return json({ id: "VOID-1", status: "VOIDED" });
  if (u.includes("/chat/completions")) {
    const next = aiQueue.shift();
    return json({ choices: [{ message: { content: JSON.stringify(next) } }] });
  }
  throw new Error("Unexpected external call: " + u);
};

const { server } = await import("../src/server.js");
after(() => new Promise((resolve) => server.close(resolve)));
await new Promise((r) => setTimeout(r, 500));

async function post(path, body) {
  const res = await realFetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function get(path) {
  const res = await realFetch(BASE + path);
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function readSSE(id) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await realFetch(`${BASE}/api/deals/${id}/events`, { signal: ctrl.signal });
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const sseEvents = (text) =>
  text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));

test("validation rejects bad deals (400, no crash)", async () => {
  assert.equal((await post("/api/deals", {})).status, 400);
  assert.equal((await post("/api/deals", { title: "x", deliverables: ["a"], buyerMax: -5, sellerMin: 10 })).status, 400);
  assert.equal((await post("/api/deals", { title: "x", deliverables: [], buyerMax: 10, sellerMin: 5 })).status, 400);
});

test("full escrow loop: negotiate -> hold -> deliver -> release", async () => {
  const created = await post("/api/deals", {
    title: "Logo", category: "design",
    deliverables: ["Logo in SVG", "Logo in PNG"],
    buyerMax: 100, sellerMin: 60, currency: "USD",
  });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.ok(id);

  const raw = JSON.stringify(created.data);
  for (const s of ["sellerMin", "authorizationId", "buyerMax", "maxBudget"]) {
    assert.ok(!raw.includes(s), "secret leaked: " + s);
  }

  const events = sseEvents(await readSSE(id));
  const turns = events.filter((e) => e.type === "turn");
  assert.equal(turns.length, 4);
  assert.ok(turns.every((e) => !JSON.stringify(e).includes("sellerMin")));
  const state = events.find((e) => e.type === "state");
  assert.equal(state.deal.status, "awaiting_payment");
  assert.equal(state.deal.price, 80);
  assert.ok(state.deal.approveUrl);

  const ret = await realFetch(`${BASE}/paypal/return?deal=${id}&token=ORDER-1`, { redirect: "manual" });
  assert.equal(ret.status, 302);
  assert.equal((await get(`/api/deals/${id}`)).data.status, "funded");

  assert.equal((await post(`/api/deals/${id}/judge`, {})).status, 409);

  const del = await post(`/api/deals/${id}/deliver`, { submission: "logo.svg and logo.png 1024px delivered" });
  assert.equal(del.data.status, "delivered");

  const judged = await post(`/api/deals/${id}/judge`, {});
  assert.equal(judged.data.status, "released");
  assert.equal(judged.data.decision.verdict, "release");
  assert.equal(judged.data.decision.releasePercent, 100);
  assert.equal(judged.data.payment.captureId, "CAP-1");

  // Idempotent: second judge returns the saved result, must NOT call the LLM again
  // (the AI queue is empty — any extra model call would throw).
  const again = await post(`/api/deals/${id}/judge`, {});
  assert.equal(again.data.status, "released");
  assert.equal(again.data.decision.releasePercent, 100);

  const audit = await get(`/api/deals/${id}/audit`);
  const ar = JSON.stringify(audit.data);
  for (const s of ["sellerMin", "authorizationId", "buyerMax", "maxBudget"]) {
    assert.ok(!ar.includes(s), "audit leaked: " + s);
  }

  assert.deepEqual((await get("/health")).data, { ok: true });
});

test("guards: deliver/judge out of order fail with 409", async () => {
  const c = await post("/api/deals", { title: "X", category: "g", deliverables: ["a"], buyerMax: 10, sellerMin: 5 });
  assert.equal((await post(`/api/deals/${c.data.id}/deliver`, { submission: "x" })).status, 409);
  assert.equal((await post(`/api/deals/${c.data.id}/judge`, {})).status, 409);
});
