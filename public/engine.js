// Analysis engine: turns raw wiki price data into flips, processing profits,
// trend signals, offer advice and a slot/budget plan. No DOM code in here.
//
// Price vocabulary (from the wiki API):
//   high = price someone recently INSTA-BOUGHT at (you sell into this)
//   low  = price someone recently INSTA-SOLD at  (you buy at this)
const Engine = (() => {
  const COINS_ID = 995, PLAT_ID = 13204, NATURE = 'Nature rune';
  const TAX_EXEMPT = new Set([13190]); // Old school bond

  class Market {
    constructor() {
      this.items = new Map(); this.byName = new Map();
      this.latest = {}; this.m5 = {}; this.h1 = {}; this.h6 = {}; this.h24 = {};
      this.updated = 0;
    }
    setMapping(arr) {
      for (const it of arr) { this.items.set(it.id, it); this.byName.set(it.name.toLowerCase(), it); }
    }
    find(nameOrId) {
      if (typeof nameOrId === 'number') return this.items.get(nameOrId);
      return this.byName.get(String(nameOrId).toLowerCase().trim());
    }
    // A flat snapshot of everything we know about an item's price right now.
    p(id) {
      const l = this.latest[id], a5 = this.m5[id] || {}, a1 = this.h1[id] || {}, a6 = this.h6[id] || {}, a24 = this.h24[id] || {};
      if (!l) return null;
      return {
        hi: l.high, lo: l.low, hiTime: l.highTime, loTime: l.lowTime,
        a5hi: a5.avgHighPrice, a5lo: a5.avgLowPrice, v5hi: a5.highPriceVolume || 0, v5lo: a5.lowPriceVolume || 0,
        a1hi: a1.avgHighPrice, a1lo: a1.avgLowPrice, v1hi: a1.highPriceVolume || 0, v1lo: a1.lowPriceVolume || 0,
        a6hi: a6.avgHighPrice, a6lo: a6.avgLowPrice,
        a24hi: a24.avgHighPrice, a24lo: a24.avgLowPrice, v24hi: a24.highPriceVolume || 0, v24lo: a24.lowPriceVolume || 0,
      };
    }
    // Conservative "what you'll realistically pay / receive" using latest trades checked
    // against the last hour's averages, so one-off outlier trades don't fool us.
    buyRef(id) {
      const p = this.p(id); if (!p) return null;
      const avg = p.a1lo ?? p.a6lo ?? p.a24lo;
      return maxDef(p.lo, avg);
    }
    sellRef(id) {
      const p = this.p(id); if (!p) return null;
      const avg = p.a1hi ?? p.a6hi ?? p.a24hi;
      return minDef(p.hi, avg);
    }
    instaBuy(id) { const p = this.p(id); return p ? (p.hi ?? p.a1hi ?? p.a24hi) : null; }
    instaSell(id) { const p = this.p(id); return p ? (p.lo ?? p.a1lo ?? p.a24lo) : null; }
    mid(id) {
      const p = this.p(id); if (!p) return null;
      const h = p.hi ?? p.a1hi, l = p.lo ?? p.a1lo;
      return h && l ? (h + l) / 2 : (h || l || null);
    }
    mid24(id) {
      const p = this.p(id); if (!p) return null;
      return p.a24hi && p.a24lo ? (p.a24hi + p.a24lo) / 2 : (p.a24hi || p.a24lo || null);
    }
    // Trades per hour that actually matched on both sides (24h average).
    volPerHour(id) {
      const p = this.p(id); if (!p) return 0;
      return Math.min(p.v24hi, p.v24lo) / 24;
    }
  }

  const maxDef = (...v) => { const d = v.filter(x => x != null); return d.length ? Math.max(...d) : null; };
  const minDef = (...v) => { const d = v.filter(x => x != null); return d.length ? Math.min(...d) : null; };

  function tax(price, s, id) {
    if (!price || price < 50 || TAX_EXEMPT.has(id)) return 0;
    return Math.min(Math.floor(price * s.taxRate), s.taxCap);
  }

  const nowSec = () => Date.now() / 1000;
  const ageMin = (t) => (t ? (nowSec() - t) / 60 : Infinity);

  // ---------------- Flips ----------------
  function flip(mk, it, s) {
    if (!s.members && it.members) return null;
    const p = mk.p(it.id);
    if (!p || !p.hi || !p.lo) return null;
    const vph = mk.volPerHour(it.id);
    if (vph <= 0) return null;
    const bRef = mk.buyRef(it.id), sRef = mk.sellRef(it.id);
    const buy = bRef + 1, sell = sRef - 1;
    const t = tax(sell, s, it.id);
    const margin = sell - buy - t;
    if (margin <= 0) return null;
    const roi = margin / buy;
    const limit = it.limit || null;
    const share = s.marketShare;
    const flowPerHour = vph * share;
    const units4h = Math.max(0, Math.floor(Math.min(limit ?? Infinity, flowPerHour * 4)));
    if (units4h < 1) return null;
    const fillHours = units4h / Math.max(flowPerHour, 1e-9);
    const profit4h = units4h * margin;

    // Confidence: how much to trust this margin.
    const reasons = [], risks = [];
    let conf = 1;
    const volF = Math.min(1, Math.log10(vph + 1) / 3); // ~1000 trades/hr => full marks
    conf *= 0.35 + 0.65 * volF;
    const freshest = Math.max(ageMin(p.hiTime), ageMin(p.loTime));
    if (freshest > 180) { conf *= 0.3; risks.push(`Last trade was ${fmtAge(freshest)} ago — prices may be stale.`); }
    else if (freshest > 45) { conf *= 0.65; risks.push(`Quiet item: last trades ${fmtAge(freshest)} ago.`); }
    if (p.a1hi && p.a1lo) {
      const avgMargin = p.a1hi - p.a1lo - tax(p.a1hi, s, it.id);
      if (avgMargin <= 0) { conf *= 0.45; risks.push('Over the last hour the average spread was not profitable after tax.'); }
      else reasons.push(`Last hour's average spread was also profitable (${fmtGp(avgMargin)} after tax).`);
    } else { conf *= 0.7; risks.push('Not enough trades in the last hour to double-check the margin.'); }
    if (roi > 0.15 && vph > 50) { conf *= 0.6; risks.push('Spread is unusually wide for a liquid item — could be a spike or manipulation.'); }
    if (p.a24hi && p.a24lo) {
      const normal = p.a24hi - p.a24lo;
      if (sell - buy > Math.max(3 * normal, buy * 0.02)) { conf *= 0.4; risks.push(`Today's spread is normally ~${fmtGp(normal)}; this one is much wider — likely a one-off trade.`); }
      if (sell > p.a24hi * 1.3) { conf *= 0.5; risks.push(`Sell price is ${pct(sell / p.a24hi - 1)} above the 24h average buy price — may not hold.`); }
    }
    const m = mk.mid(it.id), m24 = mk.mid24(it.id);
    const drift = m && m24 ? (m - m24) / m24 : 0;
    if (drift < -0.06) { conf *= 0.75; risks.push(`Price is ${pct(drift)} vs 24h average — falling items can drop while you hold.`); }
    if (drift > 0.08) { conf *= 0.8; risks.push(`Price is ${pct(drift)} above its 24h average — might be a temporary spike.`); }
    if (limit == null) { conf *= 0.85; risks.push('Buy limit unknown.'); }
    reasons.unshift(`About ${fmtNum(vph)} trades/hour on both sides, so offers should fill in ~${fmtHours(fillHours)}.`);

    return {
      id: it.id, name: it.name, icon: it.icon, members: it.members,
      buy, sell, tax: t, margin, roi, vph, limit, units4h, fillHours, profit4h,
      capital: units4h * buy, conf, drift, reasons, risks,
      gpPerHour: profit4h / Math.max(fillHours * 2, 0.5), // buy fill + sell fill
    };
  }

  function allFlips(mk, s) {
    const out = [];
    for (const it of mk.items.values()) { const f = flip(mk, it, s); if (f) out.push(f); }
    return out;
  }

  // ---------------- Processing / skilling ----------------
  function resolveRecipe(mk, r) {
    const map = (arr) => arr.map(([n, q]) => { const it = mk.find(n); return it ? { it, q } : null; });
    const ins = map(r.in), outs = map(r.out);
    if (ins.includes(null) || outs.includes(null)) return null;
    return { ...r, ins, outs };
  }

  // mode: 'patient' (buy with offers at the low, sell at the high) or 'instant' (insta-buy / insta-sell).
  function evalRecipe(mk, r, s, ctx) {
    const patient = ctx.mode !== 'instant';
    let cost = r.fee, revenue = 0, missing = false;
    for (const { it, q } of r.ins) {
      const pr = patient ? mk.buyRef(it.id) : mk.instaBuy(it.id);
      if (!pr) { missing = true; break; }
      cost += pr * q;
    }
    for (const { it, q } of r.outs) {
      if (it.id === COINS_ID) { revenue += q; continue; }
      const pr = patient ? mk.sellRef(it.id) : mk.instaSell(it.id);
      if (!pr) { missing = true; break; }
      revenue += (pr - tax(pr, s, it.id)) * q;
    }
    if (missing) return null;
    if (!s.members && (r.ins.some(x => x.it.members) || r.outs.some(x => x.it.members) || ['Herblore', 'Fletching'].includes(r.skill))) return null;
    const profit = revenue - cost;

    // What actually caps your hourly rate: speed, buy limits, or how much the market will absorb.
    let rate = r.perHour, cap = 'speed';
    for (const { it, q } of r.ins) {
      if (it.limit) { const lim = it.limit / q / 4; if (lim < rate) { rate = lim; cap = `buy limit on ${it.name}`; } }
    }
    for (const { it, q } of r.outs) {
      if (it.id === COINS_ID) continue;
      const absorb = (mk.p(it.id)?.v24hi || 0) / 24 * s.marketShare * 2 / q;
      if (absorb < rate) { rate = absorb; cap = `demand for ${it.name}`; }
    }
    const gpHr = profit * rate;
    const have = r.skill ? (ctx.levels?.[r.skill] ?? null) : null;
    const canDo = !r.skill || have == null ? null : have >= r.level;
    // How many actions can you do purely from items already in your bank?
    let fromBank = Infinity;
    for (const { it, q } of r.ins) fromBank = Math.min(fromBank, Math.floor((ctx.bank?.get(it.id) || 0) / q));
    const bankValueGain = fromBank > 0 && fromBank !== Infinity ? fromBank * profit : 0;
    const outVol = Math.min(...r.outs.filter(o => o.it.id !== COINS_ID).map(o => mk.volPerHour(o.it.id)).concat([Infinity]));
    return { ...r, cost, revenue, profit, rate, cap, gpHr, have, canDo, fromBank: fromBank === Infinity ? 0 : fromBank, bankValueGain, outVol };
  }

  // Auto-generated methods: potion decanting and high alchemy.
  function generatedRecipes(mk) {
    const out = [];
    const fams = new Map();
    for (const it of mk.items.values()) {
      const m = it.name.match(/^(.*)\(([1-4])\)$/);
      if (!m || !/dose/i.test(it.examine || '')) continue;
      if (!fams.has(m[1])) fams.set(m[1], {});
      fams.get(m[1])[m[2]] = it.name;
    }
    for (const [base, doses] of fams) {
      if (!doses[4]) continue;
      for (const d of ['1', '2', '3']) {
        if (!doses[d]) continue;
        const n = Number(d);
        // Decanting to 4-dose: 4 potions of n doses => n potions of 4 doses (scaled to whole potions).
        const inQ = 4 / gcd(4, n), outQ = n / gcd(4, n);
        out.push({ cat: 'No skill needed', name: `Decant ${base.trim()} (${d}) → (4)`, skill: null, level: 0, fee: 0, perHour: 1500 * outQ,
          in: [[doses[d], inQ]], out: [[doses[4], outQ]], notes: 'Bob Barter at the GE decants for free — no skill needed.' });
        out.push({ cat: 'No skill needed', name: `Decant ${base.trim()} (4) → (${d})`, skill: null, level: 0, fee: 0, perHour: 1500 * inQ,
          in: [[doses[4], outQ]], out: [[doses[d], inQ]], notes: 'Bob Barter at the GE decants for free. Some players pay more per dose for smaller potions.' });
      }
    }
    return out;
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);

  function alchs(mk, s, ctx) {
    const nat = mk.find(NATURE);
    const natCost = nat ? (ctx.mode === 'instant' ? mk.instaBuy(nat.id) : mk.buyRef(nat.id)) : 0;
    const out = [];
    for (const it of mk.items.values()) {
      if (!it.highalch || !it.limit) continue;
      if (!s.members && it.members) continue;
      // Skip illiquid or stale items: an alch is only real if you can actually buy them.
      const p = mk.p(it.id);
      if (!p || mk.volPerHour(it.id) < 10 || ageMin(p.loTime) > 120) continue;
      const price = ctx.mode === 'instant' ? mk.instaBuy(it.id) : mk.buyRef(it.id);
      if (!price) continue;
      const profit = it.highalch - price - natCost;
      if (profit <= 0) continue;
      const rate = Math.min(1200, it.limit / 4);
      const have = ctx.levels?.Magic ?? null;
      const owned = ctx.bank?.get(it.id) || 0;
      out.push({ cat: 'Magic', name: `High alch ${it.name}`, skill: 'Magic', level: 55, fee: 0, perHour: 1200,
        ins: [{ it, q: 1 }, ...(nat ? [{ it: nat, q: 1 }] : [])], outs: [],
        cost: price + natCost, revenue: it.highalch, profit, rate, cap: rate < 1200 ? `buy limit on ${it.name}` : 'speed',
        gpHr: profit * rate, canDo: have == null ? null : have >= 55, have,
        fromBank: owned, bankValueGain: owned * (it.highalch - natCost - (mk.instaSell(it.id) || 0)),
        outVol: mk.volPerHour(it.id),
        notes: `Alchs for ${fmtGp(it.highalch)}. Nature rune ≈ ${fmtGp(natCost)}. Buy limit ${fmtNum(it.limit)}/4h caps you at ${fmtNum(rate)} casts/hr.` });
    }
    return out.sort((a, b) => b.gpHr - a.gpHr).slice(0, 40);
  }

  // ---------------- Time-series analysis ----------------
  function series(points) {
    let lastH = null, lastL = null;
    return points.map(pt => {
      if (pt.avgHighPrice) lastH = pt.avgHighPrice;
      if (pt.avgLowPrice) lastL = pt.avgLowPrice;
      const h = pt.avgHighPrice ?? lastH, l = pt.avgLowPrice ?? lastL;
      return { t: pt.timestamp, h, l, mid: h && l ? (h + l) / 2 : (h || l), vol: (pt.highPriceVolume || 0) + (pt.lowPriceVolume || 0) };
    }).filter(x => x.mid);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const stdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const pctile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
  function slopePerHour(pts) { // linear regression of mid on time, as fraction of mean per hour
    if (pts.length < 3) return 0;
    const xs = pts.map(p => p.t / 3600), ys = pts.map(p => p.mid);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    return den ? num / den / my : 0;
  }
  function ema(vals, n) { const k = 2 / (n + 1); let e = vals[0]; for (const v of vals) e = v * k + e * (1 - k); return e; }

  // Deep look at one item. s5 = 5-minute series (~30h), s1 = 1-hour series (~15 days).
  function analyze(mk, it, raw5, raw1, s) {
    const s5 = series(raw5), s1 = series(raw1);
    const f = flip(mk, it, s);
    const cur = mk.mid(it.id) ?? s5.at(-1)?.mid;
    const out = { item: it, flip: f, s5, s1, cur, reasons: [], warnings: [] };
    if (!cur || s5.length < 12) { out.signal = 'NO DATA'; out.summary = 'Not enough recent trades to analyse this item.'; return out; }

    const last24 = s5.slice(-288), last6 = s5.slice(-72), last2 = s5.slice(-24);
    const m24 = mean(last24.map(p => p.mid)), sd24 = stdev(last24.map(p => p.mid)) || 1;
    const z = (cur - m24) / sd24;
    const slope2 = slopePerHour(last2), slope24 = slopePerHour(last24);
    const rets = []; for (let i = 1; i < s5.length; i++) rets.push(Math.log(s5[i].mid / s5[i - 1].mid));
    const vol5 = stdev(rets.slice(-288)); // per 5 min
    const emaS = ema(last6.map(p => p.mid), 6), emaL = ema(last24.map(p => p.mid), 48);
    const week = s1.slice(-168);
    const wkLo = week.length ? Math.min(...week.map(p => p.l || p.mid)) : null;
    const wkHi = week.length ? Math.max(...week.map(p => p.h || p.mid)) : null;
    const pos7 = wkLo != null && wkHi > wkLo ? (cur - wkLo) / (wkHi - wkLo) : 0.5;
    const volRecent = mean(s5.slice(-12).map(p => p.vol)), volBase = mean(last24.map(p => p.vol)) || 1;
    const volRatio = volRecent / volBase;
    Object.assign(out, { m24, sd24, z, slope2, slope24, vol5, emaS, emaL, wkLo, wkHi, pos7, volRatio });

    // Forward projection: momentum that fades + pull back toward the 24h mean.
    const drift = 0.6 * slope2 + 0.4 * slope24;
    const proj = (hours) => {
      const mom = cur * drift * hours * Math.exp(-hours / 3);
      const rev = (m24 - cur) * (1 - Math.exp(-hours / 8));
      const band = cur * vol5 * Math.sqrt(hours * 12);
      return { mid: cur + mom + rev, lo: cur + mom + rev - band, hi: cur + mom + rev + band };
    };
    out.proj1 = proj(1); out.proj4 = proj(4);

    // Patient offers: aim for the cheap/expensive end of the last 6 hours.
    out.patientBuy = Math.round(pctile(last6.map(p => p.l).filter(Boolean), 0.25) || cur);
    out.patientSell = Math.round(pctile(last6.map(p => p.h).filter(Boolean), 0.75) || cur);
    out.patientMargin = out.patientSell - out.patientBuy - tax(out.patientSell, s, it.id);

    // Signal
    let score = 0;
    const R = out.reasons, W = out.warnings;
    if (f && f.conf > 0.55) { score += 1; R.push(`Live flip margin of ${fmtGp(f.margin)} each (${pct(f.roi)}) with decent volume.`); }
    if (z < -1.5) { score += 1; R.push(`Price is unusually low vs the last 24h (${z.toFixed(1)}σ below average).`); }
    if (z > 1.5) { score -= 1; W.push(`Price is unusually high vs the last 24h (${z.toFixed(1)}σ above average).`); }
    if (pos7 < 0.2) { score += 1; R.push(`Near the bottom of its 7-day range (${fmtGp(wkLo)}–${fmtGp(wkHi)}).`); }
    if (pos7 > 0.85) { score -= 1; W.push(`Near the top of its 7-day range — good time to sell, risky to buy.`); }
    if (slope2 < -0.01) { score -= 1.5; W.push(`Falling fast right now (${pct(slope2)} per hour over the last 2h). Wait for it to level off.`); }
    else if (slope2 > 0.01) { score += 0.5; R.push(`Rising in the last 2h (${pct(slope2)}/hr).`); }
    if (emaS > emaL * 1.002) R.push('Short-term average is above the long-term average (upward momentum).');
    if (emaS < emaL * 0.998) W.push('Short-term average is below the long-term average (downward momentum).');
    if (volRatio > 2.5) W.push(`Volume is ${volRatio.toFixed(1)}× normal — something is happening (update, dump, or merch). Expect bigger swings.`);
    if (vol5 * Math.sqrt(12) > 0.03) W.push(`Volatile: typical 1-hour move is ±${pct(vol5 * Math.sqrt(12))}.`);

    if (score >= 2) out.signal = 'STRONG BUY';
    else if (score >= 1) out.signal = 'BUY / FLIP';
    else if (score <= -1.5) out.signal = 'AVOID / SELL';
    else if (score < 0) out.signal = 'CAUTION';
    else out.signal = 'NEUTRAL';
    const dir = out.proj4.mid > cur * 1.005 ? 'drift up' : out.proj4.mid < cur * 0.995 ? 'drift down' : 'stay about flat';
    out.summary = `Expected to ${dir} over the next 4 hours (≈${fmtGp(out.proj4.mid)}, likely range ${fmtGp(out.proj4.lo)}–${fmtGp(out.proj4.hi)}).`;
    return out;
  }

  // ---------------- Live offer advice ----------------
  // trade: { id, qty, buyPrice, sellPrice, stage: 'buying'|'holding'|'selling', placedAt, firstBuyAt }
  function adviseTrade(mk, tr, s) {
    const it = mk.items.get(tr.id); const p = mk.p(tr.id);
    if (!it || !p) return { level: 'info', text: 'No live price data for this item.' };
    const f = flip(mk, it, s);
    const sellNow = mk.sellRef(tr.id) - 1;
    const instaSell = mk.instaSell(tr.id);
    const breakeven = Math.ceil(breakevenPrice(tr.buyPrice, s, tr.id));
    const mins = (Date.now() - (tr.placedAt || Date.now())) / 60000;
    const resetAt = tr.firstBuyAt ? tr.firstBuyAt + 4 * 3600e3 : null;
    const extra = { breakeven, resetAt, sellNow, unrealized: null };

    if (tr.stage === 'buying') {
      const marketLo = p.lo;
      if (tr.buyPrice > p.hi) return { ...extra, suggest: mk.buyRef(tr.id) + 1, level: 'warn', text: `You're bidding above the current insta-buy price (${fmtGp(p.hi)}). Lower your offer to about ${fmtGp(mk.buyRef(tr.id) + 1)} — you're overpaying.` };
      if (marketLo > tr.buyPrice && mins > 5) {
        const newBuy = marketLo + 1;
        const m = sellNow - newBuy - tax(sellNow, s, tr.id);
        if (m > 0) return { ...extra, suggest: newBuy, level: 'act', text: `Market moved up: people are now selling at ${fmtGp(marketLo)}. Raise your offer to ${fmtGp(newBuy)} to fill — you'd still make ~${fmtGp(m)} each.` };
        return { ...extra, level: 'act', text: `Market moved past you and the margin is gone at ${fmtGp(newBuy)}. Cancel this offer and pick another flip.` };
      }
      if (f && tr.buyPrice < f.buy - Math.max(2, f.buy * 0.01) && mins > 15) return { ...extra, suggest: f.buy, level: 'act', text: `No fills likely at ${fmtGp(tr.buyPrice)} — recent sells are around ${fmtGp(p.lo)}. Raise to ${fmtGp(f.buy)} or wait.` };
      return { ...extra, level: 'ok', text: `Offer looks well placed (recent sells at ${fmtGp(p.lo)}). Plan to sell at ~${fmtGp(sellNow)}.` };
    }

    const unreal = (sellNow - tax(sellNow, s, tr.id) - tr.buyPrice) * tr.qty;
    extra.unrealized = unreal;
    const m = mk.mid(tr.id), m24 = mk.mid24(tr.id);
    const falling = m && m24 && m < m24 * 0.97;
    if (tr.stage === 'holding') {
      extra.verdict = sellNow >= breakeven ? 'sell' : 'hold';
      extra.listAt = Math.max(sellNow, breakeven);
      if (sellNow >= breakeven) return { ...extra, level: 'act', text: `Sell now: list at ${fmtGp(sellNow)} for ~${fmtGp(unreal)} profit total.` };
      if (falling) return { ...extra, level: 'warn', text: `Below breakeven (${fmtGp(breakeven)}) and the price is falling. Consider cutting losses at ${fmtGp(instaSell)} (insta-sell) or listing at breakeven and waiting.` };
      if (m24 && m24 < breakeven * 0.95) return { ...extra, level: 'warn', text: `You paid well above today's normal price (24h average ${fmtGp(m24)}), so breakeven (${fmtGp(breakeven)}) may not come back soon. Selling at ${fmtGp(sellNow)} frees your cash for a ${fmtGp(-unreal)} loss — often better than tying up a slot.` };
      return { ...extra, level: 'warn', text: `Currently below breakeven (${fmtGp(breakeven)}). List at ${fmtGp(breakeven)} and be patient — the 24h average is ${fmtGp(m24)}.` };
    }
    if (tr.stage === 'selling') {
      if (tr.sellPrice <= p.lo) return { ...extra, suggest: sellNow, level: 'warn', text: `Your ask (${fmtGp(tr.sellPrice)}) is at or below the insta-sell price — you could ask more. Try ${fmtGp(sellNow)}.` };
      if (tr.sellPrice > p.hi && mins > 10) {
        if (sellNow >= breakeven) return { ...extra, suggest: sellNow, level: 'act', text: `Nobody is buying at ${fmtGp(tr.sellPrice)} (last insta-buy ${fmtGp(p.hi)}). Lower to ${fmtGp(sellNow)} — still ${fmtGp(unreal)} profit.` };
        return { ...extra, level: 'warn', text: `Price dropped under your ask and breakeven (${fmtGp(breakeven)}). Hold your listing or lower to cut the loss.` };
      }
      return { ...extra, level: 'ok', text: `Ask is competitive (last insta-buy ${fmtGp(p.hi)}). Expected profit ~${fmtGp((tr.sellPrice - tax(tr.sellPrice, s, tr.id) - tr.buyPrice) * tr.qty)}.` };
    }
    return { ...extra, level: 'info', text: '' };
  }
  function breakevenPrice(cost, s, id) {
    // smallest sell price p where p - tax(p) >= cost
    if (cost < 49 || TAX_EXEMPT.has(id)) return cost;
    let p = Math.ceil(cost / (1 - s.taxRate));
    while (p - tax(p, s, id) < cost) p++;
    while (p - 1 - tax(p - 1, s, id) >= cost) p--;
    return p;
  }

  // ---------------- Slot/budget planner ----------------
  // Greedy slot filling, tried with three strategies; the plan with the best risk-weighted
  // profit wins. "big" chases the largest single profits, "roi" the best return per gp,
  // "split" caps each slot at an equal share of cash so one item can't eat the whole budget.
  function plan(flips, s, budget, slots, minConf) {
    const pool = flips.filter(f => f.conf >= minConf && f.fillHours <= s.horizonHours);
    const run = (strategy) => {
      let cash = budget;
      const chosen = [];
      const slotCap = strategy === 'split' ? budget / slots : Infinity;
      for (let i = 0; i < slots && cash > 0; i++) {
        let best = null, bestScore = 0;
        for (const f of pool) {
          if (chosen.some(c => c.id === f.id)) continue;
          const units = Math.min(f.units4h, Math.floor(Math.min(cash, slotCap) / f.buy));
          if (units < 1) continue;
          const weighted = units * f.margin * f.conf;
          const score = strategy === 'roi' ? weighted / (units * f.buy) * Math.min(1, weighted / 20000) : weighted;
          if (score > bestScore) { bestScore = score; best = { ...f, units, cost: units * f.buy, expProfit: units * f.margin, weighted }; }
        }
        // A GE slot is worth more than a few hundred gp; leave it free rather than waste it.
        if (!best || best.expProfit < Math.max(5000, Math.min(50000, budget * 0.002))) break;
        chosen.push(best); cash -= best.cost;
      }
      return { chosen, used: budget - cash, profit: chosen.reduce((a, c) => a + c.expProfit, 0), weighted: chosen.reduce((a, c) => a + c.weighted, 0), strategy };
    };
    return ['big', 'roi', 'split'].map(run).sort((a, b) => b.weighted - a.weighted)[0];
  }

  // ---------------- Market pulse ----------------
  function movers(mk, s) {
    const rows = [];
    for (const it of mk.items.values()) {
      if (!s.members && it.members) continue;
      const vph = mk.volPerHour(it.id);
      // Use last hour's averages (not single latest trades) so one odd trade isn't a "spike".
      const p = mk.p(it.id), m24 = mk.mid24(it.id);
      if (!p || !p.a1hi || !p.a1lo || p.v1hi < 5 || p.v1lo < 5) continue;
      const m = (p.a1hi + p.a1lo) / 2;
      if (!m24 || vph < 50 || m < 100) continue;
      const change = (m - m24) / m24;
      const volSurge = p.v1hi + p.v1lo > 0 ? (p.v1hi + p.v1lo) / ((p.v24hi + p.v24lo) / 24 || 1) : 0;
      rows.push({ id: it.id, name: it.name, icon: it.icon, m, m24, change, vph, volSurge });
    }
    return {
      dips: rows.filter(r => r.change < -0.03).sort((a, b) => a.change - b.change).slice(0, 12),
      spikes: rows.filter(r => r.change > 0.03).sort((a, b) => b.change - a.change).slice(0, 12),
      surges: rows.filter(r => r.volSurge > 2.5 && r.vph > 50).sort((a, b) => b.volSurge - a.volSurge).slice(0, 12),
    };
  }

  // ---------------- Bank import ----------------
  // Accepts RuneLite Bank Memory / Data Export copies (TSV/CSV/JSON) and plain "Name x 123" lines.
  function parseBank(text, mk) {
    const out = new Map(), unknown = [];
    const addQty = (id, q) => out.set(id, (out.get(id) || 0) + q);
    const parseQty = (str) => {
      const m = String(str).trim().toLowerCase().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
      if (!m) return null;
      return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
    };
    const resolveName = (n) => {
      const clean = n.trim().replace(/^"|"$/g, '');
      if (/^coins?$/i.test(clean)) return COINS_ID;
      if (/^platinum tokens?$/i.test(clean)) return PLAT_ID;
      return mk.find(clean)?.id ?? null;
    };
    const t = text.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        const j = JSON.parse(t);
        const arr = Array.isArray(j) ? j : Array.isArray(j.items) ? j.items : Object.entries(j).map(([k, v]) => ({ id: Number(k), quantity: v }));
        for (const e of arr) {
          const id = e.id ?? (e.name ? resolveName(e.name) : null);
          const q = Number(e.quantity ?? e.qty ?? e.amount ?? 1);
          if (id != null && q > 0) addQty(Number(id), q); else unknown.push(JSON.stringify(e));
        }
        return { items: out, unknown };
      } catch { /* fall through to line parsing */ }
    }
    for (const rawLine of t.split(/\r?\n/)) {
      const line = rawLine.trim(); if (!line) continue;
      let m;
      if ((m = line.match(/^(.+?)\s*[x×:]\s*([\d.,]+[kmb]?)$/i)) && resolveName(m[1]) != null) { addQty(resolveName(m[1]), parseQty(m[2]) || 1); continue; }
      if ((m = line.match(/^([\d.,]+[kmb]?)\s*[x×]?\s+(.+)$/i)) && resolveName(m[2]) != null) { addQty(resolveName(m[2]), parseQty(m[1]) || 1); continue; }
      const cells = line.includes('\t') ? line.split('\t') : line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      const nums = [], names = [];
      for (const c of cells) { const q = parseQty(c); if (q != null) nums.push(q); else if (c.trim()) names.push(c); }
      let id = null;
      for (const n of names) { id = resolveName(n); if (id != null) break; }
      if (id != null) { addQty(id, nums.length ? nums[nums.length - 1] : 1); continue; }
      if (nums.length >= 2 && (mk.items.has(nums[0]) || nums[0] === COINS_ID)) { addQty(nums[0], nums[1]); continue; }
      if (names.length && /item|name|id|qty|quantity/i.test(names.join(' '))) continue; // header row
      unknown.push(line);
    }
    return { items: out, unknown };
  }

  // ---------------- Formatting helpers (shared with UI) ----------------
  function fmtGp(n) {
    if (n == null || !isFinite(n)) return '—';
    const a = Math.abs(n), sign = n < 0 ? '-' : '';
    if (a >= 1e9) return sign + (a / 1e9).toFixed(2) + 'b';
    if (a >= 1e7) return sign + (a / 1e6).toFixed(1) + 'm';
    if (a >= 1e6) return sign + (a / 1e6).toFixed(2) + 'm';
    if (a >= 1e5) return sign + (a / 1e3).toFixed(0) + 'k';
    return sign + Math.round(a).toLocaleString();
  }
  function fmtNum(n) { if (n == null || !isFinite(n)) return '—'; return n >= 1e4 ? fmtGp(n) : Math.round(n).toLocaleString(); }
  function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0) + '%'; }
  function fmtAge(min) { if (!isFinite(min)) return 'a long time'; if (min < 60) return Math.round(min) + 'm'; if (min < 2880) return (min / 60).toFixed(1) + 'h'; return Math.round(min / 1440) + 'd'; }
  function fmtHours(h) { if (h < 1 / 60) return '<1 min'; if (h < 1) return Math.round(h * 60) + ' min'; return h.toFixed(1) + ' h'; }

  return {
    Market, tax, flip, allFlips, resolveRecipe, evalRecipe, generatedRecipes, alchs, analyze, adviseTrade,
    breakevenPrice, plan, movers, parseBank, fmtGp, fmtNum, pct, fmtAge, fmtHours, COINS_ID, PLAT_ID,
  };
})();
