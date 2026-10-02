# Wheel Desk

A beginner-friendly dashboard for running the **cash-secured put + wheel** strategy on a small budget. It helps you **screen** a ticker, **size** a trade, **record** it, and **recover calmly** if you get assigned.

> Educational tool, not financial advice. Data may be delayed or inaccurate. Always verify in your broker before trading. Wheel Desk never places orders or connects to your broker.

---

## What it does

| Area | What you get |
| --- | --- |
| **Dashboard** | Budget, available cash, collateral, premiums, realized/unrealized P&L, return %, win rate, "Today's actions", and 4 charts (net worth, premium income, P&L by ticker, allocation). |
| **Screener** | **Auto-scan & rank**: loads live fundamentals + free option chains for your watchlist or a set of safe ideas, scores each against the checklist, and ranks the best puts. Also lets you inspect any ticker manually. |
| **Risk profiles** | One-click Safest / Balanced / Higher-income presets that set every threshold for you, with plain-English explanations. |
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
| `FINNHUB_API_KEY` | your Finnhub key | ✅ yes |
| `SUPABASE_URL` | your Supabase project URL | optional (sync only) |
| `SUPABASE_ANON_KEY` | your Supabase **anon** key | optional (sync only) |
| `MARKETDATA_TOKEN` | MarketData.app token | optional |
| `TRADIER_API_KEY` | Tradier developer key | optional |
| `TRADIER_BASE_URL` | `https://api.tradier.com` | optional |

Then **Deploys → Trigger deploy → Clear cache and deploy site**.

> Never put a Supabase **service-role** key in these variables. Only the **anon** key is safe, and only because RLS is enabled.

### 5. First run
**No login needed.** Open your Netlify URL and start using it immediately — data loads right away. You only need to sign in if you want to sync your ledger to Supabase across devices (avatar top-right).

1. On the Dashboard, pick a **risk profile** (Safest / Balanced / Higher income).
2. Open the **Screener** and press **⚡ Scan safe ideas** — it loads live data and free option chains, ranks the best puts, and shows a score.
3. Click **Open wheel →** on a good candidate and follow the 5-step wizard.
4. Or use **Settings → Load demo data** to explore three fictional wheels first.

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

1. **Choose a risk profile** on the Dashboard (or Settings). This sets every threshold for you.
2. **Screener → Auto-scan & rank** has three curated groups — **Safe income ideas**, **ETFs** and **Cheaper / higher risk** (e.g. ACHR, SOFI, RIVN) — plus *Scan my watchlist*. It loads live data + free chains (slim mode, throttled to respect the free API limits), checks affordability, and ranks the best puts. A **progress bar and a live console** show exactly what it is doing for each ticker, and a **Why/notes** column explains each verdict ("A4 Not in a severe downtrend · B10 Bid-ask spread is tight"). It picks an expiry that **expires before the next earnings date** so item C14 passes, and hides "Avoid" rows by default (tick the box to see them with reasons).
3. Open a ticker to see the 18-point checklist. Confirm the two manual items ("I'd happily own it", "not a meme / IPO / biotech / leveraged ETF"); the rest fills from live data. **Load free chain (greeks)** auto-fills real put strikes.
4. If the verdict is *Good candidate*, press **Open a wheel with this setup**.
5. **New wheel wizard** → a 5-step flow with a step progress bar. Step 1 loads and shows the ticker's price, market cap, TTM EPS, next earnings and 200-DMA; step 2 shows your per-wheel limit and a **live calculation preview** (net premium, collateral, return, annualized, breakeven, probability OTM) that updates as you type; step 3 reviews the risk incl. maximum loss; step 4 gives exact IBKR instructions; step 5 logs the real fill. Opening it from the Screener ("Open a wheel with this setup") prefills the ticker/strike/expiry/premium and now advances correctly.
6. **Wheels** → the app tells you the next step (take profit at ~50%, roll near 21 DTE, avoid earnings). Use the action buttons for every event (buy to close, roll, expired, assigned, sell call, called away, dividend, sell shares, close).
7. If assigned → **Recovery**. It gathers the numbers, classifies the situation (A/B/C/D), compares covered calls and recovery time, and lets you **sell the chosen call in one click** to start wheeling the shares back out. If you need more time → **Roll**.
8. **Journal** → monthly summaries, closed-wheel lessons, CSV/JSON export.

---

## Data sources & honest limitations

- **Finnhub (free)** provides the quote, company profile, market cap, trailing EPS, average volume, 52-week range, earnings dates and dividend dates. Every value shows its source and timestamp.
- **Options chains with greeks come from CBOE** (free, **no signup, no API key**). Press **Load CBOE chain (greeks)** in the Screener and it fills the strike picker with real puts — bid, ask, delta, IV, open interest, volume and mid — picking the expiry closest to 40 DTE and the strikes nearest delta 0.22. CBOE data is **delayed ~15 minutes**. Coverage is CBOE-listed US stocks/ETFs; if your symbol is not listed, the app says so and you enter values manually.
- **IBKR**: your account has chains and greeks, but they cannot be fetched from a Netlify function — the TWS API needs a local TWS/IB Gateway socket, the Client Portal Web API needs a locally-running gateway or interactive OAuth + a market-data subscription, and OPRA options data is usually a paid add-on. So IBKR stays a **manual entry / verification** source here, not an automated one. (If you ever want it, the realistic option is a small local companion app on your own computer, not a hosted function.)
- **Nasdaq** (free, no key) is the primary fallback for **historical daily prices** (200-day average + average volume), **dividends** (latest/next ex-dividend date) and **consolidated option open interest** (`api.nasdaq.com`). Finnhub's free plan blocks candles and dividends (403), so this is what makes items A4/A5 and the ex-dividend field usually fill automatically. When Nasdaq only knows the last ex-date, the app forecasts the next one from the quarterly pattern and labels it **(est.)**.
- **Open interest (B9)**: CBOE only reports *its own exchange's* OI, which badly understates NYSE/ARCA names. The proxy merges in Nasdaq's consolidated (OPRA) OI, and the strike picker prefers the most liquid expiry (highest put OI) and strikes that actually have OI — this is why B9 used to read "0". B9 always uses the OI of **your exact strike**, not the Put/Call ratio or the Call/Put OI totals; the link now goes to the Finviz option chain where each contract shows its own OI.
- **A3 (profitable?)**: uses **trailing-12-month EPS computed from the last 4 reported quarters**, which is usually more faithful than a vendor's single TTM number; if the quarters are incomplete it falls back to Finnhub's TTM and warns if the two disagree in sign.
- **A4 (downtrend)**: being slightly below the 200-day average is normal, not a "severe downtrend". The tolerance is configurable in Settings (`A4 pass: within % of 200-DMA`, default −5%; `A4 fail: below %` default −10%). At/above the pass threshold it's a **pass**; in between it's a **warn**; below the fail threshold it's a **fail**.
- **C11 (delta)**: compares the **rounded** delta, so a contract shown as 0.30 (actual 0.3049) is inside the default 0.15–0.30 band and **passes**.
- **C15 (dividends)**: resolves the status instead of leaving it "not verified" — **no dividend → pass** ("nothing to watch"), **dividend with a known/estimated ex-date → pass**, **pays but the date wasn't found → warn** with the Nasdaq link. It uses Finnhub's dividend yield to tell payers from non-payers.
- **C12 (IV Rank)**: enter **MarketChameleon's "IV Percentile Rank" (0–100)** — e.g. 87 means IV was lower 87% of the last year. Yahoo doesn't show IV Rank.
- **Yahoo Finance chart** (free, no key) is the fallback for the **underlying quote**, the **200-day average** and **average volume** if Nasdaq does not respond. So items A4/A5 resolve automatically in almost all cases.
- **Provider order for chains:** CBOE → Tradier (if key) → MarketData.app (if token) → Yahoo. The app shows which provider was used.
- **Greeks:** CBOE and MarketData.app return exchange greeks. If only IV is available (e.g. Yahoo), the app **computes delta/gamma/theta/vega with Black-Scholes** and labels them as estimates. Same calculator powers the `src/greeks.js` unit tests.
- **MarketData.app** is an optional token-based provider with real greeks; set `MARKETDATA_TOKEN` to enable it as a fallback.
- **Tradier** remains an optional fallback (`TRADIER_API_KEY`).
- **IV Rank** is not available from free data (it needs a year of IV history). The app shows the actual IV from the chain and keeps IV Rank as a manual field. Item C12 stays "Not verified" until you enter it — it never guesses.
- **200-day moving average**: Finnhub's free plan often blocks daily candles; the Yahoo fallback covers it. If both fail, item A4 stays "Not verified" and you can add a short written override.
- **Manual fallback everywhere**: the Screener has a **Manual / override values** panel. Each field is tagged with the checklist item it feeds (e.g. *Next ex-dividend date **C15***, *Price vs 200-DMA **A4***, *IV Rank **C12***). Anything you type **overrides** the fetched value, **auto-saves as you type**, and re-runs the checklist live. Every manual field and every checklist item has a **"find ↗"** link straight to the right page (Yahoo statistics, TradingView/StockCharts for the chart, Nasdaq earnings/dividends, Yahoo options).
- **"✎ manual entry ↓" buttons**: when a checklist item is ❔ *Not verified*, click its manual-entry button and the page scrolls to the matching field, highlights it (pulsing blue outline), and focuses it. As soon as you type, it saves automatically, the highlight clears, and the checklist item updates live. Dates are entered and shown as **DD/MM/YYYY** (internally stored as ISO for correct comparisons).
- **Price trend chart**: the Screener draws a sparkline of the last ~120 daily closes with the 200-day average line, plus links to the full chart, so you can judge item A4 ("not in a severe downtrend") at a glance or override it with a reason.
- **Anything that cannot be fetched stays ❔ "Not verified"**, never "Pass". Unverified critical items (price fit, happy-to-own, earnings, cash) push the verdict to *Proceed with caution* or *Avoid*.

Alternatives if CBOE coverage disappoints: **MarketData.app** (free tier, real greeks — already wired via `MARKETDATA_TOKEN`), **Alpaca** (free tier includes delayed options snapshots with greeks), or **Polygon.io** (paid for options). The provider layer in `netlify/functions/market.js` is pluggable, so any of these can be added as a fallback.

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
  market.js                authenticated Finnhub/CBOE/Tradier proxy (no keys in browser)
  config.js                public Supabase URL + anon key + provider flags
supabase/schema.sql        tables, enums, indexes, RLS policies
tests/calc.test.js         unit tests
```

---

## Security notes

- API keys live only in Netlify environment variables and are used server-side.
- The proxy validates symbols, whitelists endpoints, rate-limits requests per client, and caches responses to respect free-tier limits. A Supabase session is **optional** (verified when supplied); it is not required to load data, so a private single-user deployment works with no login.
- Supabase RLS means each user can only read/write their own rows, even though the anon key is public.
- The browser stores your ledger in `localStorage`; cloud sync is explicit (you press *Sync now*). Sync failures are shown, never silently overwritten.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "FINNHUB_API_KEY is not configured" | Add the variable in Netlify and redeploy. |
| "No quote for this symbol" | Check the ticker symbol; the app falls back to Yahoo, then asks you to enter values manually. |
| "No free chain available" | The symbol isn't listed on CBOE and Yahoo was rate-limited. Enter strike/bid/delta manually from IBKR — every calculation still works. |
| Data all shows "Not verified" | You're offline or the function failed — enter values manually; every calculation still works. |
| Sign-up email never arrives | Use a real address, or disable email confirmation in Supabase → Authentication → Providers → Email for personal use. |
| Sync says "conflict" | The cloud copy is newer. Use **Pull from cloud** in Settings to review it. |

---

## License

Personal project. Use at your own risk. Not financial advice.
