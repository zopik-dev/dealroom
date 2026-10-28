import "dotenv/config";
import { askJSON, MODEL } from "./src/ai.js";

if (!process.env.AI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.log("NO AI KEY: вставь AI_API_KEY в .env (бесплатно: Groq, Gemini, OpenRouter — примеры в .env.example)");
  process.exit(1);
}

try {
  const r = await askJSON({
    system: 'Reply JSON exactly like {"ok": true} and nothing else.',
    user: "ping",
    maxTokens: 50,
    timeoutMs: 30000,
  });
  console.log(`OK: модель отвечает (MODEL=${MODEL}). Ответ:`, JSON.stringify(r));
} catch (e) {
  console.log("ОШИБКА:", e.message);
  process.exit(1);
}
