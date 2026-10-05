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
 * Familias extra (cada una con su propia selección en train y prueba en test):
 *   - momentum: el BTC de Binance se movió ≥ m% en los últimos k s → comprar ese lado
 *   - anclada: precio justo = mid de Polymarket + cuánto se movió el modelo desde que ese mid
 *     cambió por última vez (el modelo solo aporta el movimiento que Polymarket no reflejó)
 *   - vivo: los intentos de compra reales del bot (columnas sig/pass, desde el 05/10)
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
      rows.push({ sl, p, yb: r[c.yes_bid], ya: r[c.yes_ask], nb: r[c.no_bid], na: r[c.no_ask], sig: r[c.sigma_e6],
        btc: r[c.btc] ?? null, bsig: c.sig != null ? r[c.sig] : null, pass: c.pass != null ? r[c.pass] : null });
    }
    // Ancla de cada fila: p del modelo en el segundo en que el mid de YES tomó su valor actual
    let aMid = null, aP = null;
    for (const r of rows) {
      if (!r || r.ya == null || r.yb == null) { aMid = null; continue; }
      const mid = (r.ya + r.yb) / 2;
      if (aMid == null || Math.abs(mid - aMid) > 1e-9) { aMid = mid; aP = r.p; }
      r.pAdj = Math.min(0.999, Math.max(0.001, mid + (r.p - aP)));
    }
    markets.push({ start: m.start_ts, winner: m.winner, rows, live: c.pass != null });
  }
  return markets.sort((a, b) => a.start - b.start);
}

// ¿La fila i dispara la regla para este lado? (según la familia)
function fires(R, i, side, cfg, ask, bid) {
  const r = R[i];
  if (cfg.kind === 'momentum') {
    const j = R[i - cfg.k];
    if (!j || j.btc == null || r.btc == null) return false;
    const mv = (r.btc / j.btc - 1) * 100;
    return side === 'UP' ? mv >= cfg.m : mv <= -cfg.m;
  }
  if (cfg.kind === 'anchored') {
    const pa = side === 'UP' ? r.pAdj : 1 - r.pAdj;
    return pa != null && pa - ask - fee(ask) >= cfg.e;
  }
  if (cfg.kind === 'live') return (cfg.field === 'pass' ? r.pass : r.bsig) === (side === 'UP' ? 1 : -1);
  const pm = side === 'UP' ? r.p : 1 - r.p;
  const mid = bid != null ? (bid + ask) / 2 : ask;
  const pa = cfg.lam * pm + (1 - cfg.lam) * mid;
  return pa - ask - fee(ask) >= cfg.e;
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
      if (!fires(R, i, side, cfg, ask, bid)) continue;
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

function gridMomentum() {
  const out = [];
  for (const k of [5, 10, 20, 30, 60])
    for (const m of [0.02, 0.03, 0.05, 0.08])
      for (const lo of [0.30, 0.50, 0.60])
        for (const hi of [0.70, 0.80, 0.90])
          for (const [tMax, tMin] of [[295, 10], [240, 60], [240, 120], [180, 60], [120, 30]])
            out.push({ kind: 'momentum', k, m, lo, hi, tMax, tMin });
  return out;
}

function gridAnchored() {
  const out = [];
  for (const e of [0.01, 0.02, 0.03, 0.05, 0.08])
    for (const lo of [0.30, 0.50, 0.60])
      for (const hi of [0.70, 0.80, 0.90])
        for (const [tMax, tMin] of [[295, 10], [240, 60], [240, 120], [180, 60], [120, 30]])
          out.push({ kind: 'anchored', e, lo, hi, tMax, tMin });
  return out;
}

// Selección en train (EV/acc·√n, n ≥ 30) y resultado de los mejores en test
function selectFamily(train, test, all, cfgs, keep = 10) {
  const res = [];
  for (const cfg of cfgs) {
    const tr = evaluate(train, cfg);
    if (tr.n >= 30) res.push({ cfg, train: tr });
  }
  res.sort((a, b) => (b.train.evPerShare * Math.sqrt(b.train.n)) - (a.train.evPerShare * Math.sqrt(a.train.n)));
  return { evaluated: res.length, top: res.slice(0, keep).map(r => ({ ...r, test: evaluate(test, r.cfg), all: evaluate(all, r.cfg) })) };
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

// EV real por franja de ask (0.05) × tiempo restante: comprar el lado a su ask en ese
// momento, sin ninguna condición del modelo. Una muestra por mercado y celda. Con el ask
// del segundo siguiente (1 s de latencia en contra) y comisión.
const T_BUCKETS = [[270, 240], [240, 180], [180, 120], [120, 60], [60, 30], [30, 10]];
function evGrid(markets) {
  const cells = {};
  for (const mk of markets) {
    for (const [hiT, loT] of T_BUCKETS) {
      const mid = (hiT + loT) / 2;
      let i = mk.rows.findIndex(x => x && x.sl <= mid);
      if (i < 0) continue;
      const r = mk.rows[i], nx = mk.rows[i + 1];
      for (const side of ['UP', 'DOWN']) {
        let a = side === 'UP' ? r.ya : r.na;
        const a2 = nx ? (side === 'UP' ? nx.ya : nx.na) : null;
        if (a == null) continue;
        a = Math.max(a, a2 ?? a);
        if (a <= 0.02 || a >= 0.98) continue;
        const pb = Math.min(19, Math.floor(a / 0.05));
        const k = `${hiT}-${loT}|${(pb * 0.05).toFixed(2)}`;
        const ev = (side === mk.winner ? 1 : 0) - a - fee(a);
        const c = (cells[k] ||= { n: 0, s: 0, s2: 0, w: 0, a: 0 });
        c.n++; c.s += ev; c.s2 += ev * ev; c.w += side === mk.winner ? 1 : 0; c.a += a;
      }
    }
  }
  return Object.entries(cells).map(([k, c]) => {
    const m = c.s / c.n, sd = Math.sqrt(Math.max(0, c.s2 / c.n - m * m));
    return { k, n: c.n, ask: +(c.a / c.n).toFixed(3), wr: +(c.w / c.n).toFixed(3), ev: +m.toFixed(4), se: +(sd / Math.sqrt(c.n)).toFixed(4) };
  }).sort((x, y) => x.k < y.k ? -1 : 1);
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
    evGrid: { train: evGrid(train), test: evGrid(test) },
    momentum: selectFamily(train, test, markets, gridMomentum()),
    anchored: selectFamily(train, test, markets, gridAnchored()),
  };
  // Regla real del bot: solo mercados con las columnas nuevas (sin train/test hasta tener volumen)
  const liveMk = markets.filter(m => m.live);
  report.live = {
    markets: liveMk.length,
    attempts: evaluate(liveMk, { kind: 'live', field: 'pass', lo: 0, hi: 1, tMax: 300, tMin: 0 }),
    signals_240: evaluate(liveMk, { kind: 'live', field: 'sig', lo: 0.5, hi: 0.85, tMax: 240, tMin: 10 }),
  };
  fs.writeFileSync(OUT, JSON.stringify(report));
  const b = report.baseline.all, best = top[0];
  const fam = (f) => { const t = f.top[0]; return t ? `mejor train ${JSON.stringify(t.cfg)} n=${t.train.n} EV/acc=${t.train.evPerShare} → test n=${t.test.n} EV/acc=${t.test.evPerShare} z=${t.test.z}` : 'sin reglas con n ≥ 30'; };
  console.log(`[BACKTEST-MOMENTUM] ${fam(report.momentum)}`);
  console.log(`[BACKTEST-ANCLA] ${fam(report.anchored)}`);
  const lv = report.live;
  console.log(`[BACKTEST-VIVO] ${lv.markets} mercados con señal grabada | intentos del bot: n=${lv.attempts.n} WR=${lv.attempts.wr} EV/acc=${lv.attempts.evPerShare} | primera señal 240-10 s a $0.50-0.85: n=${lv.signals_240.n} EV/acc=${lv.signals_240.evPerShare}`);
  console.log(`[BACKTEST] ${markets.length} mercados (${report.from} → ${report.to}) en ${report.secs}s | base: n=${b.n} WR=${b.wr} EV/acc=${b.evPerShare} | mejor train ${JSON.stringify(best?.cfg)} → test n=${best?.test.n} EV/acc=${best?.test.evPerShare} | ${OUT}`);
})().catch(e => { console.error(`[BACKTEST] error: ${e.stack || e.message}`); process.exit(1); });
