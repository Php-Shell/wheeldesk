// Public runtime configuration. Only the Supabase anon key is exposed here,
// which is safe by design because every table is protected by Row Level
// Security. Service-role keys must never be returned from this function.
export default async () =>
  new Response(
    JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      providers: {
        finnhub: Boolean(process.env.FINNHUB_API_KEY),
        cboe: true,
        yahoo: true,
        marketdata: Boolean(process.env.MARKETDATA_TOKEN),
        tradier: Boolean(process.env.TRADIER_API_KEY),
      },
      authRequired: false,
    }),
    { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } },
  );
