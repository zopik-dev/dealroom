// Thin wrapper over PayPal Orders v2 (sandbox).
// Flow: createOrder (intent AUTHORIZE) -> buyer approves -> authorizeOrder
//       -> capture (full or partial) | void.
import "dotenv/config";

const BASE = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";

let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.value;
  }
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error("Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env");
  }
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.value;
}

async function paypal(path, { method = "POST", body, requestId } = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (requestId) headers["PayPal-Request-Id"] = requestId; // idempotency
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(`PayPal ${method} ${path} -> bad response`);
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`PayPal ${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

const money = (amount, currency = "USD") => {
  const v = Number(amount);
  if (!Number.isFinite(v) || v <= 0) {
    throw Object.assign(new Error("Bad amount"), { status: 400 });
  }
  return { currency_code: currency, value: v.toFixed(2) };
};

/** Step 1: create an order that will only be AUTHORIZED (funds held), not captured. */
export async function createOrder({ dealId, title, amount, currency = "USD", returnUrl, cancelUrl }) {
  const order = await paypal("/v2/checkout/orders", {
    requestId: `order-${dealId}-${Number(amount).toFixed(2)}`,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: dealId,
          description: title.slice(0, 127),
          amount: { ...money(amount, currency) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            user_action: "PAY_NOW",
            brand_name: "DEALROOM",
          },
        },
      },
    },
  });
  const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  return { orderId: order.id, status: order.status, approveUrl };
}

/** Step 2: after the buyer approves in PayPal, place the hold. Returns the authorization id. */
export async function authorizeOrder(orderId) {
  const res = await paypal(`/v2/checkout/orders/${orderId}/authorize`, { requestId: `auth-${orderId}` });
  const auth = res.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error("No authorization returned by PayPal");
  return { authorizationId: auth.id, status: auth.status, expiresAt: auth.expiration_time };
}

/** Release funds to the seller. Pass `amount` for a partial capture. */
export async function capture({ authorizationId, amount, currency = "USD", final = true, dealId }) {
  const body = { final_capture: final };
  if (amount !== undefined) body.amount = money(amount, currency);
  const res = await paypal(`/v2/payments/authorizations/${authorizationId}/capture`, {
    requestId: `cap-${dealId}-${amount !== undefined ? Number(amount).toFixed(2) : "full"}`,
    body,
  });
  return { captureId: res.id, status: res.status, amount: res.amount };
}

/** Release the hold: buyer is not charged. */
export async function voidAuthorization({ authorizationId }) {
  const res = await paypal(`/v2/payments/authorizations/${authorizationId}/void`, { requestId: `void-${authorizationId}` });
  return { status: res.status ?? "VOIDED", id: res.id };
}

export async function getOrder(orderId) {
  return paypal(`/v2/checkout/orders/${orderId}`, { method: "GET" });
}
