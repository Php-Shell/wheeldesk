// Practical, click-by-click checklists for IBKR Desktop, with tickable steps.
import { escapeHtml } from '../format.js';

const PUT_PHASES = [
  { title: 'Phase 0 — Before you open IBKR', note: 'Example: XYZ trades at $47.30. Budget $10,000, 1 put, $44 strike, 38 DTE.', items: [
    '0.1 Timing: trade 10:00–15:30 ET, Mon–Fri. Avoid the first 30 minutes and the last 30. Never pre/after-hours.',
    '0.2 Earnings date: look it up (IBKR quote → Events/Calendar, or nasdaq.com). Earnings must be AFTER your expiry, else pick another expiry/ticker.',
    '0.3 Cash: max per wheel = 50% of $10,000 = $5,000 → max strike $50. Keep your cash above the 10% reserve ($1,000).',
  ], table: [['Figure', 'Example'], ['Max per wheel (50%)', '$5,000 → max strike $50'], ['Reserve to keep (10%)', '$1,000']] },
  { title: 'Phase 1 — Open the option chain', items: [
    '1.1 Launch IBKR Desktop → login → choose Paper Trading (paper username/password).',
    '1.2 Search bar → type XYZ → pick the stock result (NYSE/NASDAQ). Not a CFD or foreign listing.',
    '1.3 On the quote page click Options / Option Chain.',
    '1.4 Columns (gear ⚙️ → Customize): Strike, Bid, Ask, Delta, Open Interest, Volume, Implied Vol.',
    '1.5 Make sure you are on the PUTS side (puts are usually the right side of the strikes).',
  ], table: [['Column', 'What it tells you'], ['Strike', "Price you'd buy the stock at"], ['Bid', "What buyers pay now (you'd sell here)"], ['Ask', 'What sellers want now'], ['Delta', 'Risk level / chance of assignment'], ['Open Interest', 'Liquidity (contracts existing)'], ['Volume', 'Contracts traded today']] },
  { title: 'Phase 2 — Pick the expiry', items: [
    '2.1 Click expiry tabs at the top of the chain.',
    '2.2 Choose one 30–45 days out. Monthly expiries (3rd Friday) usually have the best liquidity.',
    '2.3 Double-check this expiry is BEFORE the earnings date from 0.2.',
  ] },
  { title: 'Phase 2.5 — Screen the chain in THIS exact order', note: 'You are staring at a wall of lines. Do these in order and stop as soon as one fails — that is how you go from 200 rows to 1 candidate.', items: [
    'Step A — Stock level first: is the next earnings date AFTER your chosen expiry? If not, stop and choose another expiry or ticker.',
    'Step B — Expiry: pick 30–45 DTE (monthly 3rd Friday preferred). From now on, look only inside this one expiry block.',
    'Step C — Direction: PUTS only, and only strikes at or below the current stock price. Ignore every line above the price.',
    'Step D — DELTA first (the fast filter): read down the strikes until |delta| is between 0.15 and 0.30 (ideal 0.15–0.25). Everything outside that range is ignored — this is the single biggest time-saver.',
    'Step E — Liquidity of that strike: Open Interest ≥ 500, THEN spread (Ask − Bid) ≤ $0.10 AND ≤ 10% of mid, THEN Volume ≥ 50. Fail any of these → try the next strike in the delta band.',
    'Step F — Return: net premium ÷ collateral, then annualized (× 365 ÷ DTE). Target 10–30%.',
    'Step G — Gut check: happy to own 100 shares at breakeven? Yes → that is your candidate. No → next strike.',
    'Step H — Nothing passed? Widen to the next monthly expiry, relax one grade (e.g. spread to $0.10/10%), or pick another ticker. Never force a bad strike.',
  ], table: [['#', 'Look at', 'Target', 'Why first'], ['A', 'Earnings vs expiry', 'Earnings AFTER', 'A gap can ruin the whole trade'], ['B', 'Expiry', '30–45 DTE', 'Best theta, still liquid'], ['C', 'Direction + side', 'PUTS below price', 'Removes half the screen'], ['D', 'Delta', '0.15–0.30', 'Fastest way to cut the lines'], ['E', 'OI → spread → volume', '≥500 · ≤$0.10/10% · ≥50', 'So you can actually get filled'], ['F', 'Annualized return', '10–30%', 'Are you paid enough?'], ['G', 'Ownership test', 'Happy at breakeven', 'The whole strategy depends on it']] },
  { title: 'Phase 3 — Pick the strike', note: 'For XYZ at $47.30, scan puts at $47 and lower.', items: [
    '3.1 Delta between −0.15 and −0.30 (ignore the minus sign). −0.15 to −0.25 is the beginner target. 1 − |delta| ≈ chance of expiring worthless (estimate).',
    '3.2 Spread test: Spread = Ask − Bid; Mid = (Bid + Ask)/2; Spread% = Spread ÷ Mid × 100. Need ≤ $0.10 AND ≤ 10%. Example Bid 0.62 / Ask 0.68 → spread 0.06, mid 0.65, 9.2% → acceptable.',
    '3.3 Liquidity: OI ≥ 500 (100–499 borderline), Volume ≥ 50 (10–49 borderline). Example OI 1,850, Vol 210.',
    '3.4 Money math: Gross = Mid×100; Net = Gross − commission; Collateral = Strike×100; Return = Net ÷ Collateral; Annualized = Return × 365 ÷ DTE; Breakeven = Strike − net premium/share; Cushion = (Price − Strike)/Price.',
    '3.5 Final gut check: "Would I happily own 100 shares of XYZ at $43.36?" If not, stop.',
  ], table: [['Figure', 'Formula', 'Example'], ['Gross premium', 'Mid × 100', '0.65 × 100 = $65.00'], ['Net premium', 'Gross − $0.65', '≈ $64.35'], ['Collateral', 'Strike × 100', '44 × 100 = $4,400'], ['Return', 'Net ÷ Collateral', '64.35 ÷ 4,400 = 1.46%'], ['Annualized', 'Return × 365 ÷ DTE', '1.46% × 365 ÷ 38 ≈ 14.0%'], ['Breakeven', 'Strike − net/share', '44 − 0.64 = $43.36'], ['Cushion', '(Price − Strike)/Price', '7.0% below today']] },
  { title: 'Phase 4 — Place the SELL order', items: [
    '4.1 In the $44 put row click the Bid price (0.62) → creates a SELL order. Clicking Ask would create a BUY (wrong).',
    '4.2 Ticket: Action SELL · Contract XYZ [date] 44 PUT · Quantity 1 · Order type LMT · Limit 0.65 (mid) · TIF DAY · Outside RTH unchecked.',
    '4.3 Preview first: commission ≈ $0.65–1.00. IBKR margin looks tiny — ignore it, you reserve the full $4,400.',
    '4.4 Submit / Transmit.',
    '4.5 Patience ladder: after 3 min move to mid − $0.01; 3 more → mid − $0.02; then stop. Never chase below mid − 25% of the spread.',
    '4.6 Once filled, Portfolio shows XYZ 44 P, Position −1 (minus = you sold). Cash rises ~$64.',
  ], table: [['Field', 'Enter', 'Why'], ['Action', 'SELL (red)', 'Beginner mistake #1 — check twice'], ['Contract', 'XYZ … 44 PUT', 'Not CALL, right date/strike'], ['Quantity', '1', '1 contract = 100 shares obligation'], ['Order type', 'LMT', 'Never MKT on options'], ['Limit', '0.65 (mid)', 'Your price'], ['TIF', 'DAY', 'Cancels at close'], ['Outside RTH', 'unchecked', 'Regular hours only']] },
  { title: 'Phase 5 — Write it down immediately', items: [
    'Log: ticker, action (Sell to Open PUT), strike, expiry + DTE, contracts, actual fill price, commission, net premium, date/time (ET + local), stock price at fill, delta, OI/Volume, bid/ask, collateral, breakeven, earnings date, ex-div date, take-profit target (50%), 21-DTE review date, notes.',
  ] },
  { title: 'Phase 6 — Set your "walk away" GTC order right away', items: [
    '6.1 Portfolio → XYZ 44 P (−1) → right-click → Close Position (or click → Buy).',
    '6.2 Action BUY · Quantity 1 · LMT at 50% of fill rounded DOWN (0.64 → 0.32) · TIF GTC · Outside RTH unchecked.',
    '6.3 Preview → Submit. Confirm it shows under Orders as Working/Submitted with GTC.',
  ] },
  { title: 'Phase 7 — Calendar checkpoints', items: [
    'Weekly: is the GTC still working? Yes → do nothing.',
    '21 DTE: if the put is ≤ 70% of your fill price (≤ 0.45), buy to close. Cancel the GTC FIRST, then BUY LMT at the mid.',
    'Stock near the strike (within 2%): still want to own it at breakeven? Yes → hold; No → close or roll only for a net credit.',
    'Stock below the strike: assignment likely — this is the Wheel, not a failure. Open the Assignment Assistant.',
    'Expiry week: close by Thursday, or by 15:00 ET on expiry day at the latest.',
  ] },
  { title: 'Phase 8 — Log the close', items: [
    'Use the floating "Log close" tool (bottom-right) to compute gross/net P&L, return and annualized.',
    'Make sure no leftover orders remain under Orders (the GTC should be gone).',
    'Make sure the position no longer appears in Portfolio.',
    'Write the lesson learned.',
  ] },
];

const CALL_PHASES = [
  { title: 'Phase 0 — Confirm the assignment (morning after expiry)', note: 'You were assigned 100 XYZ at $44. You are in Step 2 of the Wheel, not stuck.', items: [
    '0.1 Portfolio: XYZ stock +100, the put is gone, cash lower by strike×100 ($4,400).',
    '0.2 Check the assignment commission in Trades/Activity (usually $0 for US options at IBKR).',
    '0.3 Cancel any leftover orders from the expired put.',
    '0.4 Do NOT sell anything today in a panic. Do the math first.',
  ] },
  { title: 'Phase 1 — Calculate your real position', items: [
    '1.1 Adjusted basis = (strike×100 + assignment fees − all premiums collected) ÷ 100. Example: (44.00×100 + 0 − 63.34) ÷ 100 = $43.37.',
    '1.2 Unrealized P&L = (current price − adjusted basis) × 100. Example (42.10 − 43.37) × 100 = −$127. IBKR shows the loss vs $44 — use your own number.',
    '1.3 Gap % = (basis − current) ÷ basis × 100. Example: (43.37 − 42.10) ÷ 43.37 = 2.9%.',
    '1.4 Re-check the stock: whole market fell (normal) vs company-specific bad news (see Path C). Note next earnings and ex-dividend dates.',
  ], table: [['Item', 'Example'], ['Paid for shares', '44.00 × 100 = $4,400.00'], ['Assignment fee', '$0.00'], ['Put premium kept (net)', '− $63.34'], ['Total real cost', '$4,336.66'], ['Adjusted basis', '$43.37 / share']] },
  { title: 'Phase 2 — Choose your path', items: [
    'Thesis broken (bad company news)? → PATH C: Exit.',
    'Gap 0–5% below basis (or above)? → PATH A: Normal covered call.',
    'Gap 5–15% below basis? → PATH B: Recovery mode.',
    'Gap more than 15%? → PATH B, plus a monthly re-check: is it still worth holding?',
    'Example: gap 2.9%, thesis OK → PATH A.',
  ] },
  { title: 'PATH A — Normal covered call', items: [
    'A.1 Chain → CALLS side.',
    'A.2 Expiry 30–45 DTE; earnings AFTER expiry.',
    'A.3 Screen order for calls (do it in this order): STRIKE ≥ adjusted basis FIRST (non-negotiable) → then delta 0.15–0.30 → OI ≥ 500 → spread ≤ $0.10 AND ≤ 10% of mid → Volume ≥ 50 → annualized ≥ 6%. The strike rule beats the delta rule: if the only strike above your basis has delta 0.40, that is fine.',
    'A.3b GOLDEN RULE: strike ≥ adjusted basis, ALWAYS ($43.37 → $43.50 or $44+).',
    'A.4 Spread ≤ $0.10 AND ≤ 10% of mid; OI ≥ 500; Volume ≥ 50.',
    'A.5 Money: Net = Mid×100 − commission; Return = Net ÷ (basis×100); Annualized = Return × 365 ÷ DTE; New basis = old basis − net/share. Take it if annualized ≥ 6% and strike ≥ basis.',
    'A.6 Ex-dividend: if ex-div is before expiry and the call is ITM, early assignment is possible (fine — you sell at ≥ basis).',
    'A.7 Place it: click the BID on the CALL row → SELL · XYZ [date] strike CALL · Qty 1 · LMT @ mid · DAY · no Outside RTH. Preview must show NO extra margin.',
    'A.8 Right after fill, place the GTC buy-to-close at 50% of fill (rounded down).',
    'If called away at the strike you profit → log it → back to selling puts.',
  ], table: [['Threshold', 'Rule'], ['Strike', '≥ adjusted basis — ALWAYS'], ['Delta', '+0.15 to +0.30'], ['DTE', '30–45 normal | 45–120 recovery'], ['Annualized', '≥ 6%'], ['Contracts', 'shares ÷ 100, never more']] },
  { title: 'PATH B — Recovery mode (gap more than 5%)', items: [
    'Work in order, stop at the first that works:',
    'B1: strike ≥ basis, 45–75 DTE, net ≥ $0.15/share, spread passes.',
    'B2: strike ≥ basis, 75–120 DTE, net ≥ $0.25/share.',
    'B3: Sell nothing. Hold and wait, keep any dividends. Re-check every Friday. This is a valid choice.',
    'B4: Strike BELOW basis (deliberate small loss) — not for beginners; only if you accept the exact loss.',
    'Each Friday record: current price, gap %, best premium at strike ≥ basis. Once gap < 5% → back to PATH A.',
    'Monthly (gap > 15%): is the business still good? Would I buy it today with fresh money? No → PATH C.',
  ] },
  { title: 'PATH C — Exit (thesis broken or you want out)', items: [
    'C.1 Close any open call FIRST. Selling shares while a short call is open makes it naked — your account will not allow it.',
    'C.2 Compute realized P&L = (sale price − adjusted basis) × 100 − commission. Accept the exact number before clicking. Example sell at 38.50 → (38.50 − 43.37) × 100 − 1 = −$488.',
    'C.3 Sell the shares: click the Bid → SELL 100 · LMT at mid · DAY · no Outside RTH. Trade 10:00–15:30 ET.',
    'C.4 Verify the position is gone, cash is back, log it, and return to the put screener.',
  ] },
  { title: 'Phase 3 — Calendar checkpoints while the call is open', items: [
    'Weekly: GTC still working? → nothing to do.',
    '21 DTE: call ≤ 70% of fill? Cancel the GTC, buy to close, sell the next call.',
    'Stock above strike: called away likely — a good outcome (strike ≥ basis). Let it happen.',
    'Day before ex-dividend, call ITM: early assignment possible — fine.',
    'Stock drops, call ≤ $0.05: buy to close for a few cents; sell a new call only if B1/B2 allow.',
    'Expiry Friday out of the money: expires worthless — keep the premium and the shares; sell the next call Monday.',
    'Beginners: do not roll a call that is going in the money — being called away is your profit exit.',
  ] },
  { title: 'Phase 4 — Log everything (running basis)', items: [
    'Opening a call: log strike/expiry/DTE, fill, commission, net premium, date/time, stock price, delta, bid/ask/OI/vol, ex-div, new adjusted basis, profit if called away, GTC limit, 21-DTE review date, path A/B/C.',
    'Closing/ending: record result (bought to close / expired / called away / sold). If the wheel closes: total premiums, share P&L, all fees, wheel net P&L, days in wheel, return on capital, annualized, lesson.',
    'Every call you sell lowers your break-even — that is how the wheel repairs a bad assignment over time.',
  ] },
];

function renderGuide(view, phases, storeKey, title, subtitle) {
  let checks = {};
  try { checks = JSON.parse(localStorage.getItem(storeKey)) || {}; } catch { /* ignore */ }
  const total = phases.reduce((n, p) => n + p.items.length, 0);
  const done = Object.values(checks).filter(Boolean).length;
  const body = phases.map((phase, pi) => `
    <div class="card mt">
      <div class="card-head"><h3>${escapeHtml(phase.title)}</h3><span class="pill">${phase.items.filter((_, ii) => checks[`p${pi}i${ii}`]).length}/${phase.items.length}</span></div>
      ${phase.note ? `<p class="muted">${escapeHtml(phase.note)}</p>` : ''}
      <div class="checklist">
        ${phase.items.map((it, ii) => {
          const key = `p${pi}i${ii}`;
          return `<label class="check-item ${checks[key] ? 'pass' : ''}"><input type="checkbox" data-guide-key="${key}" ${checks[key] ? 'checked' : ''} style="width:16px;height:16px;margin-top:2px" /><div class="check-label">${escapeHtml(it)}</div></label>`;
        }).join('')}
      </div>
      ${phase.table ? `<div class="table-wrap mt"><table class="table"><thead><tr>${phase.table[0].map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${phase.table.slice(1).map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
    </div>`).join('');

  return {
    title,
    render() {
      return `
        <div class="card">
          <div class="card-head"><div><h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(subtitle)}</p></div>
            <div class="row"><span class="pill">${done}/${total} done</span><button class="btn btn-secondary btn-sm" data-guide-clear="${storeKey}">Clear all</button></div></div>
          <div class="progress" style="height:6px"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
          <div class="notice info" style="margin-top:10px">⚠️ IBKR updates its Desktop app often, so a button may have a slightly different name. Do all of this in <b>Paper</b> mode first. Educational info, not financial advice.</div>
        </div>
        ${body}`;
    },
    mount(root) {
      const key = storeKey;
      const state = (() => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } })();
      root.querySelectorAll('[data-guide-key]').forEach((el) => {
        el.onchange = () => {
          state[el.dataset.guideKey] = el.checked;
          localStorage.setItem(key, JSON.stringify(state));
          const ticked = Object.values(state).filter(Boolean).length;
          const pill = root.querySelector('.card .pill');
          if (pill) pill.textContent = `${ticked}/${total} done`;
          const bar = root.querySelector('.card .progress i');
          if (bar) bar.style.width = `${total ? Math.round((ticked / total) * 100) : 0}%`;
          el.closest('.check-item')?.classList.toggle('pass', el.checked);
        };
      });
      root.querySelector(`[data-guide-clear="${key}"]`)?.addEventListener('click', () => {
        localStorage.removeItem(key);
        root.querySelectorAll('[data-guide-key]').forEach((el) => { el.checked = false; el.closest('.check-item')?.classList.remove('pass'); });
        const pill = root.querySelector('.card .pill'); if (pill) pill.textContent = `0/${total} done`;
        const bar = root.querySelector('.card .progress i'); if (bar) bar.style.width = '0%';
      });
    },
  };
}

export const putGuide = renderGuide('put', PUT_PHASES, 'wheel-checklist-put-v1',
  'Selling a cash-secured put in IBKR — step by step',
  'One example trade from start to finish: XYZ $47.30, sell 1 put, $44 strike, 38 DTE, budget $10,000.');

export const callGuide = renderGuide('call', CALL_PHASES, 'wheel-checklist-call-v1',
  '"Stuck with shares" — covered-call checklist',
  'You were assigned 100 XYZ at $44. You are not stuck — you are in Step 2 of the Wheel. This walks Path A / B / C.');
