# BotXchange Backend

Node.js + TypeScript + Express + PostgreSQL (Prisma) backend for the BotXchange
frontend. Implements the exact API contract the frontend's `src/api/client.ts`
expects, plus real integration with the **Delta Exchange India** REST API.

## What's included

- Email/password auth (JWT in an httpOnly cookie)
- **Both "Demo" and "Real" accounts are genuine Delta Exchange India accounts.**
  "Demo" is connected to Delta's **testnet** (`testnet.delta.exchange` — paper
  money, same real matching engine), "Real" is connected to production.
  Both require the user to paste an API key/secret via `POST /exchange/connect`
  with `mode: "demo"` or `mode: "real"` — there is no auto-created fake demo
  account anymore, and no local balance simulation. Balances, orders, and
  positions for "demo" accounts are just as real as "real" ones, just on
  paper money.
- Market data (products, live tickers, candles) proxied from Delta Exchange
- Order placement/cancellation and positions — real signed requests to
  Delta Exchange (testnet or production depending on the account)
- Multi-timeframe trend-following bot engine (cron-based) — **demo-mode
  bots place real orders on Delta's testnet automatically**, using an EMA
  crossover (entry timing) confirmed by a higher timeframe's trend
  direction and an RSI filter, with a fixed stop-loss and take-profit per
  trade. Real-mode bots are created but order placement is intentionally
  left as a clearly-marked no-op in `src/services/botEngine.ts` until
  you've watched the strategy run on testnet and reviewed it yourself.
  Custom bot params (not just the three presets) are respected too.
  **This is not a profit guarantee** — see the header comment in
  `botEngine.ts` for the full disclaimer.
- A single WebSocket endpoint (`/ws`) for live ticker + order/bot updates
- **Hardening:** helmet security headers, rate limiting (stricter on
  `/auth`), request timeouts + safe retries on Delta API calls (GET only —
  POST/DELETE order calls are never silently retried, to avoid ever
  double-placing or double-cancelling an order on a network hiccup),
  graceful shutdown on Render redeploys, and structured logging
  (`src/utils/logger.ts`).
- Validation errors (missing/invalid fields) now return a clear `400` with
  the actual reason instead of a generic `500` — see `middleware/errorHandler.ts`.

## Getting a testnet API key (for Demo accounts)

1. Go to https://testnet.delta.exchange and create an account (separate
   from your real Delta Exchange India account).
2. Generate an API key/secret there with "Trading" + "Read" permissions.
3. In the app, use "Connect a trading account" → Demo, and paste that
   testnet key/secret. Test funds are credited automatically when the
   testnet account is created; top up further directly on that site if
   needed (there's no API-based faucet).

For a **Real** account, do the same on https://india.delta.exchange with a
key that has "Trading" permission and explicitly **not** "Withdrawal".

## Local setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
npx prisma db push     # creates the tables in your database from schema.prisma
npm run dev
```

(`prisma db push` syncs the schema directly and needs no migration files —
the simplest option while the schema is still evolving. Once the schema
stabilizes, switch to `prisma migrate dev` to get versioned migrations.)

**Already have a database from an earlier version?** Re-run
`npx prisma db push` after pulling — it adds `Order.realizedPnl`, used by
the bot performance endpoint to compute profit over a date range instead
of only ever returning the bot's all-time total. Orders placed before
this column existed will just read as `null` (treated as 0) for that
field, so range-based profit for old trades will be incomplete — there's
no way to retroactively know a number that was never recorded.

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY (must be exactly this — 32 bytes)
```

The server runs on `http://localhost:4000`, with the API mounted under `/api`
— matching `VITE_API_BASE_URL=http://localhost:4000/api` in the frontend.
(Port 4000, not 3000, because the frontend's own dev server is hard-coded to
port 3000 — see `frontend/package.json`'s `dev` script — so the two would
otherwise fight over the same port when both run locally at once.)

## Deploying to Render.com

**Option A — Blueprint (recommended):**
1. Push this folder to a GitHub repo.
2. In Render, choose "New +" → "Blueprint" and point it at the repo — it will
   read `render.yaml` and provision both the free Postgres database and the
   web service automatically.
3. After the first deploy, go to the web service's Environment tab and set
   `CORS_ORIGINS` to your actual frontend URL (comma-separated if you have
   more than one, e.g. your AI Studio preview URL and your custom domain).
4. Double-check the auto-generated `ENCRYPTION_KEY` is a 64-character hex
   string — if Render generated something else, replace it manually using
   the command above and redeploy.

**Option B — Manual:**
1. Create a free PostgreSQL instance on Render, copy its "Internal Connection
   String" into `DATABASE_URL`.
2. Create a new Web Service from the repo, with:
   - Build command: `npm install --include=dev && npm run build && npx prisma db push`
   - Start command: `npm start`

   The `--include=dev` matters: Render sets `NODE_ENV=production` during the
   build, which makes plain `npm install` skip devDependencies (including
   `typescript`, `@types/*`, and `prisma`) — without this flag the build
   fails with "Cannot find name 'Buffer'"-style TypeScript errors.
3. Add the environment variables from `.env.example` in the Environment tab.

## Connecting the frontend

In the frontend project, set:
```
VITE_API_BASE_URL=https://<your-render-service>.onrender.com/api
```
and in `src/api/client.ts`, flip `USE_MOCK = false`.

## Verifying Delta Exchange integration

This client (`src/services/deltaClient.ts`) implements HMAC-SHA256 request
signing exactly as documented by Delta Exchange India, and has been checked
against their public client libraries for the signature format. That said,
exchange APIs evolve — before connecting a real funded account, sanity-check
the endpoints against the current spec at
https://docs.delta.exchange/api/swagger_v2.json, ideally using a small test
key with only "Read" + "Trading" permission (never "Withdrawal").

## Safety notes

- Real-mode bot trading is intentionally not auto-enabled (see
  `src/services/botEngine.ts`) — review the strategy logic first.
- API secrets are never sent back to the frontend after the initial connect.
- This is a reference implementation of a trend-following strategy, not a
  proven trading edge. No strategy can guarantee profit — backtest it
  against historical data and test thoroughly on the demo account before
  ever considering real funds.
