#!/usr/bin/env node
/**
 * Backtest de reglas de entrada sobre shadow-ticks.jsonl (un registro por mercado con
 * P(UP) del modelo FAIR, bid/ask de UP y DOWN cada segundo y el ganador oficial).
 *
 * Familia de reglas (una entrada por mercado, la primera que cumple):
 *   - ventana: segundos restantes en [tMin, tMax]
 *   - precio: ask del lado en [lo, hi]
 *   - probabilidad ajustada pa = λ·p_modelo + (1−λ)·mid_mercado  (λ=1: modelo puro)
 *   - ventaja neta pa − precio − comisión(precio) ≥ eMin
 * Fill conservador: max(ask en t, ask en t+1) — un segundo de latencia en contra.
 * Comisión taker 0.07·p·(1−p) por acción. $5 por trade (floor(5/precio) acciones).
 *
 * Validación: los mercados se ordenan por tiempo; las reglas se eligen con el 60% más
 * viejo (train) y se reporta cómo les fue en el 40% más nuevo (test), que no se usó
 * para elegir. Uso: node scripts/backtest.js [shadow-ticks.jsonl] [salida.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = process.env.DATA_DIR || '/data';
const IN = process.argv[2] || path.join(DATA_DIR, 'shadow-ticks.jsonl');
const OUT = process.argv[3] || path.join(DATA_DIR, 'backtest-report.json');
const FEE = 0.07;
const fee = p => FEE * p * (1 - p);
const STAKE = 5;

async function load(file) {
  const markets = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.winner !== 'UP' && m.winner !== 'DOWN') continue;
    const c = Object.fromEntries((m.cols || []).map((k, i) => [k, i]));
    const rows = [];
    for (const r of m.rows || []) {
      const p = r[c.p_up], sl = r[c.secs_left], src = r[c.src];
      if (p == null || sl == null || src !== 1) { rows.push(null); continue; }
      rows.push({ sl, p, yb: r[c.yes_bid], ya: r[c.yes_ask], nb: r[c.no_bid], na: r[c.no_ask], sig: r[c.sigma_e6] });
    }
    markets.push({ start: m.start_ts, winner: m.winner, rows });
  }
  return markets.sort((a, b) => a.start - b.start);
}

// Primera entrada de una regla en un mercado → { side, price } o null
function entry(mk, cfg) {
  const R = mk.rows;
  for (let i = 0; i < R.length - 1; i++) {
    const r = R[i];
    if (!r || r.sl > cfg.tMax || r.sl < cfg.tMin) continue;
    for (const side of ['UP', 'DOWN']) {
      const ask = side === 'UP' ? r.ya : r.na, bid = side === 'UP' ? r.yb : r.nb;
      if (ask == null || ask < cfg.lo || ask > cfg.hi) continue;
      const pm = side === 'UP' ? r.p : 1 - r.p;
      const mid = bid != null ? (bid + ask) / 2 : ask;
      const pa = cfg.lam * pm + (1 - cfg.lam) * mid;
      if (pa - ask - fee(ask) < cfg.e) continue;
      const nx = R[i + 1];
      const ask2 = nx ? (side === 'UP' ? nx.ya : nx.na) : null;
      const price = Math.max(ask, ask2 ?? ask);
      if (price > cfg.hi + 0.02 || price >= 0.99) return null; // el precio se escapó
      return { side, price };
    }
  }
  return null;
}

function evaluate(markets, cfg) {
  let n = 0, w = 0, pnl = 0, exp = 0, varr = 0, perShare = 0;
  for (const mk of markets) {
    const e = entry(mk, cfg);
    if (!e) continue;
    const win = e.side === mk.winner;
    const sh = Math.floor(STAKE / e.price);
    const ps = (win ? 1 - e.price : -e.price) - fee(e.price);
    n++; if (win) w++;
    pnl += sh * ps; perShare += ps;
    exp += e.price; varr += e.price * (1 - e.price);
  }
  return { n, wr: n ? +(w / n).toFixed(3) : null, avgPrice: n ? +(exp / n).toFixed(3) : null,
    evPerShare: n ? +(perShare / n).toFixed(4) : null, pnl: +pnl.toFixed(2),
    z: varr ? +((w - exp) / Math.sqrt(varr)).toFixed(2) : null };
}

function grid() {
  const out = [];
  for (const lam of [1, 0.75, 0.5, 0.25])
    for (const e of [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15])
      for (const lo of [0.30, 0.50, 0.59, 0.65, 0.70])
        for (const hi of [0.75, 0.80, 0.85, 0.90, 0.95])
          for (const [tMax, tMin] of [[295, 10], [270, 30], [240, 60], [240, 120], [180, 60], [120, 30], [90, 10]])
            if (hi > lo) out.push({ lam, e, lo, hi, tMax, tMin });
  return out;
}

function calibration(markets) {
  // P(UP) del modelo y precio medio de UP vs resultado, por tramo (una muestra por mercado
  // en tres momentos: 240, 150 y 60 s restantes)
  const bins = {};
  for (const mk of markets) for (const target of [240, 150, 60]) {
    const r = mk.rows.find(x => x && Math.abs(x.sl - target) < 1);
    if (!r || r.ya == null || r.yb == null) continue;
    const up = mk.winner === 'UP' ? 1 : 0, mid = (r.ya + r.yb) / 2;
    for (const [kind, v] of [['modelo', r.p], ['mercado', mid]]) {
      const b = `${kind}|${Math.min(9, Math.floor(v * 10))}`;
      (bins[b] ||= { n: 0, sum: 0, up: 0 }); bins[b].n++; bins[b].sum += v; bins[b].up += up;
    }
  }
  return Object.entries(bins).sort().map(([k, b]) => ({ k, n: b.n, pred: +(b.sum / b.n).toFixed(3), real: +(b.up / b.n).toFixed(3) }));
}

(async () => {
  const t0 = Date.now();
  const markets = await load(IN);
  const cut = Math.floor(markets.length * 0.6);
  const train = markets.slice(0, cut), test = markets.slice(cut);
  const results = [];
  for (const cfg of grid()) {
    const tr = evaluate(train, cfg);
    if (tr.n < 30) continue;
    results.push({ cfg, train: tr });
  }
  // Ranking por P&L de train penalizado por varianza (z) — evita reglas con 3 trades de suerte
  results.sort((a, b) => (b.train.evPerShare * Math.sqrt(b.train.n)) - (a.train.evPerShare * Math.sqrt(a.train.n)));
  const top = results.slice(0, 40).map(r => ({ ...r, test: evaluate(test, r.cfg), all: evaluate(markets, r.cfg) }));
  const baseline = { lam: 1, e: 0.08, lo: 0.59, hi: 0.79, tMax: 270, tMin: 10 };
  const report = {
    generatedAt: new Date().toISOString(), secs: (Date.now() - t0) / 1000,
    markets: markets.length, train: train.length, test: test.length,
    from: markets[0] && new Date(markets[0].start).toISOString(),
    to: markets.length && new Date(markets[markets.length - 1].start).toISOString(),
    configsEvaluated: results.length,
    baseline: { cfg: baseline, train: evaluate(train, baseline), test: evaluate(test, baseline), all: evaluate(markets, baseline) },
    top,
    calibration: calibration(markets),
  };
  fs.writeFileSync(OUT, JSON.stringify(report));
  const b = report.baseline.all, best = top[0];
  console.log(`[BACKTEST] ${markets.length} mercados (${report.from} → ${report.to}) en ${report.secs}s | base: n=${b.n} WR=${b.wr} EV/acc=${b.evPerShare} | mejor train ${JSON.stringify(best?.cfg)} → test n=${best?.test.n} EV/acc=${best?.test.evPerShare} | ${OUT}`);
})().catch(e => { console.error(`[BACKTEST] error: ${e.stack || e.message}`); process.exit(1); });
