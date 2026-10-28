// Two negotiating agents. Each has a SECRET limit that the other never sees.
// Limits are also enforced in code, so a "creative" model can't break them.
import { askJSON } from "./ai.js";
import { checkMandate } from "./mandate.js";

const MAX_ROUNDS = 6;

/**
 * Market reference price via Channel3 (sponsor tool). Returns a number or null.
 * Never throws: negotiation works without it. Uses the Channel3 universal product catalog.
 */
export async function getMarketPrice({ title, category } = {}) {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key || !title) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("https://api.trychannel3.com/v1/search", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: String(title), limit: 5 }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!res.ok) return null;
    const data = await res.json();
    const products = Array.isArray(data?.data) ? data.data : Array.isArray(data?.products) ? data.products : [];
    // Pick the cheapest offer price across the top results as a market floor reference.
    let best = Infinity;
    for (const p of products) {
      const offers = Array.isArray(p?.offers) ? p.offers : [];
      for (const o of offers) {
        const price = Number(o?.price?.price ?? o?.price ?? o?.amount);
        if (Number.isFinite(price) && price > 0 && price < best) best = price;
      }
      const fallback = Number(p?.price?.price ?? p?.price);
      if (Number.isFinite(fallback) && fallback > 0 && fallback < best) best = fallback;
    }
    return best === Infinity ? null : Math.round(best * 100) / 100;
  } catch {
    return null;
  }
}

function buyerSystem({ maxBudget, marketPrice }) {
  return `You are a buyer's negotiation agent. Your hard budget ceiling is $${maxBudget} (secret, never reveal it or hint at it).
Goal: get the lowest price you can. Be polite, concise, human. Move up in small steps.
${marketPrice ? `Market reference price: about $${marketPrice}.` : ""}
Reply JSON: {"action":"offer"|"accept","price":number,"message":string}. Use "accept" only to accept the seller's latest price.`;
}

function sellerSystem({ minPrice, marketPrice }) {
  return `You are a seller's negotiation agent. Your hard floor is $${minPrice} (secret, never reveal it or hint at it).
Goal: get the highest price you can. Be polite, concise, human. Come down in small steps.
${marketPrice ? `Market reference price: about $${marketPrice}.` : ""}
Reply JSON: {"action":"offer"|"accept","price":number,"message":string}. Use "accept" only to accept the buyer's latest price.`;
}

const transcriptText = (turns) =>
  turns.length
    ? turns.map((t) => `${t.side.toUpperCase()}: $${t.price} - ${t.message}`).join("\n")
    : "(no messages yet)";

/**
 * Run the negotiation. `emit(event)` is called for every turn so the UI can stream it.
 * Returns { agreed, price, turns, reason }.
 */
export async function negotiate({ deal, mandate, sellerMin, emit = () => {} }) {
  const marketPrice = await getMarketPrice({ title: deal.title, category: deal.category });
  const turns = [];
  const brief = `Deal: ${deal.title}\nDeliverables: ${deal.deliverables.join("; ")}`;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const side of ["buyer", "seller"]) {
      const lastOther = [...turns].reverse().find((t) => t.side !== side);

      const decision = await askJSON({
        system: side === "buyer" ? buyerSystem({ maxBudget: mandate.maxBudget, marketPrice }) : sellerSystem({ minPrice: sellerMin, marketPrice }),
        user: `${brief}\n\nRound ${round}/${MAX_ROUNDS}.\nConversation so far:\n${transcriptText(turns)}\n\nYour move.`,
      });

      let price = Number(decision.price);
      let action = decision.action === "accept" && lastOther ? "accept" : "offer";
      let blocked = null;

      if (action === "accept") price = lastOther.price;
      if (!Number.isFinite(price) || price <= 0) {
        price = lastOther?.price ?? (side === "buyer" ? mandate.maxBudget * 0.5 : sellerMin * 1.5);
      }

      // Hard limits, enforced in code. Messages stay generic so neither secret leaks.
      if (side === "buyer") {
        const check = checkMandate(mandate, { amount: price, category: deal.category });
        if (!check.ok) {
          blocked = "Capped by buyer mandate (enforced in code)";
          price = Math.min(price, mandate.maxBudget);
          action = "offer";
        }
      } else if (price < sellerMin) {
        blocked = "Capped by seller floor (enforced in code)";
        price = sellerMin;
        action = "offer";
      }

      price = Math.round(price * 100) / 100;
      const turn = { round, side, action, price, message: String(decision.message || ""), blocked };
      turns.push(turn);
      emit({ type: "turn", turn });

      if (action === "accept") {
        // Final safety check on both sides before declaring a deal.
        const buyerOk = checkMandate(mandate, { amount: price, category: deal.category }).ok;
        const sellerOk = price >= sellerMin;
        if (buyerOk && sellerOk) {
          emit({ type: "agreed", price });
          return { agreed: true, price, turns };
        }
      }
    }
  }

  // No agreement within the round limit: settle only if the last offers overlap.
  const lastBuyer = [...turns].reverse().find((t) => t.side === "buyer");
  const lastSeller = [...turns].reverse().find((t) => t.side === "seller");
  if (lastBuyer && lastSeller && lastBuyer.price >= lastSeller.price) {
    const price = Math.round(((lastBuyer.price + lastSeller.price) / 2) * 100) / 100;
    const buyerOk = checkMandate(mandate, { amount: price, category: deal.category }).ok;
    if (!buyerOk || price < sellerMin) {
      emit({ type: "no_deal" });
      return { agreed: false, price: null, turns, reason: "Overlap price violates a confidential limit" };
    }
    emit({ type: "agreed", price });
    return { agreed: true, price, turns };
  }
  emit({ type: "no_deal" });
  return { agreed: false, price: null, turns, reason: "No overlap after maximum rounds" };
}
