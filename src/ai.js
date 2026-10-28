// Any OpenAI-compatible model: Groq (free tier), Gemini (free tier),
// OpenRouter, Ollama (local, no key) — no Claude needed.
// Config: AI_BASE_URL + AI_API_KEY + AI_MODEL (see .env.example).
import "dotenv/config";

const BASE = (process.env.AI_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const KEY = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || "";
export const MODEL = process.env.AI_MODEL || "llama-3.3-70b-versatile";

async function chatText({ system, user, maxTokens, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 0.7,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const err = new Error(`AI request failed (${res.status})`);
      err.status = res.status >= 500 ? 502 : res.status;
      throw err;
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    return (msg.content && msg.content.trim()) ? msg.content : (msg.reasoning || "");
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("Model timeout"), { status: 502 });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Ask the model for a JSON object. Retries once on malformed output. Never hangs: 25s timeout. */
export async function askJSON({ system, user, maxTokens = 600, timeoutMs = 25000 }) {
  if (!KEY) {
    throw Object.assign(
      new Error("Missing AI_API_KEY in .env — grab a free one from Groq, Gemini or OpenRouter, or run Ollama locally"),
      { status: 500 }
    );
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await chatText({
      system: `${system}\n\nRespond with ONE valid JSON object and nothing else.`,
      user,
      maxTokens,
      timeoutMs,
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* retry */
      }
    }
  }
  throw Object.assign(new Error("Model did not return valid JSON"), { status: 502 });
}
