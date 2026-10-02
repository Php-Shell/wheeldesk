import { escapeHtml } from '../format.js';
import { RULEBOOK } from '../rulebook.js';

const TOPICS = [
  ['What is a put option?', 'A put gives its owner the right (not the obligation) to sell 100 shares at the strike price before expiry. When you SELL a put, you receive cash now and agree to BUY 100 shares at the strike if the buyer exercises.'],
  ['Cash-secured put', 'You set aside the full collateral (strike × 100 × contracts) in cash. Because the money is there, you can never be forced into a margin call on the put. This is the safest way for a beginner to sell puts.'],
  ['Covered call', 'If you own 100 shares, selling a call gives someone the right to buy them at the strike. You collect premium; if the stock rises above the strike you may be "called away" and sell at that price.'],
  ['The Wheel', 'A repeatable loop: sell a cash-secured put → if assigned, own shares and sell covered calls → if called away, you are back to cash and start again. Premiums along the way lower your cost basis.'],
  ['Assignment', 'When the option is in the money at expiry (or the buyer exercises early), you are assigned. For a short put this means buying 100 shares per contract at the strike.'],
  ['Delta', 'An estimate of how much the option price moves per $1 move in the stock, and a rough proxy for the chance of finishing in the money. A delta of -0.20 is often read as roughly a 20% chance of assignment.'],
  ['Theta', 'The rate at which an option loses value as time passes. Sellers benefit from theta: every day that passes, options decay in your favour, all else equal.'],
  ['IV and IV Rank', 'Implied volatility is how much movement the market expects. IV Rank compares current IV with its own past year. Sell premium when IV Rank is 30–60: enough to be paid well, not so high that an event is brewing.'],
  ['DTE (days to expiry)', 'How long until the option expires. This strategy prefers 30–45 DTE: enough premium, and time for theta to work, without tying up money for too long.'],
  ['Rolling', 'Closing an option and opening a later-dated one at the same time. Only roll for a NET CREDIT. Rolling for a debit means paying to keep a position alive — sometimes valid, but never automatic.'],
  ['Cost basis', 'What you effectively paid per share. Adjusted cost basis = assignment price − premiums collected per share + fees per share − dividends per share. Keep your calls at or above it.'],
  ['Early assignment & dividends', 'Call holders may exercise just before an ex-dividend date to capture the dividend. If your call is in the money and its remaining time value is less than the dividend, early assignment risk rises.'],
  ['Why not naked options?', 'Selling options without the cash or shares to cover them can create unlimited (calls) or very large (puts) losses. This app is built for covered, cash-secured positions only.'],
  ['Why paper trade first?', 'Paper trading lets you practice the full cycle — assignment, covered calls, rolls — with zero money at risk. Only go live once the mechanics feel boring and the rules feel automatic.'],
];

export default {
  title: 'Learn',
  render() {
    return `
      <div class="card">
        <h2>The big idea in one sentence</h2>
        <p>You get paid to wait to buy a stock you like at a lower price, and then you get paid again while you wait to sell it at a higher price. It is called "The Wheel" because it goes in a loop.</p>
        <p class="muted">When you sell a put you are agreeing to buy 100 shares at the strike. In the wheel, assignment is <b>not a failure</b> — it is simply the signal to move to Step 2.</p>
        <div class="state-machine" style="margin:14px 0">
          <span class="state-node">Cash</span><span class="state-arrow">→</span>
          <span class="state-node active">STEP 1 · Sell cash-secured put</span><span class="state-arrow">→</span>
          <span class="state-node">Expires worthless (keep premium, repeat)</span><span class="state-arrow">or</span>
          <span class="state-node">Assigned (own shares)</span><span class="state-arrow">→</span>
          <span class="state-node">STEP 2 · Sell covered call</span><span class="state-arrow">→</span>
          <span class="state-node">Called away → back to cash, repeat</span>
        </div>
      </div>

      <div class="card mt">
        <h2>${escapeHtml("The beginner's rule book")}</h2>
        <p class="muted">Also available any time from the floating <b>Rules</b> button (bottom-right), where you can tick items off or float it over other tabs.</p>
        ${RULEBOOK.map((section) => `
          <div class="check-group-title">${escapeHtml(section.title)}</div>
          ${section.note ? `<p class="muted" style="font-size:12.5px;margin:0 0 8px">${escapeHtml(section.note)}</p>` : ''}
          <div class="checklist">
            ${section.items.map((it) => `<div class="check-item ${it.ok ? 'pass' : 'fail'}"><span class="check-ico">${it.ok ? '✅' : '❌'}</span><div class="check-label">${escapeHtml(it.text)}</div></div>`).join('')}
          </div>`).join('')}
      </div>

      <div class="section-head"><h2>Beginner guide</h2></div>
      ${TOPICS.map(([title, body], i) => `
        <div class="accordion" data-topic="${i}">
          <div class="accordion-head" data-topic-toggle="${i}"><b>${escapeHtml(title)}</b><span class="chev">›</span></div>
          <div class="accordion-body"><p style="margin-top:14px">${escapeHtml(body)}</p></div>
        </div>`).join('')}

      <div class="notice info mt">Educational content only. This is not financial advice, and options involve real risk of loss.</div>`;
  },
  mount(root) {
    root.querySelectorAll('[data-topic-toggle]').forEach((head) => {
      head.onclick = () => head.parentElement.classList.toggle('open');
    });
  },
};
