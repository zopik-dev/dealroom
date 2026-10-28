# DEALROOM

**Two AI agents negotiate the price. PayPal holds the money. An AI arbiter decides when to release it.**

Built for the PayPal AI Hackathon.

## The problem

Buying from a stranger (a freelance job, a custom item, a small service) means two annoying things: haggling takes time, and someone has to trust someone. Disputes are slow and subjective.

## How it works

1. **Negotiation.** Buyer and seller each have a private agent with a secret limit (the buyer's max, the seller's min). The agents haggle live; you watch the conversation stream in.
2. **Hold.** On agreement, DEALROOM creates a PayPal order with `intent=AUTHORIZE`. The buyer approves, funds are held, nothing is paid out yet.
3. **Delivery.** The seller submits the work.
4. **Arbitration.** An AI arbiter checks the delivery against the agreed deliverables, one by one, and explains its decision:
   - all met → full **capture** (seller is paid)
   - some met → **partial capture** (seller is paid proportionally, the rest returns to the buyer)
   - none met → **void** (buyer is not charged)

### Buyer mandate (agent safety)

The buyer's agent runs under a **mandate**: budget cap, allowed category, expiry. It is enforced **in code**, not in the prompt, so the agent cannot commit above the cap no matter what the model says. The seller's floor is protected the same way.

## PayPal APIs used

- Orders v2: create order (`intent=AUTHORIZE`), authorize
- Payments v2: capture (full and partial), void authorization

All against the **PayPal sandbox**.

## AI tools used

| Tool | Where | What it does |
|------|-------|--------------|
| Claude (Anthropic API, model set by `AI_MODEL`) | `src/agents.js` | Powers the buyer and seller negotiation agents. Each agent gets its own system prompt with a private limit and replies with structured JSON (`offer` / `accept`, price, message). |
| Claude (Anthropic API) | `src/arbiter.js` | Acts as the escrow arbiter. Checks the seller's submission against each agreed deliverable and returns a verdict and a release percentage. |

Money never moves on the model's word alone: price limits are checked in `src/mandate.js` and `src/agents.js`, and the arbiter's output is normalised in code before any PayPal call is made.

## Run it

Requirements: Node.js 18+, a free PayPal developer account, an Anthropic API key (or swap `src/ai.js` for any model).

```bash
git clone <this repo>
cd dealroom
npm install
cp .env.example .env   # fill in the keys
npm start
```

Get sandbox credentials at https://developer.paypal.com/dashboard/applications/sandbox (create an app, copy Client ID and Secret). Pay with a **sandbox buyer account** from the same dashboard.

### Try it with curl

```bash
# 1. create a deal
curl -s localhost:3000/api/deals -H 'content-type: application/json' -d '{
  "title": "Logo design for a coffee shop",
  "category": "design",
  "deliverables": ["Logo in SVG", "Logo in PNG 1024px", "Two color variants"],
  "buyerMax": 100,
  "sellerMin": 60
}'

# 2. watch the agents negotiate (SSE); the last event contains the PayPal approveUrl
curl -N localhost:3000/api/deals/<id>/events

# 3. open approveUrl, log in with a sandbox buyer, approve

# 4. seller delivers
curl -s localhost:3000/api/deals/<id>/deliver -H 'content-type: application/json' \
  -d '{"submission":"Delivered logo.svg and logo.png (1024px). Two color variants: dark and light."}'

# 5. arbiter decides and money moves
curl -s -X POST localhost:3000/api/deals/<id>/judge
```

## For judges: testing

- Hosted demo: _TODO: add Render URL_
- Sandbox buyer account for the PayPal approval step: _TODO: add test email and password_
- Everything runs against the PayPal sandbox, so no real money is involved.

## Status

Backend flow, web UI, and Channel3 market-price lookup are in place. `getMarketPrice` in `src/agents.js` calls the Channel3 universal product catalog and feeds a real market reference into both agents' prompts. Render deployment is configured via `render.yaml` (free web service).

## License

MIT
