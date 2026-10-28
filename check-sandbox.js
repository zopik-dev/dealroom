import "dotenv/config";

const BASE = process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
const ID = process.env.PAYPAL_CLIENT_ID;
const SECRET = process.env.PAYPAL_CLIENT_SECRET;

if (!ID || !SECRET) {
  console.log("NO KEYS: вставь PAYPAL_CLIENT_ID и PAYPAL_CLIENT_SECRET в .env");
  process.exit(1);
}

const basic = Buffer.from(`${ID}:${SECRET}`).toString("base64");
const res = await fetch(`${BASE}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});

if (!res.ok) {
  console.log("ОШИБКА:", res.status, await res.text());
  console.log("Проверь: Sandbox таб, а не Live, и что скопировал Secret целиком.");
  process.exit(1);
}

const data = await res.json();
console.log("OK: песочница работает. Токен получен, действует", data.expires_in, "сек.");
