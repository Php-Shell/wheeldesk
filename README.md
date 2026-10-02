# Wheel Desk

A beginner-friendly dashboard for running the **cash-secured put + wheel** strategy on a small budget. It helps you **screen** a ticker, **size** a trade, **record** it, and **recover calmly** if you get assigned.

> Educational tool, not financial advice. Data may be delayed or inaccurate. Always verify in your broker before trading. Wheel Desk never places orders or connects to your broker.

---

## What it does

| Area | What you get |
| --- | --- |
| **Dashboard** | Budget, available cash, collateral, premiums, realized/unrealized P&L, return %, win rate, "Today's actions", and 4 charts (net worth, premium income, P&L by ticker, allocation). |
| **Screener** | Type a ticker → loads free fundamentals (price, market cap, EPS, volume, 52-week range, earnings, dividends, 200-day average) and runs an **18-point checklist** with ✅ / ⚠️ / ❌ / ❔ and a clear verdict. |
| **New wheel wizard** | 5 guided steps: ticker → strike & expiry → honest review of the numbers → exact IBKR click path → log the real fill. |
| **Wheels** | Event-sourced ledger with a visual state machine (short put → holding → short call → complete), a dated timeline, running cost basis, and one-click actions (buy to close, roll, assigned, sell call, called away, dividend, sell shares, close). |
| **Recovery assistant** | If you're stuck holding shares: computes your adjusted cost basis, classifies A/B/C/D, compares covered-call candidates and recovery time, and gives plain-English exit instructions. |
| **Roll calculator** | Net credit/debit after fees with a ✅ / ⚠️ / ❌ verdict. |
| **Journal & ledger** | Full sortable/filterable trade log, monthly summaries, closed-wheel archive with lessons, CSV + JSON export. |
| **Learn** | Plain-English guide to puts, assignment, delta, theta, IV, DTE, rolling, cost basis, early assignment, and the golden rules. |
| **Settings** | Budget, currency, all strategy thresholds, data providers with a test button, Supabase sync, backups, and a built-in calculation self-test. |

The app is **light by default** (a dark toggle is in the sidebar). It works on desktop and mobile.

---

## Quick start (deploy to Netlify)

### 1. Get the code onto Netlify
1. Put this folder in a GitHub repository (or drag-and-drop the folder into Netlify).
2. In Netlify, **Add new site → Import from Git** and pick the repo.
3. Build settings are already in `netlify.toml` (publish `.`, functions in `netlify/functions`). Leave them as they are.

### 2. Create a Supabase project (free)
1. Go to <https://supabase.com> → **New project**.
2. In the left menu open **SQL Editor → New query**, paste the whole `supabase/schema.sql`, and click **Run**. This creates the tables, enums, indexes and Row Level Security policies.
3. Open **Authentication → Providers** and make sure **Email** is enabled.
4. Open **Authentication → URL Configuration** and set **Site URL** and **Redirect URL** to your Netlify address (e.g. `https://your-site.netlify.app`).
5. Open **Project Settings → API** and copy:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **anon public** key

### 3. Get a Finnhub key (free)
1. Sign up at <https://finnhub.io>.
2. Copy your API key from the dashboard.

### 4. Add environment variables in Netlify
Go to **Site configuration → Environment variables** and add these exact names:

| Name | Value | Required |
| --- | --- | --- |
| `SUPABASE_URL` | your Supabase project URL | ✅ yes |
| `SUPABASE_ANON_KEY` | your Supabase **anon** key | ✅ yes |
| `FINNHUB_API_KEY` | your Finnhub key | ✅ yes |
| `TRADIER_API_KEY` | Tradier developer key | optional |
| `TRADIER_BASE_URL` | `https://api.tradier.com` | optional |

Then **Deploys → Trigger deploy → Clear cache and deploy site**.

> Never put a Supabase **service-role** key in these variables. Only the **anon** key is safe, and only because RLS is enabled.

### 5. First run
1. Open your Netlify URL.
2. Click the avatar (top-right) → **Create account**. Confirm your email if Supabase asks, then **Sign in**.
   - *Why sign in?* The market-data proxy checks your Supabase session before calling Finnhub, so your API key is never exposed to the browser.
3. Go to **Settings → Load demo data** to explore three fictional wheels, or start with the **Screener**.

---

## Local development

Requires Node 18+ and the Netlify CLI.

```bash
npm install -g netlify-cli   # once
netlify link                 # link to your Netlify site (pulls the env vars)
npm run dev                  # http://localhost:8888
```

Useful commands:

```bash
npm test        # calculation + checklist unit tests
npm run check   # syntax-check every JS module
npm run serve   # plain static server (no functions; market data unavailable)
```

---

## How to use it (the loop)

1. **Screener** → add a ticker → press *Refresh data*. Read the fundamentals and the 18-point checklist.
2. Tick the two required manual confirmations ("I'd happily own it", "not a meme / IPO / biotech / leveraged ETF") and enter strike candidates from your IBKR chain.
3. If the verdict is *Good candidate*, press **Open a wheel with this setup**.
4. **New wheel wizard** → review the premium, collateral, breakeven, annualized return and **maximum loss**, then follow the IBKR instructions and log the real fill.
5. **Wheels** → track it. The app tells you the next step (take profit at ~50%, roll near 21 DTE, avoid earnings).
6. If assigned → **Recovery** gives you a plan. If you need more time → **Roll**.
7. **Journal** → export CSV for your records/taxes.

---

## Data sources & honest limitations

- **Finnhub (free)** provides the quote, company profile, market cap, trailing EPS, average volume, 52-week range, earnings dates and dividend dates. Every value shows its source and timestamp.
- **Options chains with greeks are NOT free.** Finnhub's option endpoints are paid. Without a Tradier developer key, the strike picker is **manual**: you type strike, bid/ask, delta, open interest and IV Rank from your IBKR screen. This is intentional — the app never invents Greeks or open interest.
- **200-day moving average**: Finnhub's free plan often blocks daily candles. If it is unavailable, item A4 stays "Not verified" and you can add a short written override.
- **Anything that cannot be fetched stays ❔ "Not verified"**, never "Pass". Unverified critical items (price fit, happy-to-own, earnings, cash) push the verdict to *Proceed with caution* or *Avoid*.
- To enable automatic option chains, add `TRADIER_API_KEY` (free Tradier developer/sandbox account). The proxy will then return delayed chains with Greeks.

---

## Calculations (tested)

All formulas live in `src/calc.js` and are covered by `npm test`. Example (also shown in **Settings → Run self-test**):

Sell a `$50` put for `$1.20`, 30 DTE, `$0.65` fee:
- Net premium = `1.20 × 100 − 0.65 = $119.35`
- Collateral = `50 × 100 = $5,000`
- Return on collateral = `2.39%`
- Annualized ≈ `29.0%`
- Breakeven = `50 − 1.1935 = $48.81`
- Max theoretical loss if the stock goes to `$0` ≈ `$4,880.65`

Adjusted cost basis = assignment price − premiums per share + fees per share − dividends per share.

---

## Project structure

```
index.html                 app shell + hash router entry
netlify.toml               publish dir, functions, redirects, SPA fallback
src/
  app.js                   router, context, global controls
  calc.js                  all financial formulas + self-test
  checklist.js             18-point screening checklist
  store.js                 state, persistence, actions, demo data
  providers.js             market-data client (calls the proxy)
  supabase.js              auth + cloud sync
  export.js                CSV + JSON backup/import
  format.js                money / percent / date-time / market status
  ui.js                    toast, modal, badges, charts
  views/                   dashboard, screener, newWheel, wheels, recovery,
                           roll, journal, learn, settings
netlify/functions/
  market.js                authenticated Finnhub/Tradier proxy (no keys in browser)
  config.js                public Supabase URL + anon key + provider flags
supabase/schema.sql        tables, enums, indexes, RLS policies
tests/calc.test.js         unit tests
```

---

## Security notes

- API keys live only in Netlify environment variables and are used server-side.
- The proxy validates symbols, whitelists endpoints, verifies your Supabase session on every call, and caches responses to respect free-tier limits.
- Supabase RLS means each user can only read/write their own rows, even though the anon key is public.
- The browser stores your ledger in `localStorage`; cloud sync is explicit (you press *Sync now*). Sync failures are shown, never silently overwritten.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Screener says "Sign in to load live market data" | Create/sign in to an account (top-right avatar). Live data needs a session. |
| "FINNHUB_API_KEY is not configured" | Add the variable in Netlify and redeploy. |
| "No quote for this symbol" | Check the ticker symbol; some symbols aren't covered by Finnhub free. |
| Data all shows "Not verified" | You're offline or the function failed — enter values manually; every calculation still works. |
| Sign-up email never arrives | Use a real address, or disable email confirmation in Supabase → Authentication → Providers → Email for personal use. |
| Sync says "conflict" | The cloud copy is newer. Use **Pull from cloud** in Settings to review it. |

---

## License

Personal project. Use at your own risk. Not financial advice.
