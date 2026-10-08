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
 * Comisión taker TAKER_FEE_RATE (0.072)·p·(1−p) por acción. $5 por trade (floor(5/precio) acciones).
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
const FEE = parseFloat(process.env.TAKER_FEE_RATE || '0.072');
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
        btc: r[c.btc] ?? null, bsig: c.sig != null ? r[c.sig] : null, pass: c.pass != null ? r[c.pass] : null,
        z: c.z != null ? r[c.z] : null, mv: c.move_pct != null ? r[c.move_pct] : null });
    }
    // Ancla de cada fila: p del modelo en el segundo en que el mid de YES tomó su valor actual
    let aMid = null, aP = null;
    for (const r of rows) {
      if (!r || r.ya == null || r.yb == null) { aMid = null; continue; }
      const mid = (r.ya + r.yb) / 2;
      if (aMid == null || Math.abs(mid - aMid) > 1e-9) { aMid = mid; aP = r.p; }
      r.pAdj = Math.min(0.999, Math.max(0.001, mid + (r.p - aP)));
    }
    // TWAP 60 s de Binance (USDT) en el cierre: promedio de las filas de los últimos 60 s ([BACKTEST-SINCL])
    let bs = 0, bn = 0;
    for (const r of m.rows || []) {
      const t = r[c.t], b = r[c.btc];
      if (t != null && t >= 240 && t <= 300 && b != null) { bs += b; bn++; }
    }
    markets.push({ start: m.start_ts, winner: m.winner, rows, live: c.pass != null,
      strike: Number.isFinite(m.strike) ? m.strike : null, bnClose60: bn >= 45 ? bs / bn : null });
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
  // Señal real del bot + filtro FAIR como en vivo (ventaja = P_modelo − ask, sin comisión; ask ≥ 0.50)
  if (cfg.kind === 'livegate') {
    if (r.bsig !== (side === 'UP' ? 1 : -1) || ask < 0.5) return false;
    return (side === 'UP' ? r.p : 1 - r.p) - ask >= cfg.e;
  }
  // Señal aproximada con el estado de Binance que graba el shadow cada segundo (z y movimiento
  // de SignalEngine.snapshot) + el mismo filtro FAIR: sirve para ver si umbrales más bajos
  // dispararían antes y a mejor precio. No reproduce los filtros secundarios de la señal real.
  if (cfg.kind === 'zgate') {
    const s = side === 'UP' ? 1 : -1;
    if (r.z == null || r.mv == null || ask < 0.5) return false;
    if (r.z * s < cfg.zt || r.mv * s < cfg.mt) return false;
    return (side === 'UP' ? r.p : 1 - r.p) - ask >= cfg.e;
  }
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
    for (const side of cfg.side ? [cfg.side] : ['UP', 'DOWN']) {
      const ask = side === 'UP' ? r.ya : r.na, bid = side === 'UP' ? r.yb : r.nb;
      if (ask == null || ask < cfg.lo || ask > cfg.hi) continue;
      if (!fires(R, i, side, cfg, ask, bid)) continue;
      const nx = R[i + 1];
      const ask2 = nx ? (side === 'UP' ? nx.ya : nx.na) : null;
      const price = Math.max(ask, ask2 ?? ask);
      if (price > cfg.hi + 0.02 || price >= 0.99) return null; // el precio se escapó
      return { side, price, i };
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

// Sin Chainlink: Polymarket retira los temas de precio del RTDS (~23/10, fecha no oficial) y el
// reemplazo (PolyBolt) pide credenciales de una cuenta. Con solo Binance: strike ≈ TWAP 60 s de
// Binance en la apertura − base y cierre ≈ TWAP 60 s de Binance en el cierre − base, así que el
// resultado (cierre ≥ strike) no depende de la base. Se compara con el oficial: el strike de cada
// mercado es el TWAP 60 s de Chainlink (= priceToBeat) y la apertura del siguiente es este cierre.
// La base para un strike absoluto se calibra con priceToBeat ya publicados (Gamma lo publica al
// resolver): mercados n−8..n−2.
function sinChainlink(markets, liveMk, cur) {
  const byStart = new Map(markets.map(m => [m.start, m]));
  let n = 0, agree = 0, near = 0, nearAgree = 0, entries = 0, entriesDiff = 0;
  const moveErr = [], strikeErr = [], dHist = [];
  for (const m of markets) {
    const prev = byStart.get(m.start - 300000), next = byStart.get(m.start + 300000);
    const open = prev?.bnClose60, close = m.bnClose60;
    if (open == null || m.strike == null) continue;
    const d = open - m.strike; // base Binance − Chainlink medida TWAP contra TWAP
    if (dHist.length >= 4) {
      const ref = dHist.slice(-8, -1).sort((a, b) => a - b);
      strikeErr.push(d - ref[Math.floor(ref.length / 2)]);
    }
    dHist.push(d);
    if (close == null || next?.strike == null) continue;
    const bnWinner = close >= open ? 'UP' : 'DOWN';
    const clMove = next.strike - m.strike;
    n++; if (bnWinner === m.winner) agree++;
    if (Math.abs(clMove) < 10) { near++; if (bnWinner === m.winner) nearAgree++; }
    moveErr.push((close - open) - clMove);
    m.bnWinner = bnWinner;
  }
  for (const mk of liveMk) {
    const e = entry(mk, cur);
    if (!e || !mk.bnWinner) continue;
    entries++; if (mk.bnWinner !== mk.winner) entriesDiff++;
  }
  const q = (arr) => {
    const a = arr.map(Math.abs).sort((x, y) => x - y);
    const at = p => a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : null;
    return { n: a.length, p50: at(0.5), p90: at(0.9), max: a.length ? +a[a.length - 1].toFixed(2) : null };
  };
  const pct = (a, b) => b ? +(a / b * 100).toFixed(1) : null;
  return { n, agreePct: pct(agree, n), near, nearAgreePct: pct(nearAgree, near), moveErr: q(moveErr), strikeErr: q(strikeErr), entries, entriesDiff };
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
  // Sensibilidad de los filtros de la regla real (tope de precio × ventaja mínima del filtro FAIR).
  // Actual: ask ≤ 0.79 (orden ≤ 0.80) y ventaja ≥ 8 pts. Sin train/test: es una tabla para mirar,
  // no una selección; con pocos mercados las diferencias chicas son ruido.
  report.liveGrid = [];
  for (const hi of [0.74, 0.79, 0.84, 0.89])
    for (const e of [0.04, 0.06, 0.08, 0.10])
      report.liveGrid.push({ hi, e, ...evaluate(liveMk, { kind: 'livegate', e, lo: 0.59, hi, tMax: 240, tMin: 10 }) });
  // Por lado (UP/DOWN): 6 de las primeras 7 pérdidas con la regla de 240 s fueron DOWN. Con cfg.side la regla
  // solo mira ese lado (puede tomar una entrada más tardía que la primera del mercado).
  const cur = { kind: 'livegate', e: 0.08, lo: 0.59, hi: 0.79, tMax: 240, tMin: 10 };
  const base240 = { ...baseline, tMax: 240 };
  report.bySide = {};
  for (const side of ['UP', 'DOWN'])
    report.bySide[side] = { base: evaluate(markets, { ...base240, side }), live: evaluate(liveMk, { ...cur, side }) };
  // Anticipación: ¿la señal llega tarde? (1) primera señal del bot en la ventana 240-10 s: cuánto
  // se había movido ya el ask de ese lado en los 10 s previos; (2) cota superior (sabiendo que la
  // señal va a venir) de entrar k s antes al ask de ese momento; (3) señal aproximada con umbrales
  // más bajos de z y movimiento, con el mismo filtro FAIR y la misma ventana.
  const askOf = (r, side) => r ? (side === 'UP' ? r.ya : r.na) : null;
  const first = { n: 0, ask: 0, ask10: 0, n10: 0, cara: 0, caraAntes: 0 };
  for (const mk of liveMk) {
    const R = mk.rows;
    const i = R.findIndex(r => r && r.bsig && r.sl <= 240 && r.sl >= 10);
    if (i < 0) continue;
    const side = R[i].bsig > 0 ? 'UP' : 'DOWN', a = askOf(R[i], side);
    if (a == null) continue;
    first.n++; first.ask += a;
    const a10 = askOf(R[i - 10], side);
    if (a10 != null) { first.n10++; first.ask10 += a10; }
    if (a > 0.79) { first.cara++; if (a10 != null && a10 >= 0.59 && a10 <= 0.79) first.caraAntes++; }
  }
  const early = {};
  for (const k of [0, 3, 5, 10]) {
    let n = 0, w = 0, ps = 0;
    for (const mk of liveMk) {
      const e = entry(mk, cur);
      if (!e) continue;
      const j = e.i - k;
      const a = j >= 0 ? askOf(mk.rows[j], e.side) : null;
      const price = k === 0 ? e.price : a;
      if (price == null || price >= 0.99) continue;
      const win = e.side === mk.winner;
      n++; if (win) w++; ps += (win ? 1 - price : -price) - fee(price);
    }
    early[k] = { n, wr: n ? +(w / n).toFixed(3) : null, evPerShare: n ? +(ps / n).toFixed(4) : null };
  }
  const zgrid = [];
  for (const zt of [0.8, 1.0, 1.2, 1.5])
    for (const mt of [0.01, 0.02, 0.04])
      zgrid.push({ zt, mt, ...evaluate(liveMk, { kind: 'zgate', zt, mt, e: 0.08, lo: 0.59, hi: 0.79, tMax: 240, tMin: 10 }) });
  // Prueba fuera de muestra de la candidata elegida el 06/10 19:26 con 344 mercados (z ≥ 1.5,
  // movimiento ≥ 0.02 %): solo mercados posteriores al corte, contra la regla actual en esos mismos.
  const cutoff = Date.parse(process.env.ANTICIPO_DESDE || '2026-10-06T19:15:00Z');
  const holdMk = liveMk.filter(m => m.start >= cutoff);
  const holdout = { from: new Date(cutoff).toISOString(), markets: holdMk.length,
    candidate: evaluate(holdMk, { kind: 'zgate', zt: 1.5, mt: 0.02, e: 0.08, lo: 0.59, hi: 0.79, tMax: 240, tMin: 10 }),
    current: evaluate(holdMk, cur) };
  report.anticipation = { firstSignal: first, earlyOracle: early, zgrid, holdout };
  report.sinChainlink = sinChainlink(markets, liveMk, cur);
  fs.writeFileSync(OUT, JSON.stringify(report));
  const b = report.baseline.all, best = top[0];
  const fam = (f) => { const t = f.top[0]; return t ? `mejor train ${JSON.stringify(t.cfg)} n=${t.train.n} EV/acc=${t.train.evPerShare} → test n=${t.test.n} EV/acc=${t.test.evPerShare} z=${t.test.z}` : 'sin reglas con n ≥ 30'; };
  console.log(`[BACKTEST-MOMENTUM] ${fam(report.momentum)}`);
  console.log(`[BACKTEST-ANCLA] ${fam(report.anchored)}`);
  const lv = report.live;
  console.log(`[BACKTEST-VIVO] ${lv.markets} mercados con señal grabada | intentos del bot: n=${lv.attempts.n} WR=${lv.attempts.wr} EV/acc=${lv.attempts.evPerShare} | primera señal 240-10 s a $0.50-0.85: n=${lv.signals_240.n} EV/acc=${lv.signals_240.evPerShare}`);
  for (const hi of [0.74, 0.79, 0.84, 0.89]) {
    const cells = report.liveGrid.filter(g => g.hi === hi).map(g => `e≥${Math.round(g.e * 100)}: n=${g.n} WR=${g.wr} EV/acc=${g.evPerShare} z=${g.z}`);
    console.log(`[BACKTEST-VIVO-GRID] ask ≤ ${hi.toFixed(2)}${hi === 0.79 ? ' (actual)' : ''} | ${cells.join(' | ')}`);
  }
  const sd = (x) => `n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare} z=${x.z}`;
  console.log(`[BACKTEST-LADO] modelo FAIR sin señal (${markets.length} mercados, 240-10 s, $0.59-0.79, e≥8) UP: ${sd(report.bySide.UP.base)} | DOWN: ${sd(report.bySide.DOWN.base)} || regla actual (${liveMk.length} mercados) UP: ${sd(report.bySide.UP.live)} | DOWN: ${sd(report.bySide.DOWN.live)}`);
  { const f = report.anticipation.firstSignal, o = report.anticipation.earlyOracle;
    const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : 'n/a';
    console.log(`[BACKTEST-ANTICIPO] primera señal del bot (240-10 s) en ${f.n} mercados: ask del lado $${f.n ? (f.ask / f.n).toFixed(3) : 'n/a'} (10 s antes $${f.n10 ? (f.ask10 / f.n10).toFixed(3) : 'n/a'}); llega con ask > 0.79 en ${pct(f.cara, f.n)}, y de esas ${pct(f.caraAntes, f.cara)} estaban en $0.59-0.79 10 s antes || entrar antes sabiendo que viene (regla actual): ${[0, 3, 5, 10].map(k => `${k} s: n=${o[k].n} EV/acc=${o[k].evPerShare}`).join(' | ')}`);
    const top = [...report.anticipation.zgrid].sort((a, b) => (b.evPerShare ?? -9) * Math.sqrt(b.n) - (a.evPerShare ?? -9) * Math.sqrt(a.n));
    const h = report.anticipation.holdout, sd2 = (x) => `n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare} P&L=$${x.pnl}`;
    console.log(`[BACKTEST-ANTICIPO] fuera de muestra desde ${h.from} (${h.markets} mercados): candidata z≥1.5 mov≥0.02 ${sd2(h.candidate)} | regla actual ${sd2(h.current)}`);
    console.log(`[BACKTEST-ANTICIPO] señal aproximada z/mov + FAIR e≥8 ($0.59-0.79, 240-10 s): ${top.map(g => `z≥${g.zt} mov≥${g.mt}: n=${g.n} WR=${g.wr} EV/acc=${g.evPerShare} z=${g.z}`).join(' | ')}`);
  }
  { const s = report.sinChainlink, e = (x) => `p50 $${x.p50} p90 $${x.p90} máx $${x.max} (n=${x.n})`;
    console.log(`[BACKTEST-SINCL] sin Chainlink (TWAP 60 s de Binance) en ${s.n} mercados: resultado igual al oficial ${s.agreePct}% | con movimiento oficial < $10 (${s.near}): ${s.nearAgreePct}% | error del movimiento ${e(s.moveErr)} | strike con base calibrada con priceToBeat atrasado: error ${e(s.strikeErr)} | entradas de la regla actual: ${s.entries}, con resultado distinto ${s.entriesDiff}`); }
  console.log(`[BACKTEST] ${markets.length} mercados (${report.from} → ${report.to}) en ${report.secs}s | base: n=${b.n} WR=${b.wr} EV/acc=${b.evPerShare} | mejor train ${JSON.stringify(best?.cfg)} → test n=${best?.test.n} EV/acc=${best?.test.evPerShare} | ${OUT}`);
})().catch(e => { console.error(`[BACKTEST] error: ${e.stack || e.message}`); process.exit(1); });
