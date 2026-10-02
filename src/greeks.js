// Black-Scholes greeks. DOM-free and shared by the browser (manual fallback)
// and the Netlify function (when a provider returns IV but no greeks).
// These are model estimates, always labelled as such in the UI.

export function normCdf(x) {
  // Abramowitz & Stegun approximation of the standard normal CDF.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

export function normPdf(x) {
  return 0.3989422804014327 * Math.exp((-x * x) / 2);
}

export function blackScholes({ type = 'put', S, K, daysToExpiry, iv, rate = 0.045 } = {}) {
  const s = Number(S);
  const k = Number(K);
  const d = Number(daysToExpiry);
  const sigma = Number(iv) / 100; // accept IV as a percent
  if (!(s > 0) || !(k > 0) || !(d > 0) || !(sigma > 0)) return null;
  const T = d / 365;
  const r = rate;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(s / k) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);
  const isCall = type === 'call';
  const price = isCall ? s * normCdf(d1) - k * disc * normCdf(d2) : k * disc * normCdf(-d2) - s * normCdf(-d1);
  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (s * sigma * sqrtT);
  const vega = (s * normPdf(d1) * sqrtT) / 100; // per 1% change in IV
  const thetaAnnual = -(s * normPdf(d1) * sigma) / (2 * sqrtT) + (isCall ? -r * k * disc * normCdf(d2) : r * k * disc * normCdf(-d2));
  const theta = thetaAnnual / 365; // per day
  const rho = isCall ? (k * T * disc * normCdf(d2)) / 100 : (-k * T * disc * normCdf(-d2)) / 100;
  return { price, delta, gamma, theta, vega, rho };
}
