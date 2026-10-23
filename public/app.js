// UI layer. Each tab is { mount(el), update() }: mount builds controls once,
// update re-renders results whenever prices refresh or a filter changes.
const E = Engine, gp = E.fmtGp, num = E.fmtNum, pct = E.pct;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mk = new E.Market();

const DEFAULTS = {
  members: true, slots: 8, taxRate: 0.02, taxCap: 5e6, marketShare: 0.1, horizonHours: 4,
  refreshSec: 60, notify: false, risk: 'balanced', budget: null,
};
const RISK = { safe: 0.7, balanced: 0.5, aggressive: 0.3 };
let state = { settings: { ...DEFAULTS }, player: null, bank: [], bankUpdated: null, trades: [], history: [], ui: {} };
const derived = { flips: [], recipes: [], alchs: [], movers: { dips: [], spikes: [], surges: [] } };
let recipes = [];           // resolved recipe definitions
let status = { ok: false, error: null };
let current = null;         // mounted tab
const lastAdvice = {};      // trade uid -> last advice text (for notifications)

// ---------------- persistence ----------------
// Two modes: run locally with `node server.js` (state saved to data/state.json, API calls
// proxied), or hosted as a static site (state in this browser, prices fetched straight
// from the wiki, hiscores through the Cloudflare Worker in CONFIG / Settings).
let LOCAL = false;
const STORE_KEY = 'ge-helper-state';
async function loadState() {
  let s = null;
  try {
    const r = await fetch('api/state');
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) { s = await r.json(); LOCAL = true; }
  } catch { /* not running the local server */ }
  if (!LOCAL) { try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { s = null; } }
  if (s) applyState(s);
}
function applyState(s) {
  state = { ...state, ...s, settings: { ...DEFAULTS, ...(s.settings || {}) }, ui: { ...(s.ui || {}) } };
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = JSON.stringify(state);
    if (LOCAL) fetch('api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    else { try { localStorage.setItem(STORE_KEY, body); } catch { toast('Could not save — browser storage is blocked or full.'); } }
  }, 400);
}
const S = () => state.settings;

// ---------------- data ----------------
const WIKI = 'https://prices.runescape.wiki/api/v1/osrs';
async function api(path) {
  const r = await fetch(path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const prices = (ep) => api(LOCAL ? 'api/prices/' + ep : `${WIKI}/${ep}`);
const fetchTimeseries = (id, step) => api(LOCAL ? `api/timeseries?id=${id}&timestep=${step}` : `${WIKI}/timeseries?timestep=${step}&id=${id}`);
function hiscoresUrl(name) {
  if (LOCAL) return 'api/hiscores?player=' + encodeURIComponent(name);
  const proxy = (S().hiscoresProxy || CONFIG.hiscoresProxy || '').replace(/\/+$/, '');
  if (!proxy) throw new Error('Hiscores lookup is not set up yet. Add your Cloudflare Worker URL in Settings & Help.');
  return proxy + '/?player=' + encodeURIComponent(name);
}

async function refresh() {
  try {
    const [latest, m5, h1, h6, h24] = await Promise.all(['latest', '5m', '1h', '6h', '24h'].map(prices));
    mk.latest = latest.data; mk.m5 = m5.data; mk.h1 = h1.data; mk.h6 = h6.data; mk.h24 = h24.data;
    mk.updated = Date.now();
    status = { ok: true, error: null };
    compute();
    checkTradeAlerts();
    current?.update();
  } catch (e) {
    status = { ok: false, error: e.message };
  }
  renderStatus();
}

function bankMap() { return new Map(state.bank); }
function levels() {
  if (!state.player?.skills) return null;
  return Object.fromEntries(state.player.skills.map(s => [s.name, Math.max(1, s.level)]));
}
function cash() {
  const b = bankMap();
  return (b.get(E.COINS_ID) || 0) + 1000 * (b.get(E.PLAT_ID) || 0);
}
function budget() { return S().budget ?? (cash() || 1_000_000); }
function recipeCtx(mode) { return { mode: mode || state.ui.recipeMode || 'patient', levels: levels(), bank: bankMap() }; }

function compute() {
  const s = S();
  derived.flips = E.allFlips(mk, s);
  const ctx = recipeCtx();
  derived.recipes = recipes.map(r => E.evalRecipe(mk, r, s, ctx)).filter(Boolean);
  derived.alchs = E.alchs(mk, s, ctx);
  derived.movers = E.movers(mk, s);
}

// ---------------- small render helpers ----------------
const iconUrl = (icon) => icon ? 'https://oldschool.runescape.wiki/images/' + encodeURIComponent(icon.replace(/ /g, '_')) : '';
function itemLink(id, label) {
  const it = mk.items.get(id) || { name: label || '#' + id };
  return `<a class="item" href="#item/${id}"><img loading="lazy" src="${iconUrl(it.icon)}" alt="">${esc(label || it.name)}</a>`;
}
function chip(it, q, price) {
  return `<span class="chip"><img loading="lazy" src="${iconUrl(it.icon)}" alt="">${q > 1 ? q + '× ' : ''}<a href="#item/${it.id}">${esc(it.name)}</a>${price != null ? ` <span class="muted">@${gp(price)}</span>` : ''}</span>`;
}
function confBadge(c) {
  const cls = c >= 0.7 ? 'hi' : c >= 0.45 ? 'md' : 'lo';
  return `<span class="conf ${cls}" title="How much to trust this estimate">${cls === 'hi' ? 'High' : cls === 'md' ? 'Medium' : 'Low'}</span>`;
}
const signedText = (n) => (n >= 0 ? '+' : '') + gp(n);
const signed = (n) => `<span class="${n >= 0 ? 'pos' : 'neg'}">${n >= 0 ? '+' : ''}${gp(n)}</span>`;
const signedPct = (x) => `<span class="${x >= 0 ? 'pos' : 'neg'}">${pct(x)}</span>`;
function signalBadge(sig) {
  const cls = /BUY/.test(sig) ? 'buy' : /AVOID|SELL/.test(sig) ? 'sell' : sig === 'CAUTION' ? 'caution' : 'neutral';
  return `<span class="badge ${cls}">${sig}</span>`;
}

// Sortable table with expandable detail rows and action buttons.
function table(id, cols, rows, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'tbl-wrap';
  state.ui.sort ||= {};
  const st = state.ui.sort[id] || { k: opts.sortKey || cols[0].key, dir: -1 };
  const open = new Set();
  const draw = () => {
    const col = cols.find(c => c.key === st.k) || cols[0];
    const val = (r) => (col.sort ? col.sort(r) : r[col.key]);
    const sorted = [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string') return st.dir * va.localeCompare(vb);
      return st.dir * ((va ?? -Infinity) - (vb ?? -Infinity));
    }).slice(0, opts.limit || 150);
    wrap._rows = sorted;
    if (!sorted.length) { wrap.innerHTML = `<div class="empty">${opts.empty || 'Nothing matches right now.'}</div>`; return; }
    wrap.innerHTML = `<table class="tbl"><thead><tr>${cols.map(c =>
      `<th data-k="${c.key}" class="${c.num ? 'num' : ''} ${c.key === st.k ? 'sorted' : ''}" title="${esc(c.title || '')}">${c.label}${c.key === st.k ? (st.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}</tr></thead><tbody>${
      sorted.map((r, i) => `<tr class="row" data-i="${i}">${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join('')}</tr>${
        opts.detail && open.has(rowKey(r)) ? `<tr class="detail"><td colspan="${cols.length}">${opts.detail(r)}</td></tr>` : ''}`).join('')}</tbody></table>`;
  };
  const rowKey = (r) => r.id + ':' + (r.name || '');
  wrap.addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-k]');
    if (th) {
      if (st.k === th.dataset.k) st.dir *= -1; else { st.k = th.dataset.k; st.dir = -1; }
      state.ui.sort[id] = st; save(); draw(); return;
    }
    const btn = ev.target.closest('[data-act]');
    const tr = ev.target.closest('tr.row');
    if (btn) {
      const owner = tr || btn.closest('tr.detail')?.previousElementSibling;
      if (owner) opts.onAction?.(btn.dataset.act, wrap._rows[owner.dataset.i]);
      ev.stopPropagation(); return;
    }
    if (ev.target.closest('a')) return;
    if (tr && opts.detail) {
      const k = rowKey(wrap._rows[tr.dataset.i]);
      open.has(k) ? open.delete(k) : open.add(k);
      draw();
    }
  });
  draw();
  return wrap;
}

// ---------------- status bar ----------------
function renderStatus() {
  const el = $('#status');
  const age = mk.updated ? Math.round((Date.now() - mk.updated) / 1000) : null;
  const dot = !status.ok ? 'err' : age > S().refreshSec * 2.5 ? 'stale' : '';
  const p = state.player;
  el.innerHTML = `
    <span class="pill"><span class="dot ${dot}"></span>${status.ok ? `Live · ${age}s ago` : 'Offline: ' + esc(status.error || 'connecting')}</span>
    <span class="pill" title="Cash used for planning">💰 ${gp(budget())}</span>
    ${p ? `<span class="pill">👤 ${esc(p.name)}${p.accountType !== 'normal' ? ' (' + p.accountType + ')' : ''}</span>` : ''}
    <button class="sm" id="refresh-btn">Refresh</button>`;
  $('#refresh-btn').onclick = refresh;
}

// ---------------- trade helpers ----------------
function addTrade(t) {
  state.trades.push({ uid: Math.random().toString(36).slice(2), placedAt: Date.now(), firstBuyAt: null, stage: 'buying', sellPrice: null, ...t });
  save();
}
function tradeProfit(t, sellPrice) {
  return (sellPrice - E.tax(sellPrice, S(), t.id)) * t.qty - t.buyPrice * t.qty;
}
function checkTradeAlerts() {
  for (const t of state.trades) {
    const a = E.adviseTrade(mk, t, S());
    if (a.level === 'act' && lastAdvice[t.uid] !== a.text) {
      if (lastAdvice[t.uid] !== undefined || !document.hasFocus()) notify(`${mk.items.get(t.id)?.name}: action needed`, a.text);
    }
    lastAdvice[t.uid] = a.text;
  }
}
function notify(title, body) {
  if (!S().notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(title, { body });
}
function trackFlip(f, units) {
  if (state.trades.some(t => t.id === f.id && t.stage === 'buying')) return toast(`${f.name} is already pinned as a buy offer.`);
  addTrade({ id: f.id, qty: units || f.units4h, buyPrice: f.buy, sellPrice: f.sell });
  toast(`Tracking ${f.name}: place a buy offer for ${num(units || f.units4h)} at ${gp(f.buy)}.`);
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'notice'; t.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:50;max-width:420px';
  t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}

// =====================================================================
// Dashboard
// =====================================================================
const Dashboard = {
  mount(el) {
    el.innerHTML = `
      <div class="cards" id="d-cards"></div>
      <div class="panel" style="margin-top:16px">
        <h2>Smart Plan — what to put in your GE slots right now</h2>
        <p class="intro">Picks the best set of flips for your cash and free slots, weighting each by how trustworthy it is. Hit <b>Track</b> when you place a buy offer: it pins to the top and walks you through <b>Bought → Listed → Sold</b>, re-checking prices at every step.</p>
        <div class="controls">
          <label>Cash to use<input type="text" id="p-budget" value="${gp(budget())}" size="10"></label>
          <label>Free GE slots<input type="number" id="p-slots" min="1" max="8" value="${S().slots}" style="width:70px"></label>
          <label>Risk<select id="p-risk">
            <option value="safe">Safe — only high-confidence</option>
            <option value="balanced">Balanced</option>
            <option value="aggressive">Aggressive — bigger, riskier</option></select></label>
          <label>Finish within<select id="p-hz"><option value="1">1 hour</option><option value="2">2 hours</option><option value="4">4 hours</option><option value="8">8+ hours</option></select></label>
        </div>
        <div id="p-pinned"></div>
        <div id="p-out"></div>
      </div>
      <div class="grid g3">
        <div class="panel"><h2>Price dips</h2><p class="intro small">Down vs. their 24h average. Possible bargains — open Deep Analysis to check it's not still falling.</p><div id="mv-dips"></div></div>
        <div class="panel"><h2>Price spikes</h2><p class="intro small">Up vs. 24h average. If you own any, this may be a good time to sell.</p><div id="mv-spikes"></div></div>
        <div class="panel"><h2>Volume surges</h2><p class="intro small">Trading much more than usual this hour — news, updates, or merchants moving in.</p><div id="mv-surges"></div></div>
      </div>
      <div class="panel"><h2>Best skilling profits for you</h2><div id="d-skill"></div></div>`;
    const b = $('#p-budget'), sl = $('#p-slots'), rk = $('#p-risk'), hz = $('#p-hz');
    rk.value = S().risk; hz.value = String(S().horizonHours);
    b.onchange = () => { const v = parseGpInput(b.value); S().budget = v; b.value = gp(budget()); save(); this.update(); renderStatus(); };
    sl.onchange = () => { S().slots = Math.max(1, Math.min(8, +sl.value || 1)); save(); this.update(); };
    rk.onchange = () => { S().risk = rk.value; save(); this.update(); };
    hz.onchange = () => { S().horizonHours = +hz.value; save(); compute(); this.update(); };
    $('#p-pinned').addEventListener('click', (e) => this.onPinned(e));
  },
  async onPinned(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const t = state.trades.find(x => x.uid === b.closest('[data-uid]').dataset.uid); if (!t) return;
    const name = mk.items.get(t.id)?.name;
    const a = E.adviseTrade(mk, t, S());
    switch (b.dataset.act) {
      case 'bought': {
        t.stage = 'holding'; t.firstBuyAt ||= Date.now(); t.placedAt = Date.now();
        save(); this.update();
        await refresh(); // re-price the sale with the freshest numbers
        const n = E.adviseTrade(mk, t, S());
        toast(n.verdict === 'sell'
          ? `Prices refreshed: list ${name} at ${n.listAt.toLocaleString()}.`
          : `Prices refreshed: ${name} is below breakeven. Hold it, or list at breakeven (${n.listAt.toLocaleString()}).`);
        return;
      }
      case 'listed':
        t.sellPrice = a.listAt; t.stage = 'selling'; t.placedAt = Date.now(); break;
      case 'sold':
        state.history.unshift({ id: t.id, qty: t.qty, buyPrice: t.buyPrice, sellPrice: t.sellPrice, profit: tradeProfit(t, t.sellPrice), closedAt: Date.now() });
        state.trades = state.trades.filter(x => x !== t);
        toast(`Recorded ${signedText(tradeProfit(t, t.sellPrice))} on ${name}.`); break;
      case 'use':
        if (t.stage === 'buying') t.buyPrice = a.suggest; else t.sellPrice = a.suggest;
        t.placedAt = Date.now(); break;
      case 'edit': {
        const q = parseGpInput(prompt('Quantity?', t.qty)); if (!q) return;
        const field = t.stage === 'selling' ? 'sellPrice' : 'buyPrice';
        const p = parseGpInput(prompt(t.stage === 'selling' ? 'Your sell price per item?' : 'Your buy price per item?', t[field])); if (!p) return;
        t.qty = q; t[field] = p; break;
      }
      case 'unpin':
        if (t.stage !== 'buying' && !confirm(`Unpin ${name} without recording a sale?`)) return;
        state.trades = state.trades.filter(x => x !== t); break;
    }
    save(); this.update();
  },
  renderPinned() {
    const el = $('#p-pinned');
    if (!state.trades.length) { el.innerHTML = ''; return; }
    const s = S();
    const STEP = { buying: ['1', 'Buying', 'Buy'], holding: ['2', 'Bought, list it', 'Sell'], selling: ['3', 'Listed', 'Sell'] };
    const rows = state.trades.map(t => {
      const a = E.adviseTrade(mk, t, s);
      const [n, label, side] = STEP[t.stage] || STEP.buying;
      // Numbers follow the stage: what you're buying at first, what you're selling at after.
      const price = t.stage === 'buying' ? t.buyPrice : t.stage === 'holding' ? a.listAt : t.sellPrice;
      const sellAt = t.stage === 'buying' ? a.sellNow : price;
      const profit = sellAt ? (sellAt - E.tax(sellAt, s, t.id) - t.buyPrice) * t.qty : null;
      const total = (price || 0) * t.qty;
      const verdict = t.stage === 'holding' ? (a.verdict === 'sell' ? '<span class="badge buy">SELL</span> ' : '<span class="badge caution">HOLD</span> ') : '';
      const cta = { buying: '<button class="sm primary" data-act="bought">Bought</button>', holding: '<button class="sm primary" data-act="listed">Listed</button>', selling: '<button class="sm primary" data-act="sold">Sold</button>' }[t.stage];
      const use = a.suggest && a.suggest !== price ? `<button class="sm" data-act="use" title="Apply the suggested price">Use ${a.suggest.toLocaleString()}</button>` : '';
      return `<tr class="pin ${a.level}" data-uid="${t.uid}">
        <td>${itemLink(t.id)}</td>
        <td><span class="stage">${n} · ${label}</span></td>
        <td class="num"><span class="muted small">${side}:</span> ${t.qty.toLocaleString()}</td>
        <td class="num"><span class="muted small">${side}:</span> <b>${price != null ? price.toLocaleString() : '—'}</b></td>
        <td class="num">${gp(total)}</td>
        <td class="num">${profit != null ? signed(profit) : '—'}</td>
        <td class="pin-advice">${verdict}${esc(a.text)}</td>
        <td class="pin-acts">${use}${cta}<button class="sm" data-act="edit" title="Edit quantity or price">✎</button><button class="sm" data-act="unpin" title="Unpin">✕</button></td>
      </tr>`;
    }).join('');
    el.innerHTML = `<h3 style="margin:4px 0 8px">📌 Your active trades</h3><div class="tbl-wrap"><table class="tbl pinned"><thead><tr>
      <th>Item</th><th>Step</th><th class="num">Quantity</th><th class="num">Price per item</th><th class="num">Total</th><th class="num">Profit</th><th>What to do</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3 style="margin:18px 0 8px">Suggested next flips</h3>`;
  },
  update() {
    const tradesVal = state.trades.reduce((a, t) => a + (E.adviseTrade(mk, t, S()).unrealized || 0), 0);
    const realized = state.history.reduce((a, h) => a + h.profit, 0);
    const today = state.history.filter(h => Date.now() - h.closedAt < 864e5).reduce((a, h) => a + h.profit, 0);
    const bankVal = [...bankMap()].reduce((a, [id, q]) => a + (id === E.COINS_ID ? q : id === E.PLAT_ID ? q * 1000 : (mk.instaSell(id) || 0) * q), 0);
    $('#d-cards').innerHTML = `
      <div class="card"><div class="k">Cash available</div><div class="v">${gp(budget())}</div><div class="s">${state.bank.length ? 'from your bank import' : S().budget ? 'set manually' : 'default — import your bank'}</div></div>
      <div class="card"><div class="k">Bank value</div><div class="v">${state.bank.length ? gp(bankVal) : '—'}</div><div class="s">${state.bankUpdated ? 'imported ' + E.fmtAge((Date.now() - state.bankUpdated) / 60000) + ' ago' : '<a href="#character">import your bank</a>'}</div></div>
      <div class="card"><div class="k">Active trades</div><div class="v">${state.trades.length}</div><div class="s">open P/L if sold now: ${signed(tradesVal)}</div></div>
      <div class="card"><div class="k">Profit tracked</div><div class="v">${signed(realized)}</div><div class="s">last 24h: ${signed(today)}</div></div>
      <div class="card"><div class="k">Flips found</div><div class="v">${derived.flips.length}</div><div class="s">${derived.flips.filter(f => f.conf >= 0.7).length} high-confidence</div></div>`;

    // Suggestions only use the slots and cash your tracked trades aren't already using.
    this.renderPinned();
    const tracked = new Set(state.trades.map(t => t.id));
    const tied = state.trades.reduce((a, t) => a + t.buyPrice * t.qty, 0);
    const freeCash = Math.max(0, budget() - tied), freeSlots = Math.max(0, S().slots - state.trades.length);
    const res = E.plan(derived.flips.filter(f => !tracked.has(f.id)), { ...S() }, freeCash, freeSlots, RISK[S().risk]);
    const out = $('#p-out');
    if (!freeSlots) { out.innerHTML = '<div class="empty">All your GE slots are in use. Finish a trade to get a new suggestion.</div>'; }
    else if (!res.chosen.length && tied && freeCash < budget() * 0.1) { out.innerHTML = `<div class="empty">Your cash is tied up in active trades (${gp(tied)}). Finish one, or raise "Cash to use", to get new suggestions.</div>`; }
    else if (!res.chosen.length) { out.innerHTML = '<div class="empty">No flips fit these settings. Try more cash, a longer time window, or a higher risk level.</div>'; }
    else {
      out.innerHTML = `<div class="notice">Expected profit: <b>${gp(res.profit)}</b> using ${gp(res.used)} of ${gp(freeCash)} free cash in ${res.chosen.length} of ${freeSlots} free slot(s). Per round of buy limits (4h).</div>`;
      out.appendChild(table('plan', [
        { key: 'name', label: 'Item', fmt: r => itemLink(r.id), sort: r => r.name },
        // Same order as the in-game GE offer screen: quantity, then price per item.
        { key: 'units', label: 'Buy: Quantity', num: 1, fmt: r => r.units.toLocaleString() },
        { key: 'buy', label: 'Buy: Price per item', num: 1, fmt: r => r.buy.toLocaleString() },
        { key: 'sellUnits', label: 'Sell: Quantity', num: 1, fmt: r => r.units.toLocaleString(), sort: r => r.units },
        { key: 'sell', label: 'Sell: Price per item', num: 1, fmt: r => r.sell.toLocaleString() },
        { key: 'cost', label: 'Cost', num: 1, fmt: r => gp(r.cost) },
        { key: 'expProfit', label: 'Profit', num: 1, fmt: r => signed(r.expProfit) },
        { key: 'fillHours', label: 'Fill time', num: 1, fmt: r => E.fmtHours(r.fillHours) },
        { key: 'conf', label: 'Confidence', fmt: r => confBadge(r.conf) },
        { key: 'act', label: '', fmt: () => '<button class="sm primary" data-act="track">Track</button>' },
      ], res.chosen, {
        sortKey: 'expProfit',
        detail: flipDetail,
        onAction: (a, r) => { if (a === 'track') { trackFlip(r, r.units); this.update(); } },
      }));
    }

    const mv = derived.movers;
    const moverList = (rows, fmt) => rows.length ? `<div class="list-compact">${rows.map(r => `<div class="r">${itemLink(r.id)}<span class="num">${fmt(r)}</span></div>`).join('')}</div>` : '<div class="empty">None right now.</div>';
    $('#mv-dips').innerHTML = moverList(mv.dips, r => `${gp(r.m)} ${signedPct(r.change)}`);
    $('#mv-spikes').innerHTML = moverList(mv.spikes, r => `${gp(r.m)} ${signedPct(r.change)}`);
    $('#mv-surges').innerHTML = moverList(mv.surges, r => `${r.volSurge.toFixed(1)}× vol · ${signedPct(r.change)}`);

    const sk = [...derived.recipes, ...derived.alchs].filter(r => r.canDo !== false && r.profit > 0 && r.outVol > 5).sort((a, b) => b.gpHr - a.gpHr).slice(0, 6);
    $('#d-skill').innerHTML = sk.length ? `<div class="list-compact">${sk.map(r => `<div class="r"><span>${chip(r.outs[0]?.it || r.ins[0].it, 1)} <b>${esc(r.name)}</b> <span class="muted small">${r.skill ? r.skill + ' ' + r.level : 'no skill'}</span></span><span class="num">${signed(r.gpHr)}/hr</span></div>`).join('')}</div><p class="small muted">${levels() ? 'Filtered to your levels.' : 'Load your character to filter by your levels.'} See <a href="#skilling">Skilling Profits</a> for everything.</p>` : '<div class="empty">No data yet.</div>';
  },
};

function parseGpInput(v) {
  const m = String(v).trim().toLowerCase().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
}

function flipDetail(f) {
  return `<div class="grid g2">
    <div><b>How to do it:</b> Put in a buy offer for up to <b>${num(f.units4h)}</b> at <b>${gp(f.buy)}</b>. Once it fills, sell at <b>${gp(f.sell)}</b>.
      You keep <b>${gp(f.margin)}</b> each after the ${gp(f.tax)} GE tax (${pct(f.roi)} return).
      Buy limit: ${f.limit ? num(f.limit) + ' per 4 hours' : 'unknown'}. Needs ${gp(f.capital)} for the full amount.
      <ul class="reasons good">${f.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>
    <div>${f.risks.length ? `<b>Watch out for:</b><ul class="reasons bad">${f.risks.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : '<b>No major risks spotted.</b>'}
      <p><a href="#item/${f.id}">Open deep analysis →</a></p></div></div>`;
}

// =====================================================================
// Quick flips
// =====================================================================
const PRESETS = {
  quick: { label: 'Quick money (fills < 1h)', fn: f => f.fillHours <= 1 && f.vph >= 100, sort: 'profit4h' },
  value: { label: 'Big-ticket items', fn: f => f.buy >= 1e6, sort: 'profit4h' },
  cheap: { label: 'Low budget (< 50k each)', fn: f => f.buy <= 5e4 && f.vph >= 50, sort: 'profit4h' },
  roi: { label: 'Highest % return', fn: f => f.vph >= 20, sort: 'roi' },
  all: { label: 'Everything', fn: () => true, sort: 'profit4h' },
};
const Flips = {
  mount(el) {
    const u = state.ui;
    u.flipPreset ||= 'quick';
    el.innerHTML = `
      <div class="panel">
        <h2>Quick Flips</h2>
        <p class="intro">Buy low, sell high. "Buy at" is just above the price people are currently insta-selling for; "Sell at" is just under what people are insta-buying for. Profit is after the 2% GE tax. Click a row for a plain-English plan and risks.</p>
        <div class="controls">
          <div class="seg" id="f-presets">${Object.entries(PRESETS).map(([k, p]) => `<button data-p="${k}">${p.label}</button>`).join('')}</div>
        </div>
        <div class="controls">
          <label>Search<input type="search" id="f-q" placeholder="item name" value="${esc(u.flipQ || '')}"></label>
          <label>Max price each<input type="text" id="f-max" size="8" value="${u.flipMax ? gp(u.flipMax) : ''}" placeholder="any"></label>
          <label>Min confidence<select id="f-conf"><option value="0">Any</option><option value="0.45">Medium+</option><option value="0.7">High only</option></select></label>
          <label class="check"><input type="checkbox" id="f-afford" ${u.flipAfford ? 'checked' : ''}> Only what I can afford</label>
        </div>
        <div id="f-out"></div>
      </div>`;
    const sync = () => {
      u.flipQ = $('#f-q').value; u.flipMax = parseGpInput($('#f-max').value); u.flipConf = +$('#f-conf').value; u.flipAfford = $('#f-afford').checked;
      save(); this.update();
    };
    $('#f-conf').value = String(u.flipConf ?? 0.45);
    for (const id of ['#f-q', '#f-max']) $(id).addEventListener('input', sync);
    $('#f-conf').onchange = sync; $('#f-afford').onchange = sync;
    $('#f-presets').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      u.flipPreset = b.dataset.p;
      state.ui.sort ||= {}; state.ui.sort.flips = { k: PRESETS[u.flipPreset].sort, dir: -1 };
      save(); this.update();
    };
  },
  update() {
    const u = state.ui, preset = PRESETS[u.flipPreset] || PRESETS.quick;
    document.querySelectorAll('#f-presets button').forEach(b => b.classList.toggle('on', b.dataset.p === u.flipPreset));
    const q = (u.flipQ || '').toLowerCase(), cash = budget();
    const rows = derived.flips.filter(f => preset.fn(f)
      && (!q || f.name.toLowerCase().includes(q))
      && (!u.flipMax || f.buy <= u.flipMax)
      && f.conf >= (u.flipConf ?? 0.45)
      && (!u.flipAfford || f.buy <= cash));
    const out = $('#f-out'); out.innerHTML = '';
    out.appendChild(table('flips', [
      { key: 'name', label: 'Item', fmt: r => itemLink(r.id), sort: r => r.name },
      { key: 'buy', label: 'Buy at', num: 1, fmt: r => gp(r.buy) },
      { key: 'sell', label: 'Sell at', num: 1, fmt: r => gp(r.sell) },
      { key: 'margin', label: 'Profit each', num: 1, fmt: r => signed(r.margin), title: 'After GE tax' },
      { key: 'roi', label: 'Return', num: 1, fmt: r => pct(r.roi) },
      { key: 'vph', label: 'Trades/hr', num: 1, fmt: r => num(r.vph) },
      { key: 'limit', label: 'Limit', num: 1, fmt: r => r.limit ? num(r.limit) : '?', title: 'GE buy limit per 4 hours' },
      { key: 'units4h', label: 'Qty', num: 1, fmt: r => num(r.units4h), title: 'How many you can realistically flip per 4h' },
      { key: 'profit4h', label: 'Profit / 4h', num: 1, fmt: r => signed(r.profit4h) },
      { key: 'fillHours', label: 'Fill time', num: 1, fmt: r => E.fmtHours(r.fillHours) },
      { key: 'conf', label: 'Confidence', fmt: r => confBadge(r.conf) },
      { key: 'act', label: '', fmt: () => '<button class="sm" data-act="track">Track</button>' },
    ], rows, { sortKey: preset.sort, detail: flipDetail, onAction: (a, r) => a === 'track' && trackFlip(r) }));
  },
};

// =====================================================================
// Skilling profits
// =====================================================================
const Skilling = {
  mount(el) {
    const u = state.ui;
    const cats = [...new Set(recipes.map(r => r.cat)), 'Magic'];
    el.innerHTML = `
      <div class="panel">
        <h2>Skilling Profits</h2>
        <p class="intro">Buy materials, process them, sell the result. GP/hr is capped by whatever limits you first: your speed, the GE buy limit on the inputs, or how many the market will buy. Green requirement = you have the level.</p>
        <div class="controls">
          <label>Search<input type="search" id="s-q" value="${esc(u.recQ || '')}" placeholder="method or item"></label>
          <label>Category<select id="s-cat"><option value="">All</option>${[...new Set(cats)].map(c => `<option>${esc(c)}</option>`).join('')}<option value="Alch">High alchemy</option></select></label>
          <label>Pricing<select id="s-mode"><option value="patient">Patient (use offers — more profit)</option><option value="instant">Instant (insta-buy & insta-sell)</option></select></label>
          <label class="check"><input type="checkbox" id="s-can" ${u.recCan ? 'checked' : ''}> Only what I can do</label>
          <label class="check"><input type="checkbox" id="s-bank" ${u.recBank ? 'checked' : ''}> Uses items in my bank</label>
          <label class="check"><input type="checkbox" id="s-liq" ${u.recLiq !== false ? 'checked' : ''}> Hide illiquid</label>
        </div>
        <div id="s-out"></div>
      </div>`;
    $('#s-cat').value = u.recCat || ''; $('#s-mode').value = u.recipeMode || 'patient';
    const sync = () => {
      u.recQ = $('#s-q').value; u.recCat = $('#s-cat').value; u.recCan = $('#s-can').checked; u.recBank = $('#s-bank').checked; u.recLiq = $('#s-liq').checked;
      if (u.recipeMode !== $('#s-mode').value) { u.recipeMode = $('#s-mode').value; compute(); }
      save(); this.update();
    };
    $('#s-q').addEventListener('input', sync);
    for (const id of ['#s-cat', '#s-mode', '#s-can', '#s-bank', '#s-liq']) $(id).onchange = sync;
  },
  update() {
    const u = state.ui, q = (u.recQ || '').toLowerCase();
    let rows = u.recCat === 'Alch' ? derived.alchs : u.recCat ? derived.recipes.filter(r => r.cat === u.recCat) : [...derived.recipes, ...derived.alchs.slice(0, 15)];
    rows = rows.filter(r => (!q || r.name.toLowerCase().includes(q) || r.ins.some(x => x.it.name.toLowerCase().includes(q)))
      && (!u.recCan || r.canDo !== false)
      && (!u.recBank || r.fromBank > 0)
      && (u.recLiq === false || r.outVol >= 5));
    const lv = levels();
    const mode = u.recipeMode || 'patient';
    const inPrice = (it) => mode === 'instant' ? mk.instaBuy(it.id) : mk.buyRef(it.id);
    const outPrice = (it) => mode === 'instant' ? mk.instaSell(it.id) : mk.sellRef(it.id);
    const out = $('#s-out'); out.innerHTML = '';
    out.appendChild(table('recipes', [
      { key: 'name', label: 'Method', fmt: r => `<b>${esc(r.name)}</b>`, sort: r => r.name },
      { key: 'level', label: 'Requires', fmt: r => r.skill ? `<span class="${r.canDo === true ? 'pos' : r.canDo === false ? 'neg' : ''}">${r.skill} ${r.level}</span>${r.canDo === false ? ` <span class="muted small">(you: ${r.have})</span>` : ''}` : '<span class="muted">none</span>', sort: r => r.level },
      { key: 'ins', label: 'Buy', fmt: r => `<div class="chips">${r.ins.map(x => chip(x.it, x.q)).join('')}${r.fee ? `<span class="chip">+${gp(r.fee)} fee</span>` : ''}</div>`, sort: r => r.cost },
      { key: 'outs', label: 'Sell', fmt: r => r.outs.length ? `<div class="chips">${r.outs.map(x => chip(x.it, x.q)).join('')}</div>` : '<span class="chip">🪙 coins</span>', sort: r => r.revenue },
      { key: 'profit', label: 'Profit each', num: 1, fmt: r => signed(r.profit) },
      { key: 'rate', label: 'Per hour', num: 1, fmt: r => `${num(r.rate)}${r.cap !== 'speed' ? ' <span class="warn" title="Limited by ' + esc(r.cap) + '">⚑</span>' : ''}` },
      { key: 'gpHr', label: 'GP / hr', num: 1, fmt: r => signed(r.gpHr) },
      { key: 'capital', label: 'Cash / hr', num: 1, fmt: r => gp(r.cost * r.rate), sort: r => r.cost * r.rate, title: 'Money tied up per hour of processing' },
      { key: 'fromBank', label: 'From bank', num: 1, fmt: r => r.fromBank ? `${num(r.fromBank)}× <span class="small">${signed(r.fromBank * r.profit)}</span>` : '<span class="muted">—</span>' },
    ], rows, {
      sortKey: 'gpHr', limit: 200,
      detail: r => `<div class="grid g2"><div>
          <b>Cost per action:</b> ${gp(r.cost)} &nbsp; <b>Sells for:</b> ${gp(r.revenue)} (after tax) &nbsp; <b>Profit:</b> ${signed(r.profit)}<br>
          <b>Inputs:</b> ${r.ins.map(x => `${x.q}× ${esc(x.it.name)} @ ${gp(inPrice(x.it))} (limit ${x.it.limit ? num(x.it.limit) : '?'}/4h)`).join(', ')}<br>
          ${r.outs.length ? `<b>Outputs:</b> ${r.outs.map(x => `${x.q}× ${esc(x.it.name)} @ ${gp(outPrice(x.it))} (${num(mk.volPerHour(x.it.id))} trades/hr)`).join(', ')}<br>` : ''}
          <b>Rate limited by:</b> ${esc(r.cap)}.</div>
        <div>${esc(r.notes)}${r.fromBank ? `<p>You already have enough materials in your bank for <b>${num(r.fromBank)}</b> actions → ${signed(r.fromBank * r.profit)} vs. buying them.</p>` : ''}</div></div>`,
    }));
  },
};

// =====================================================================
// Deep analysis
// =====================================================================
const tsCache = new Map();
async function timeseries(id, step) {
  const k = id + ':' + step, hit = tsCache.get(k);
  if (hit && Date.now() - hit.t < 60e3) return hit.data;
  const data = (await fetchTimeseries(id, step)).data;
  tsCache.set(k, { t: Date.now(), data });
  return data;
}

const Analysis = {
  id: null,
  mount(el, id) {
    this.id = id || state.ui.lastItem || null;
    el.innerHTML = `
      <div class="panel">
        <h2>Deep Analysis</h2>
        <p class="intro">Looks at the last 30 hours (5-minute data) and 15 days (hourly data) to judge whether an item is cheap or expensive right now, which way it's moving, and what to offer. Re-checks every refresh.</p>
        <div class="controls">
          <label>Item<input type="search" id="a-q" list="item-names" placeholder="Start typing an item…" size="34"></label>
          <button class="primary" id="a-go">Analyse</button>
          <span class="muted small">Tip: click any item name anywhere in the app to open it here.</span>
        </div>
      </div>
      <div id="a-out"></div>`;
    const go = () => { const it = mk.find($('#a-q').value); if (it) location.hash = '#item/' + it.id; else toast('Item not found — pick one from the list.'); };
    $('#a-go').onclick = go;
    $('#a-q').addEventListener('keydown', e => e.key === 'Enter' && go());
    $('#a-q').addEventListener('change', () => mk.find($('#a-q').value) && go());
    if (this.id) $('#a-q').value = mk.items.get(this.id)?.name || '';
    this.update();
  },
  async update() {
    const out = $('#a-out');
    if (!this.id) { out.innerHTML = suggestedItems(); return; }
    const it = mk.items.get(this.id);
    if (!it) { out.innerHTML = '<div class="empty">Unknown item.</div>'; return; }
    state.ui.lastItem = it.id; save();
    if (!out.dataset.id || out.dataset.id != it.id) out.innerHTML = '<div class="empty">Loading price history…</div>';
    let r5, r1;
    try { [r5, r1] = await Promise.all([timeseries(it.id, '5m'), timeseries(it.id, '1h')]); }
    catch (e) { out.innerHTML = `<div class="notice err">Couldn't load history: ${esc(e.message)}</div>`; return; }
    if (this.id !== it.id) return; // user navigated away mid-load
    const a = E.analyze(mk, it, r5, r1, S());
    this.last = a;
    out.dataset.id = it.id;
    const f = a.flip, s = S(), owned = bankMap().get(it.id) || 0;
    const nat = mk.find('Nature rune'), natP = nat ? mk.buyRef(nat.id) : 0;
    const alchProfit = it.highalch ? it.highalch - (mk.buyRef(it.id) || 0) - natP : null;
    const p = mk.p(it.id) || {};
    out.innerHTML = `
      <div class="panel">
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <img src="${iconUrl(it.icon)}" style="width:40px;height:40px;object-fit:contain" alt="">
          <div><h2 style="margin:0">${esc(it.name)}</h2><div class="muted small">${esc(it.examine || '')} · ${it.members ? 'Members' : 'F2P'} · Buy limit ${it.limit ? num(it.limit) : '?'}/4h · <a href="https://prices.runescape.wiki/osrs/item/${it.id}" target="_blank" rel="noopener">wiki prices ↗</a></div></div>
          <div style="margin-left:auto;text-align:right">${signalBadge(a.signal)}<div class="small muted" style="margin-top:4px">Re-checked every refresh</div></div>
        </div>
        <p style="margin:12px 0 0;font-size:15px">${esc(a.summary)}</p>
        ${owned ? `<div class="notice" style="margin-top:10px">You have <b>${num(owned)}</b> in your bank (worth ${gp(owned * (mk.instaSell(it.id) || 0))} at insta-sell).</div>` : ''}
      </div>
      <div class="grid g2">
        <div class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">Price history</h3>
            <div class="seg" id="a-tf"><button data-tf="5m" class="on">30 hours</button><button data-tf="1h">15 days</button><button data-tf="6h">90 days</button></div></div>
          <div id="a-chart"></div>
        </div>
        <div class="panel">
          <h3>Why this signal</h3>
          ${a.reasons.length ? `<ul class="reasons good">${a.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${a.warnings.length ? `<ul class="reasons bad">${a.warnings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${!a.reasons.length && !a.warnings.length ? '<p class="muted">Nothing stands out — the price is behaving normally.</p>' : ''}
          <h3 style="margin-top:14px">Live market</h3>
          <div class="list-compact">
            <div class="r"><span>Last insta-buy (high)</span><span class="num">${gp(p.hi)} <span class="muted small">${E.fmtAge((Date.now() / 1000 - p.hiTime) / 60)} ago</span></span></div>
            <div class="r"><span>Last insta-sell (low)</span><span class="num">${gp(p.lo)} <span class="muted small">${E.fmtAge((Date.now() / 1000 - p.loTime) / 60)} ago</span></span></div>
            <div class="r"><span>24h average</span><span class="num">${gp(a.m24)}</span></div>
            <div class="r"><span>7-day range</span><span class="num">${gp(a.wkLo)} – ${gp(a.wkHi)}</span></div>
            <div class="r"><span>Trades per hour (24h avg)</span><span class="num">${num(mk.volPerHour(it.id))}</span></div>
            ${it.highalch ? `<div class="r"><span>High alch value</span><span class="num">${gp(it.highalch)} ${alchProfit > 0 ? `<span class="pos small">(alch profit ${gp(alchProfit)})</span>` : ''}</span></div>` : ''}
          </div>
        </div>
      </div>
      <div class="grid g3">
        <div class="panel"><h3>⚡ Quick flip</h3>${f ? `
          <div class="list-compact">
            <div class="r"><span>Buy offer</span><b class="num">${gp(f.buy)}</b></div>
            <div class="r"><span>Sell offer</span><b class="num">${gp(f.sell)}</b></div>
            <div class="r"><span>Profit each (after ${gp(f.tax)} tax)</span><span class="num">${signed(f.margin)}</span></div>
            <div class="r"><span>Realistic qty / 4h</span><span class="num">${num(f.units4h)}</span></div>
            <div class="r"><span>Profit / 4h</span><span class="num">${signed(f.profit4h)}</span></div>
            <div class="r"><span>Confidence</span>${confBadge(f.conf)}</div>
          </div><button class="primary" style="margin-top:10px" id="a-track-q">Track this flip</button>` : '<p class="muted">No profitable quick flip right now (spread too small after tax, or too few trades).</p>'}</div>
        <div class="panel"><h3>🧘 Patient flip</h3>
          <p class="small muted">Bid near the cheap end of the last 6h and ask near the expensive end. Slower to fill, bigger margin.</p>
          <div class="list-compact">
            <div class="r"><span>Buy offer</span><b class="num">${gp(a.patientBuy)}</b></div>
            <div class="r"><span>Sell offer</span><b class="num">${gp(a.patientSell)}</b></div>
            <div class="r"><span>Profit each</span><span class="num">${a.patientMargin != null ? signed(a.patientMargin) : '—'}</span></div>
          </div>${a.patientMargin > 0 ? '<button style="margin-top:10px" id="a-track-p">Track patient flip</button>' : ''}</div>
        <div class="panel"><h3>🔮 Looking ahead</h3>
          ${a.proj1 ? `<div class="list-compact">
            <div class="r"><span>In 1 hour</span><span class="num">${gp(a.proj1.mid)} <span class="muted small">(${gp(a.proj1.lo)}–${gp(a.proj1.hi)})</span></span></div>
            <div class="r"><span>In 4 hours</span><span class="num">${gp(a.proj4.mid)} <span class="muted small">(${gp(a.proj4.lo)}–${gp(a.proj4.hi)})</span></span></div>
            <div class="r"><span>Trend (last 2h)</span><span class="num">${signedPct(a.slope2)}/hr</span></div>
            <div class="r"><span>Trend (24h)</span><span class="num">${signedPct(a.slope24)}/hr</span></div>
            <div class="r"><span>Typical 1h swing</span><span class="num">±${pct(a.vol5 * Math.sqrt(12)).replace('+', '')}</span></div>
          </div><p class="small muted">Blends recent momentum (which fades) with a pull back toward the 24h average. A guide, not a guarantee.</p>` : '<p class="muted">Not enough data.</p>'}</div>
      </div>`;
    const tf = state.ui.chartTf || '5m';
    const drawChart = async (step) => {
      document.querySelectorAll('#a-tf button').forEach(b => b.classList.toggle('on', b.dataset.tf === step));
      const raw = step === '5m' ? r5 : step === '1h' ? r1 : await timeseries(it.id, step);
      const el = $('#a-chart'); if (!el) return;
      chart(el, raw, { proj: step === '5m' ? a : null, lines: f ? [{ v: f.buy, c: 'var(--green)', l: 'Buy' }, { v: f.sell, c: 'var(--red)', l: 'Sell' }] : [] });
    };
    $('#a-tf').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.ui.chartTf = b.dataset.tf; save(); drawChart(b.dataset.tf); } };
    drawChart(tf);
    $('#a-track-q')?.addEventListener('click', () => trackFlip(f));
    $('#a-track-p')?.addEventListener('click', () => {
      const units = Math.max(1, Math.min(it.limit || 1e9, f?.units4h || Math.floor(budget() / a.patientBuy)));
      addTrade({ id: it.id, qty: units, buyPrice: a.patientBuy, sellPrice: a.patientSell });
      toast(`Tracking patient flip: buy ${num(units)} at ${gp(a.patientBuy)}.`);
    });
  },
};

function suggestedItems() {
  const top = [...derived.flips].filter(f => f.conf >= 0.7).sort((a, b) => b.profit4h - a.profit4h).slice(0, 12);
  return `<div class="panel"><h3>Not sure where to start? Top high-confidence flips right now:</h3>
    <div class="list-compact">${top.map(f => `<div class="r">${itemLink(f.id)}<span class="num">${signed(f.profit4h)} / 4h</span></div>`).join('')}</div></div>`;
}

// SVG line chart: high/low bands, volume bars, optional projection fan and price lines.
function chart(el, raw, opts) {
  const pts = raw.map(p => ({ t: p.timestamp, h: p.avgHighPrice, l: p.avgLowPrice, v: (p.highPriceVolume || 0) + (p.lowPriceVolume || 0) }));
  if (pts.length < 2) { el.innerHTML = '<div class="empty">No history.</div>'; return; }
  const W = 800, H = 320, padL = 62, padR = 12, padT = 10, volH = 50, padB = 24;
  const priceH = H - padT - padB - volH - 8;
  const t0 = pts[0].t, t1raw = pts.at(-1).t;
  const projEnd = opts.proj?.proj4 ? t1raw + 4 * 3600 : t1raw;
  const vals = pts.flatMap(p => [p.h, p.l]).filter(Boolean);
  opts.lines?.forEach(l => vals.push(l.v));
  if (opts.proj?.proj4) vals.push(opts.proj.proj4.lo, opts.proj.proj4.hi);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.06 || hi * 0.01; lo -= pad; hi += pad;
  const x = (t) => padL + (t - t0) / (projEnd - t0) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * priceH;
  const vMax = Math.max(...pts.map(p => p.v)) || 1;
  const path = (key) => { let d = '', pen = false; for (const p of pts) { if (p[key] == null) { pen = false; continue; } d += (pen ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p[key]).toFixed(1); pen = true; } return d; };
  const ticks = []; for (let i = 0; i <= 4; i++) ticks.push(lo + (hi - lo) * i / 4);
  const bw = Math.max(1, (W - padL - padR) / pts.length * 0.7);
  const span = projEnd - t0;
  const tfmt = (t) => { const d = new Date(t * 1000); return span > 3 * 86400 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  let proj = '';
  if (opts.proj?.proj4) {
    const a = opts.proj, cx = x(t1raw), cy = y(a.cur);
    const p1x = x(t1raw + 3600), p4x = x(t1raw + 4 * 3600);
    proj = `<path d="M${cx},${cy} L${p1x},${y(a.proj1.hi)} L${p4x},${y(a.proj4.hi)} L${p4x},${y(a.proj4.lo)} L${p1x},${y(a.proj1.lo)} Z" fill="var(--blue)" opacity=".12"/>
      <path d="M${cx},${cy} L${p1x},${y(a.proj1.mid)} L${p4x},${y(a.proj4.mid)}" stroke="var(--blue)" stroke-width="2" stroke-dasharray="5 4" fill="none"/>
      <line x1="${cx}" x2="${cx}" y1="${padT}" y2="${padT + priceH}" stroke="var(--line)" stroke-dasharray="2 3"/>
      <text x="${cx + 4}" y="${padT + 12}" fill="var(--muted)" font-size="11">now → forecast</text>`;
  }
  el.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}">
    ${ticks.map(v => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="#2c271d"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${gp(v)}</text>`).join('')}
    ${pts.map(p => `<rect x="${x(p.t) - bw / 2}" y="${H - padB - p.v / vMax * volH}" width="${bw}" height="${p.v / vMax * volH}" fill="#4b4433"/>`).join('')}
    ${(opts.lines || []).map(l => `<line x1="${padL}" x2="${W - padR}" y1="${y(l.v)}" y2="${y(l.v)}" stroke="${l.c}" stroke-dasharray="4 4" opacity=".7"/><text x="${W - padR - 2}" y="${y(l.v) - 4}" text-anchor="end" fill="${l.c}" font-size="11">${l.l} ${gp(l.v)}</text>`).join('')}
    <path d="${path('h')}" stroke="var(--gold)" stroke-width="1.6" fill="none"/>
    <path d="${path('l')}" stroke="#8fb6e8" stroke-width="1.6" fill="none"/>
    ${proj}
    ${[0, 0.25, 0.5, 0.75, 1].map(f => { const t = t0 + f * span; return `<text x="${x(t)}" y="${H - 6}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}" fill="var(--muted)" font-size="11">${tfmt(t)}</text>`; }).join('')}
    <line id="hover-line" x1="0" x2="0" y1="${padT}" y2="${H - padB}" stroke="var(--muted)" opacity="0"/>
  </svg><div class="tip"></div></div>
  <div class="legend"><span><i style="background:var(--gold)"></i>Insta-buy price (high)</span><span><i style="background:#8fb6e8"></i>Insta-sell price (low)</span><span><i style="background:#4b4433;height:8px"></i>Volume</span>${opts.proj ? '<span><i style="background:var(--blue)"></i>Forecast range</span>' : ''}</div>`;
  const svg = $('svg', el), tip = $('.tip', el), hl = $('#hover-line', el);
  svg.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect(), sx = (ev.clientX - r.left) / r.width * W;
    const t = t0 + (sx - padL) / (W - padL - padR) * (projEnd - t0);
    let best = pts[0]; for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    hl.setAttribute('x1', x(best.t)); hl.setAttribute('x2', x(best.t)); hl.setAttribute('opacity', '.5');
    tip.style.display = 'block';
    tip.innerHTML = `${new Date(best.t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}<br>High <b>${gp(best.h)}</b> · Low <b>${gp(best.l)}</b><br>Volume ${num(best.v)}`;
    const px = (x(best.t) / W) * r.width;
    tip.style.left = Math.min(px + 12, r.width - 170) + 'px'; tip.style.top = '10px';
  });
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; hl.setAttribute('opacity', '0'); });
}

// =====================================================================
// My trades
// =====================================================================
const Trades = {
  mount(el) {
    el.innerHTML = `
      <div class="panel">
        <h2>My Trades</h2>
        <p class="intro">Log the offers you place in-game. Every refresh the app re-checks the market and tells you if you should raise your bid, lower your ask, sell now, hold, or cancel. Gold border = action needed. Turn on notifications in Settings to get pinged.</p>
        <div class="controls">
          <label>Item<input type="search" id="t-item" list="item-names" size="26" placeholder="Item name"></label>
          <label>Stage<select id="t-stage"><option value="buying">Buy offer placed</option><option value="holding">Bought, holding</option><option value="selling">Sell offer placed</option></select></label>
          <label>Quantity<input type="text" id="t-qty" size="7"></label>
          <label>Bought / bid price<input type="text" id="t-buy" size="9"></label>
          <label>Sell price (optional)<input type="text" id="t-sell" size="9"></label>
          <button class="primary" id="t-add">Add trade</button>
        </div>
        <div id="t-list"></div>
      </div>
      <div class="panel"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Completed</h2><button class="sm" id="t-clear">Clear history</button></div><div id="t-hist"></div></div>`;
    $('#t-item').addEventListener('change', () => {
      const it = mk.find($('#t-item').value); if (!it) return;
      const f = derived.flips.find(x => x.id === it.id);
      if (f) { $('#t-buy').value ||= f.buy; $('#t-sell').value ||= f.sell; $('#t-qty').value ||= f.units4h; }
    });
    $('#t-add').onclick = () => {
      const it = mk.find($('#t-item').value);
      const qty = parseGpInput($('#t-qty').value), buy = parseGpInput($('#t-buy').value), sell = parseGpInput($('#t-sell').value);
      if (!it || !qty || !buy) return toast('Need an item, quantity and price.');
      const stage = $('#t-stage').value;
      addTrade({ id: it.id, qty, buyPrice: buy, sellPrice: sell, stage, firstBuyAt: stage !== 'buying' ? Date.now() : null });
      ['#t-item', '#t-qty', '#t-buy', '#t-sell'].forEach(s => { $(s).value = ''; });
      this.update();
    };
    $('#t-clear').onclick = () => { if (confirm('Clear all completed trades?')) { state.history = []; save(); this.update(); } };
    $('#t-list').addEventListener('click', (e) => this.onAction(e));
  },
  onAction(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const t = state.trades.find(x => x.uid === b.closest('[data-uid]').dataset.uid); if (!t) return;
    const a = E.adviseTrade(mk, t, S());
    const ask = (msg, def) => { const v = prompt(msg, def); return v == null ? null : parseGpInput(v); };
    switch (b.dataset.act) {
      case 'bought': {
        const q = ask('How many did you buy?', t.qty); if (!q) return;
        t.qty = q; t.stage = 'holding'; t.firstBuyAt ||= Date.now(); t.placedAt = Date.now(); break;
      }
      case 'list': {
        const p = ask('Sell offer price?', t.sellPrice || a.sellNow); if (!p) return;
        t.sellPrice = p; t.stage = 'selling'; t.placedAt = Date.now(); break;
      }
      case 'reprice': {
        const p = ask(t.stage === 'buying' ? 'New buy offer price?' : 'New sell offer price?', t.stage === 'buying' ? t.buyPrice : t.sellPrice); if (!p) return;
        if (t.stage === 'buying') t.buyPrice = p; else t.sellPrice = p; t.placedAt = Date.now(); break;
      }
      case 'sold': {
        const p = ask('Sold at what price each?', t.sellPrice || a.sellNow); if (!p) return;
        state.history.unshift({ id: t.id, qty: t.qty, buyPrice: t.buyPrice, sellPrice: p, profit: tradeProfit(t, p), closedAt: Date.now() });
        state.trades = state.trades.filter(x => x !== t); break;
      }
      case 'remove': if (!confirm('Remove this trade without recording it?')) return; state.trades = state.trades.filter(x => x !== t); break;
    }
    save(); this.update();
  },
  update() {
    const list = $('#t-list'), s = S();
    if (!state.trades.length) list.innerHTML = '<div class="empty">No active trades. Add one above, or hit "Track" on any flip.</div>';
    else list.innerHTML = state.trades.map(t => {
      const it = mk.items.get(t.id) || { name: '#' + t.id };
      const a = E.adviseTrade(mk, t, s);
      const reset = a.resetAt ? (a.resetAt > Date.now() ? `limit resets ${new Date(a.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'buy limit reset') : '';
      return `<div class="trade ${a.level}" data-uid="${t.uid}">
        <div>${itemLink(t.id)}<span class="stage">${t.stage}</span>
          <div class="meta"><span>Qty ${num(t.qty)}</span><span>Bid/cost ${gp(t.buyPrice)}</span>${t.sellPrice ? `<span>Ask ${gp(t.sellPrice)}</span>` : ''}<span>Breakeven ${gp(a.breakeven)}</span>
          ${a.unrealized != null ? `<span>If sold now ${signed(a.unrealized)}</span>` : ''}<span>Updated ${E.fmtAge((Date.now() - t.placedAt) / 60000)} ago</span>${reset ? `<span>${reset}</span>` : ''}</div></div>
        <div class="acts">
          ${t.stage === 'buying' ? '<button class="sm primary" data-act="bought">Bought ✓</button>' : ''}
          ${t.stage === 'holding' ? '<button class="sm primary" data-act="list">Listed for sale</button>' : ''}
          ${t.stage !== 'holding' ? '<button class="sm" data-act="reprice">Change price</button>' : ''}
          ${t.stage !== 'buying' ? '<button class="sm" data-act="sold">Sold ✓</button>' : ''}
          <button class="sm" data-act="remove">✕</button>
        </div>
        <div class="advice">${a.level === 'act' ? '👉 ' : a.level === 'warn' ? '⚠️ ' : '✅ '}${esc(a.text)}</div>
      </div>`;
    }).join('');
    const h = $('#t-hist');
    const total = state.history.reduce((a, x) => a + x.profit, 0);
    h.innerHTML = state.history.length ? `<p>Total recorded profit: <b>${signed(total)}</b> across ${state.history.length} trades.</p>` : '<div class="empty">Completed trades show up here.</div>';
    if (state.history.length) h.appendChild(table('hist', [
      { key: 'name', label: 'Item', fmt: r => itemLink(r.id), sort: r => mk.items.get(r.id)?.name || '' },
      { key: 'qty', label: 'Qty', num: 1, fmt: r => num(r.qty) },
      { key: 'buyPrice', label: 'Bought', num: 1, fmt: r => gp(r.buyPrice) },
      { key: 'sellPrice', label: 'Sold', num: 1, fmt: r => gp(r.sellPrice) },
      { key: 'profit', label: 'Profit', num: 1, fmt: r => signed(r.profit) },
      { key: 'closedAt', label: 'When', num: 1, fmt: r => new Date(r.closedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
    ], state.history, { sortKey: 'closedAt' }));
  },
};

// =====================================================================
// Character & bank
// =====================================================================
const Character = {
  mount(el) {
    el.innerHTML = `
      <div class="grid g2">
        <div class="panel">
          <h2>Your character</h2>
          <p class="intro">Pulls your skill levels from the official hiscores so skilling methods are filtered to what you can actually do.</p>
          <div class="controls">
            <label>RuneScape name<input type="text" id="c-name" maxlength="12" value="${esc(state.player?.name || '')}"></label>
            <button class="primary" id="c-fetch">Load from hiscores</button>
            <label class="check"><input type="checkbox" id="c-mem" ${S().members ? 'checked' : ''}> Members account</label>
          </div>
          <div id="c-player"></div>
        </div>
        <div class="panel">
          <h2>Import bank / inventory</h2>
          <p class="intro">Jagex has no public API for banks, so paste a copy here. Easiest: install the <b>Bank Memory</b> plugin in RuneLite, open its panel, right-click your bank and choose <i>Copy item data to clipboard</i>, then paste. You can also type lines like <kbd>Shark x 500</kbd> or <kbd>Coins: 12.5m</kbd>.</p>
          <textarea id="c-bank" placeholder="Paste bank data here…"></textarea>
          <div class="controls" style="margin-top:8px">
            <button class="primary" id="c-import">Replace bank</button>
            <button id="c-add">Add to bank</button>
            <button id="c-clear">Clear bank</button>
          </div>
          <div id="c-import-msg"></div>
        </div>
      </div>
      <div class="panel"><h2>Bank insights</h2><p class="intro">What each item is worth and what to do with it: sell into a spike, alch it, or process it for more.</p><div id="c-bankout"></div></div>`;
    $('#c-fetch').onclick = async () => {
      const name = $('#c-name').value.trim(); if (!name) return;
      $('#c-player').innerHTML = '<div class="empty">Looking up…</div>';
      try {
        const d = await api(hiscoresUrl(name));
        state.player = { name: d.name || name, skills: d.skills, accountType: d.accountType, fetched: Date.now() };
        save(); compute(); this.update(); renderStatus();
      } catch (e) { $('#c-player').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
    };
    $('#c-mem').onchange = () => { S().members = $('#c-mem').checked; save(); compute(); this.update(); };
    const imp = (replace) => {
      const { items, unknown } = E.parseBank($('#c-bank').value, mk);
      if (!items.size) { $('#c-import-msg').innerHTML = '<div class="notice err">Couldn\'t recognise any items in that text.</div>'; return; }
      const base = replace ? new Map() : bankMap();
      for (const [id, q] of items) base.set(id, (base.get(id) || 0) + q);
      state.bank = [...base]; state.bankUpdated = Date.now();
      if (S().budget == null) renderStatus();
      save(); compute(); this.update(); renderStatus();
      $('#c-bank').value = '';
      $('#c-import-msg').innerHTML = `<div class="notice">Imported ${items.size} item types.${unknown.length ? ` Skipped ${unknown.length} unrecognised line(s): ${esc(unknown.slice(0, 5).join(' | '))}${unknown.length > 5 ? '…' : ''}` : ''}</div>`;
    };
    $('#c-import').onclick = () => imp(true);
    $('#c-add').onclick = () => imp(false);
    $('#c-clear').onclick = () => { if (confirm('Clear your imported bank?')) { state.bank = []; state.bankUpdated = null; save(); compute(); this.update(); renderStatus(); } };
  },
  update() {
    const p = state.player, el = $('#c-player');
    if (p) {
      const iron = p.accountType !== 'normal';
      const total = p.skills.find(s => s.name === 'Overall');
      el.innerHTML = `${iron ? `<div class="notice err">This is a${p.accountType === 'ultimate' ? 'n ultimate' : p.accountType === 'hardcore' ? ' hardcore' : 'n'} ironman account — ironmen can't use the Grand Exchange. Skilling numbers still show what methods are worth.</div>` : ''}
        <p><b>${esc(p.name)}</b> · Total level ${total?.level ?? '?'} · loaded ${E.fmtAge((Date.now() - p.fetched) / 60000)} ago</p>
        <div class="skills">${p.skills.filter(s => s.name !== 'Overall').map(s => `<div class="skill"><span>${esc(s.name)}</span><b>${Math.max(1, s.level)}</b></div>`).join('')}</div>`;
    } else el.innerHTML = '<p class="muted">No character loaded yet.</p>';

    const out = $('#c-bankout');
    const bank = bankMap();
    if (!bank.size) { out.innerHTML = '<div class="empty">Import your bank above to see insights.</div>'; return; }
    const nat = mk.find('Nature rune'), natP = nat ? mk.instaBuy(nat.id) : 0;
    // Best processing use for each item you hold; methods you can fully supply from your bank win.
    const bestUse = new Map();
    const useScore = (r) => (r.fromBank > 0 ? 1e12 : 0) + r.gpHr;
    for (const r of derived.recipes) {
      if (r.canDo === false || r.profit <= 0 || r.outVol < 5) continue;
      for (const { it } of r.ins) {
        if (!bank.has(it.id)) continue;
        const cur = bestUse.get(it.id);
        if (!cur || useScore(r) > useScore(cur)) bestUse.set(it.id, r);
      }
    }
    let total = 0;
    const rows = [...bank].map(([id, qty]) => {
      if (id === E.COINS_ID || id === E.PLAT_ID) { const v = id === E.COINS_ID ? qty : qty * 1000; total += v; return { id, name: id === E.COINS_ID ? 'Coins' : 'Platinum token', qty, price: id === E.COINS_ID ? 1 : 1000, value: v, change: 0, advice: '<span class="muted">Cash</span>' }; }
      const it = mk.items.get(id);
      if (!it) return { id, name: '#' + id, qty, price: 0, value: 0, change: 0, advice: '<span class="muted">Untradeable</span>' };
      const price = mk.instaSell(id) || 0, m = mk.mid(id), m24 = mk.mid24(id);
      const value = price * qty; total += value;
      const change = m && m24 ? (m - m24) / m24 : 0;
      const advice = [];
      const alchGain = it.highalch && it.highalch - natP - price;
      if (change > 0.05) advice.push(`<span class="pos">Sell — ${pct(change)} above today's average</span>`);
      if (change < -0.06) advice.push(`<span class="warn">Hold — ${pct(change)} below today's average</span>`);
      if (alchGain > 0 && it.highalch > 500) advice.push(`<span class="pos">Alch: +${gp(alchGain)} each vs selling</span>`);
      const use = bestUse.get(id);
      if (use) advice.push(`Process: <b>${esc(use.name)}</b> (${signed(use.profit)} each)`);
      return { id, name: it.name, qty, price, value, change, advice: advice.join('<br>') || '<span class="muted">Hold / sell anytime</span>' };
    });
    out.innerHTML = `<div class="cards" style="margin-bottom:12px">
      <div class="card"><div class="k">Bank value (insta-sell)</div><div class="v">${gp(total)}</div></div>
      <div class="card"><div class="k">Cash</div><div class="v">${gp(cash())}</div><div class="s">used for the Smart Plan</div></div>
      <div class="card"><div class="k">Items</div><div class="v">${bank.size}</div><div class="s">imported ${E.fmtAge((Date.now() - state.bankUpdated) / 60000)} ago</div></div></div>`;
    out.appendChild(table('bank', [
      { key: 'name', label: 'Item', fmt: r => r.id === E.COINS_ID || r.id === E.PLAT_ID ? esc(r.name) : itemLink(r.id), sort: r => r.name },
      { key: 'qty', label: 'Qty', num: 1, fmt: r => num(r.qty) },
      { key: 'price', label: 'Price', num: 1, fmt: r => gp(r.price) },
      { key: 'value', label: 'Value', num: 1, fmt: r => gp(r.value) },
      { key: 'change', label: 'vs 24h', num: 1, fmt: r => r.change ? signedPct(r.change) : '—' },
      { key: 'advice', label: 'Suggestion', fmt: r => r.advice, sort: r => r.advice },
    ], rows, { sortKey: 'value', limit: 1000 }));
  },
};

// =====================================================================
// Settings & help
// =====================================================================
const Settings = {
  mount(el) {
    const s = S();
    el.innerHTML = `
      <div class="grid g2">
        <div class="panel">
          <h2>Settings</h2>
          <div class="controls" style="flex-direction:column;align-items:stretch;max-width:420px">
            <label class="check"><input type="checkbox" id="st-mem" ${s.members ? 'checked' : ''}> Members (show members items & 8 GE slots)</label>
            <label>GE slots<input type="number" id="st-slots" min="1" max="8" value="${s.slots}"></label>
            <label>Your share of each item's trading volume (%)<input type="number" id="st-share" min="1" max="50" value="${Math.round(s.marketShare * 100)}">
              <span class="small">How much of the market you expect to capture. 10% is realistic; raise it for niche items you know well.</span></label>
            <label>GE tax rate (%)<input type="number" id="st-tax" step="0.5" value="${s.taxRate * 100}"></label>
            <label>GE tax cap per item (gp)<input type="text" id="st-cap" value="${s.taxCap}"></label>
            <label>Auto-refresh every (seconds)<input type="number" id="st-ref" min="30" value="${s.refreshSec}"></label>
            <label class="check"><input type="checkbox" id="st-notify" ${s.notify ? 'checked' : ''}> Desktop notifications when a trade needs action</label>
            ${LOCAL ? '' : `<label>Hiscores lookup address (your Cloudflare Worker)<input type="text" id="st-proxy" value="${esc(s.hiscoresProxy || CONFIG.hiscoresProxy || '')}" placeholder="https://ge-hiscores.yourname.workers.dev">
              <span class="small">Needed to load your levels on the hosted site.</span></label>`}
            <button class="primary" id="st-save">Save settings</button>
          </div>
        </div>
        <div class="panel">
          <h2>Backup &amp; move your data</h2>
          <p class="intro">${LOCAL ? 'Your data is saved in the data folder on this PC.' : 'Your data is saved in this browser only. It won\'t follow you to another device, and clearing browser data deletes it.'}
            Download a backup to keep it safe, or to move your trades, bank and settings to another device or to the website version.</p>
          <div class="controls">
            <button id="st-export">Download backup</button>
            <label class="btn" style="flex-direction:row;color:var(--text);font-size:14px">Restore backup<input type="file" id="st-import" accept=".json,application/json" hidden></label>
          </div>
        </div>
        <div class="panel">
          <h2>How it works</h2>
          <details open><summary>Where the data comes from</summary><div>
            Prices come from the <a href="https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices" target="_blank" rel="noopener">OSRS Wiki real-time prices API</a> (fed by RuneLite users' GE trades), refreshed every ${s.refreshSec}s. Skill levels come from the official hiscores. Your bank is whatever you paste in.</div></details>
          <details><summary>Reading the numbers</summary><div>
            <p><b>High</b> = the latest price someone insta-bought at. <b>Low</b> = the latest price someone insta-sold at. Flipping means buying near the low and selling near the high.</p>
            <p><b>Profit each</b> always subtracts the GE tax (2%, max 5m per item; items under 50gp and bonds are tax-free).</p>
            <p><b>Qty</b> is the smaller of the buy limit and the share of trading volume you can realistically get in 4 hours.</p>
            <p><b>Confidence</b> drops when an item trades rarely, the last trades are old, the spread looks like a one-off spike, or the price is falling.</p></div></details>
          <details><summary>Getting the most profit</summary><div><ul>
            <li>Keep all GE slots busy — use the Smart Plan on the Dashboard.</li>
            <li>Quick flips: high volume, small margins, many rounds per day. Big-ticket items: fewer trades, bigger margins, more risk.</li>
            <li>Buy limits reset 4 hours after your first purchase of an item — the My Trades tab shows when.</li>
            <li>If an offer hasn't filled in ~10–15 minutes, the market has moved. Follow the "raise to…" advice or cancel.</li>
            <li>Never chase a falling item: Deep Analysis warns when the 2-hour trend is sharply down.</li>
            <li>Processing (skilling) beats flipping when you'd be training anyway — you get XP and profit.</li></ul></div></details>
          <details><summary>Limits</summary><div>
            The forecast is statistics, not insider knowledge — game updates and big merchants can move prices suddenly. This app never touches your game client; you place every offer yourself, which keeps it within Jagex's rules.</div></details>
        </div>
      </div>`;
    $('#st-save').onclick = async () => {
      s.members = $('#st-mem').checked;
      s.slots = Math.max(1, Math.min(8, +$('#st-slots').value || 8));
      s.marketShare = Math.max(0.01, Math.min(0.5, (+$('#st-share').value || 10) / 100));
      s.taxRate = Math.max(0, (+$('#st-tax').value || 0) / 100);
      s.taxCap = parseGpInput($('#st-cap').value) ?? 5e6;
      s.refreshSec = Math.max(30, +$('#st-ref').value || 60);
      s.notify = $('#st-notify').checked;
      if ($('#st-proxy')) s.hiscoresProxy = $('#st-proxy').value.trim();
      if (s.notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      save(); compute(); startTimer(); toast('Settings saved.');
    };
    $('#st-export').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }));
      a.download = `ge-helper-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(a.href);
    };
    $('#st-import').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const s2 = JSON.parse(await file.text());
        if (!s2 || typeof s2 !== 'object' || !('settings' in s2 || 'trades' in s2)) throw new Error('not a GE Helper backup');
        if (!confirm('Replace everything here with this backup?')) return;
        applyState(s2); save(); compute(); renderStatus(); toast('Backup restored.'); route();
      } catch (err) { toast('Could not restore: ' + err.message); }
    };
  },
  update() {},
};

// ---------------- router ----------------
const VIEWS = { dashboard: Dashboard, flips: Flips, skilling: Skilling, analysis: Analysis, item: Analysis, trades: Trades, character: Character, settings: Settings };
function route() {
  const [name, arg] = (location.hash.slice(1) || 'dashboard').split('/');
  const view = VIEWS[name] || Dashboard;
  const tabName = name === 'item' ? 'analysis' : (VIEWS[name] ? name : 'dashboard');
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + tabName));
  current = view;
  const el = $('#view');
  el.innerHTML = '';
  view.mount(el, arg ? Number(arg) : undefined);
  if (view !== Analysis) view.update();
  window.scrollTo(0, 0);
}

let timer;
function startTimer() { clearInterval(timer); timer = setInterval(refresh, S().refreshSec * 1000); }

async function init() {
  await loadState();
  try {
    mk.setMapping(await prices('mapping'));
  } catch (e) {
    $('#view').innerHTML = `<div class="notice err">Couldn't reach the price API: ${esc(e.message)}. Check your internet connection and try again.</div>`;
    return;
  }
  const generated = E.generatedRecipes(mk);
  recipes = [...RECIPES, ...generated].map(r => E.resolveRecipe(mk, r)).filter(Boolean);
  $('#item-names').innerHTML = [...mk.items.values()].map(i => `<option value="${esc(i.name)}">`).join('');
  await refresh();
  window.addEventListener('hashchange', route);
  route();
  startTimer();
  setInterval(renderStatus, 5000);
}
init();
