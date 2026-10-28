import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { negotiate } from "./agents.js";
import { judge } from "./arbiter.js";
import { checkMandate, createMandate, describeMandate } from "./mandate.js";
import * as paypal from "./paypal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// In-memory store: fine for a demo. Swap for a DB if you need persistence.
const deals = new Map();

// Never leak either secret limit (seller floor, buyer max) or the authorization id.
const publicDeal = ({ sellerMin, authorizationId, mandate, negotiating, ...rest }) => ({
  ...rest,
  mandate: mandate ? describeMandate(mandate) : undefined,
});

const getDeal = (req, res) => {
  const deal = deals.get(req.params.id);
  if (!deal) res.status(404).json({ error: "Deal not found" });
  return deal;
};

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err.message });
  });

// 1) Create a deal. Buyer's max and seller's min are the two secrets.
app.post(
  "/api/deals",
  wrap(async (req, res) => {
    const { title, category = "general", deliverables, buyerMax, sellerMin, currency = "USD" } = req.body;
    if (!title || typeof title !== "string" || !title.trim() || title.length > 200) {
      return res.status(400).json({ error: "title is required (max 200 chars)" });
    }
    if (!Array.isArray(deliverables) || !deliverables.length || deliverables.length > 20) {
      return res.status(400).json({ error: "deliverables[] is required (1-20 items)" });
    }
    for (const d of deliverables) {
      if (typeof d !== "string" || !d.trim() || d.length > 500) {
        return res.status(400).json({ error: "each deliverable must be 1-500 chars" });
      }
    }
    if (!Number.isFinite(Number(buyerMax)) || !Number.isFinite(Number(sellerMin)) || !(buyerMax > 0) || !(sellerMin > 0)) {
      return res.status(400).json({ error: "buyerMax and sellerMin must be positive numbers" });
    }
    if (!/^[A-Z]{3}$/.test(String(currency))) {
      return res.status(400).json({ error: "currency must be a 3-letter code (USD)" });
    }
    const id = randomUUID();
    const deal = {
      id,
      title,
      category,
      deliverables,
      currency,
      sellerMin: Number(sellerMin),
      mandate: createMandate({ maxBudget: buyerMax, categories: [category] }),
      status: "created",
      turns: [],
      price: null,
    };
    deals.set(id, deal);
    res.status(201).json(publicDeal(deal));
  })
);

// 2) Stream the negotiation (SSE). When agreed, create the PayPal order (AUTHORIZE).
app.get("/api/deals/:id/events", async (req, res) => {
  const deal = getDeal(req, res);
  if (!deal) return;

  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (deal.status !== "created") {
    deal.turns.forEach((turn) => send({ type: "turn", turn }));
    send({ type: "state", deal: publicDeal(deal) });
    return res.end();
  }

  if (deal.negotiating) {
    // Second stream while a run is in flight: replay only, never start a second negotiation.
    deal.turns.forEach((turn) => send({ type: "turn", turn }));
    return res.end();
  }

  try {
    deal.status = "negotiating";
    deal.negotiating = true;
    const result = await negotiate({
      deal,
      mandate: deal.mandate,
      sellerMin: deal.sellerMin,
      emit: (e) => {
        if (e.type === "turn") deal.turns.push(e.turn);
        send(e);
      },
    });
    deal.negotiating = false;

    if (!result.agreed) {
      deal.status = "no_deal";
      send({ type: "state", deal: publicDeal(deal) });
      return res.end();
    }

    // Re-verify the final price in code before any money moves.
    const finalCheck = checkMandate(deal.mandate, { amount: result.price, category: deal.category });
    if (!finalCheck.ok || result.price < deal.sellerMin) {
      deal.status = "no_deal";
      send({ type: "state", deal: publicDeal(deal) });
      return res.end();
    }

    deal.price = result.price;
    const order = await paypal.createOrder({
      dealId: deal.id,
      title: deal.title,
      amount: deal.price,
      currency: deal.currency,
      returnUrl: `${APP_URL}/paypal/return?deal=${deal.id}`,
      cancelUrl: `${APP_URL}/paypal/cancel?deal=${deal.id}`,
    });
    if (!order.approveUrl) throw new Error("PayPal did not return approveUrl");
    deal.orderId = order.orderId;
    deal.approveUrl = order.approveUrl;
    deal.status = "awaiting_payment";
    send({ type: "state", deal: publicDeal(deal) });
  } catch (err) {
    console.error(err);
    deal.negotiating = false;
    deal.status = "error";
    send({ type: "error", message: err.message });
  }
  res.end();
});

// 3) Buyer approved in PayPal -> place the hold (authorization).
app.get(
  "/paypal/return",
  wrap(async (req, res) => {
    const deal = deals.get(req.query.deal);
    if (!deal || !deal.orderId) return res.status(404).send("Deal not found");
    if (req.query.token && req.query.token !== deal.orderId) return res.status(403).send("Order mismatch");
    if (deal.status === "funded") return res.redirect(`/?deal=${deal.id}`);
    if (deal.status === "authorizing") return res.redirect(`/?deal=${deal.id}`);
    deal.status = "authorizing";
    try {
      const auth = await paypal.authorizeOrder(deal.orderId);
      deal.authorizationId = auth.authorizationId;
      deal.authorizationExpiresAt = auth.expiresAt;
      deal.status = "funded";
    } catch (err) {
      console.error(err);
      deal.status = "awaiting_payment";
      deal.paymentError = "Authorization failed. Try approving again.";
    }
    res.redirect(`/?deal=${deal.id}`);
  })
);

app.get("/paypal/cancel", (req, res) => {
  const deal = deals.get(req.query.deal);
  if (deal && deal.status === "awaiting_payment") deal.status = "payment_cancelled";
  res.redirect(`/?deal=${req.query.deal}`);
});

// 4) Seller delivers.
app.post(
  "/api/deals/:id/deliver",
  wrap(async (req, res) => {
    const deal = getDeal(req, res);
    if (!deal) return;
    if (deal.status !== "funded") return res.status(409).json({ error: `Deal is ${deal.status}, not funded` });
    if (!req.body.submission || typeof req.body.submission !== "string" || !req.body.submission.trim()) {
      return res.status(400).json({ error: "submission is required" });
    }
    if (req.body.submission.length > 10000) {
      return res.status(400).json({ error: "submission too long (max 10000 chars)" });
    }
    deal.submission = String(req.body.submission).slice(0, 10000);
    deal.status = "delivered";
    res.json(publicDeal(deal));
  })
);

// 5) Arbiter decides, then money moves: capture / partial capture / void.
app.post(
  "/api/deals/:id/judge",
  wrap(async (req, res) => {
    const deal = getDeal(req, res);
    if (!deal) return;
    // Idempotent: already judged -> return existing result, no second PayPal call.
    if (["released", "partially_released", "refunded"].includes(deal.status) && deal.decision) {
      return res.json(publicDeal(deal));
    }
    if (deal.status === "judging") return res.status(409).json({ error: "Judging already in progress" });
    if (deal.status !== "delivered") return res.status(409).json({ error: `Deal is ${deal.status}, not delivered` });
    if (!deal.submission || !deal.submission.trim() || !deal.authorizationId) {
      return res.status(409).json({ error: "Deal is not ready for judgment" });
    }
    if (checkMandate(deal.mandate, { amount: deal.price, category: deal.category }).reason === "Mandate expired") {
      return res.status(409).json({ error: "Mandate expired" });
    }

    deal.status = "judging";
    try {
      // Reuse a saved verdict on retry: a PayPal failure must never trigger a second, possibly different, LLM verdict.
      const decision = deal.decision || (await judge({ deal, submission: deal.submission }));
      deal.decision = decision;
      let payment;

      if (decision.verdict === "release") {
        payment = await paypal.capture({ authorizationId: deal.authorizationId, currency: deal.currency, dealId: deal.id });
        deal.status = "released";
      } else if (decision.verdict === "partial") {
        let amount = Number((deal.price * decision.releasePercent / 100).toFixed(2));
        if (!Number.isFinite(amount)) throw Object.assign(new Error("Bad release amount"), { status: 502 });
        amount = Math.min(deal.price, Math.max(0.01, amount));
        payment = await paypal.capture({
          authorizationId: deal.authorizationId,
          amount,
          currency: deal.currency,
          final: true, // remainder of the hold is released back to the buyer
          dealId: deal.id,
        });
        deal.status = "partially_released";
      } else {
        payment = await paypal.voidAuthorization({ authorizationId: deal.authorizationId });
        deal.status = "refunded";
      }

      deal.payment = payment;
      res.json(publicDeal(deal));
    } catch (err) {
      console.error(err);
      // Retry-friendly: the verdict is kept, money is NOT shown as moved.
      deal.status = "delivered";
      deal.paymentError = "Judgment failed. Nothing was charged or released.";
      res.status(err.status >= 400 && err.status < 600 ? err.status : 500).json({ error: "Judgment failed. Nothing was charged or released." });
    }
  })
);

app.get("/api/deals/:id", (req, res) => {
  const deal = getDeal(req, res);
  if (deal) res.json(publicDeal(deal));
});

app.get("/api/deals", (_req, res) => {
  res.json([...deals.values()].map(publicDeal));
});

// Audit trail for judges: turns + decision, no secrets.
app.get("/api/deals/:id/audit", (req, res) => {
  const deal = getDeal(req, res);
  if (!deal) return;
  const { sellerMin, authorizationId, mandate, ...rest } = deal;
  res.json({ ...rest, mandate: mandate ? describeMandate(mandate) : undefined });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

if (!process.env.ANTHROPIC_API_KEY && !process.env.AI_API_KEY) console.warn("WARN: AI_API_KEY is missing — negotiation and arbitration will fail.");
if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
  console.warn("WARN: PAYPAL_CLIENT_ID/SECRET are missing — PayPal calls will fail.");
}

const server = app.listen(PORT, () => console.log(`DEALROOM running on ${APP_URL}`));

export { app, deals, server };
