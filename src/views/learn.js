import { escapeHtml } from '../format.js';

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
        <h2>The wheel in one picture</h2>
        <div class="state-machine" style="margin:14px 0">
          <span class="state-node">Cash</span><span class="state-arrow">→</span>
          <span class="state-node active">Sell cash-secured put</span><span class="state-arrow">→</span>
          <span class="state-node">Expires worthless (keep premium)</span><span class="state-arrow">or</span>
          <span class="state-node">Assigned (own shares)</span><span class="state-arrow">→</span>
          <span class="state-node">Sell covered call</span><span class="state-arrow">→</span>
          <span class="state-node">Called away → back to cash</span>
        </div>
        <p class="muted">Every step is optional and every step is a decision. You are never forced to sell a call, and you can always simply hold or sell the shares.</p>
      </div>

      <div class="card mt">
        <h2>Golden rules</h2>
        <div class="grid grid-2" style="margin-top:12px">
          ${[
            'Only sell puts on stocks I would happily own for months.',
            'Every put is 100% cash-secured — never use margin for puts.',
            'Take profit at ~50% of the premium.',
            'Avoid holding through earnings.',
            'Never roll for a debit without a written reason.',
            'Never sell calls below my adjusted cost basis without a plan.',
            'Keep at least a 10% cash reserve.',
            'Paper trade the full cycle before going live.',
          ].map((r) => `<div class="check-item pass"><span class="check-ico">✅</span><div class="check-label">${escapeHtml(r)}</div></div>`).join('')}
        </div>
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
