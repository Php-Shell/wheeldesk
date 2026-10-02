# Wheel Desk

A local-first, paper-only options wheel planning ledger. It does not place broker orders or promise investment outcomes.

## Local run

Requires Node 18+.

```bash
npm test
npm run check
npm run dev
# http://localhost:4173
```

## Netlify deployment

Build settings are already in `netlify.toml` (`publish = .`, functions in `netlify/functions`). Set these **Netlify environment variables** (do not put provider secrets in browser code):

- `SUPABASE_URL` — project URL, e.g. `https://PROJECT.supabase.co`
- `SUPABASE_ANON_KEY` — public anon key used by the server to verify bearer sessions
- `FINNHUB_API_KEY` — optional quote provider key
- `TRADIER_API_KEY` — optional quote/options provider key
- `TRADIER_BASE_URL` — optional, defaults to `https://api.tradier.com`

The market function requires `Authorization: Bearer <Supabase access token>`, validates symbols and `kind=quote|options`, verifies the bearer against Supabase `/auth/v1/user`, fetches only fixed provider endpoints, returns provider timestamps, caches for 60 seconds in memory, and reports unavailable/error states honestly. It does not accept arbitrary URLs. Finnhub quotes do not include greeks; options/greeks are available only when Tradier returns them.

Run `supabase/schema.sql` in the Supabase SQL editor. Enable email auth and set the Supabase Site URL/redirect URL to the Netlify URL. The shipped browser auth uses `window.WHEEL_SUPABASE_URL` and `window.WHEEL_SUPABASE_ANON_KEY`; add those values in a deployment-injected script before `src/app.js` if enabling browser auth. Never expose a service-role key. The schema includes owner-scoped RLS for settings, watchlist, wheels, trades, dividends, snapshots, wheel events, journal, and a per-user state sync row.

## Implemented behavior

- Browser email sign-up/sign-in/sign-out and persisted access session when deployment variables are supplied.
- Local per-browser cache; offline edits remain available. Explicit sync posts the signed-in user's state to `user_state`; failures are shown rather than silently overwriting local data.
- JSON backup and CSV export of wheels.
- Authenticated Netlify Finnhub/Tradier proxy with input validation, timestamp, cache status, provider/error/unavailable state, and no fabricated greeks.
- Manual recovery assistant scenario thresholds and a roll calculator.
- Pure sizing, collateral, partial-close, roll, equity-unknown, CSV, import validation tests.

## Limitations

The browser auth configuration injection is deployment-specific; no credentials are bundled. Conflict merge UI, Supabase schema execution, exchange holiday calendars, broker integration, and real-time market UI are not claimed as complete. Supabase `market_cache` is read-only by design; the current proxy uses short-lived function memory cache rather than persisting provider data to that table. Test with provider terms and paper data before use.
