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
 * Fill conservador: max(ask en t, ask en t+1) — un segundo de latencia en contra. En los mercados donde B15 intentó en
 * vivo (mismo lado, ±3 s), el ask de t+1 se reemplaza por el ask del libro REST a +200 ms que registró el vivo
 * (DATA_DIR/paper-b15-attempts-<id>.jsonl y la semilla scripts/b15-seed/paper-b15-attempts-seed-<id>.jsonl, sacada de los logs).
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
const { normCdf } = require('../src/fair-value');
// Piso de σ del modo blend del modelo FAIR (src/index-final.js), en unidades de las columnas sigma_*_e6
const SIGMA_FLOOR_E6 = parseFloat(process.env.FAIR_SIGMA_FLOOR || '3e-5') * 1e6;
const fee = p => FEE * p * (1 - p);
// Acierto que hace falta para empatar comprando a p como taker: p + comisión. Las z comparan el acierto con
// esto (hasta el 16/10 lo comparaban con p, sin la comisión, y salían ~0,2-0,3 más altas con n = 30-60)
const breakEven = p => p + fee(p);
const STAKE = 5;

// Φ⁻¹(p) — inversa de la normal estándar (Acklam, error relativo < 1.2e-9)
function normInv(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
// P(UP) del modelo como sería con FAIR_SIGMA_MODE=blend: σ = max(√(0.25·σcorta² + 0.75·σlarga²), piso) en vez de la σ
// corta (el modo actual, 'short'). El z del modelo escala con 1/σ (el ×1.4 de FAIR_VOL_MULT se cancela), así que
// p_blend = Φ(Φ⁻¹(p)·σcorta/σblend). Con mercado quieto la σ corta es chica, p se satura en 0.99+ y la ventaja
// anclada de B sale de 30-56 pts (09-11/10): con el piso esas entradas deberían desaparecer. Sin las dos σ: null.
function blendP(p, sS, sL, floorE6 = SIGMA_FLOOR_E6) {
  if (p == null || !(sS > 0) || !(sL > 0)) return null;
  const sB = Math.max(Math.sqrt(0.25 * sS * sS + 0.75 * sL * sL), floorE6);
  return normCdf(normInv(Math.min(0.9999, Math.max(0.0001, p))) * sS / sB);
}

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
        sigS: c.sigma_short_e6 != null ? r[c.sigma_short_e6] : null, sigL: c.sigma_long_e6 != null ? r[c.sigma_long_e6] : null,
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
    // La misma ancla con el modelo como sería con FAIR_SIGMA_MODE=blend (pB, ver blendP)
    let bMid = null, bP = null;
    for (const r of rows) {
      if (r) r.pB = blendP(r.p, r.sigS, r.sigL);
      if (!r || r.ya == null || r.yb == null || r.pB == null) { bMid = null; continue; }
      const mid = (r.ya + r.yb) / 2;
      if (bMid == null || Math.abs(mid - bMid) > 1e-9) { bMid = mid; bP = r.pB; }
      r.pAdjB = Math.min(0.999, Math.max(0.001, mid + (r.pB - bP)));
    }
    // TWAP 60 s de Binance (USDT) en el cierre: promedio de las filas de los últimos 60 s ([BACKTEST-SINCL]);
    // y BTC de Binance en la apertura (primera fila de los primeros 30 s, para [BACKTEST-TEND2H])
    let bs = 0, bn = 0, btcOpen = null;
    for (const r of m.rows || []) {
      const t = r[c.t], b = r[c.btc];
      if (t != null && t >= 240 && t <= 300 && b != null) { bs += b; bn++; }
      if (btcOpen == null && t != null && t <= 30 && b != null) btcOpen = b;
    }
    markets.push({ start: m.start_ts, winner: m.winner, rows, live: c.pass != null,
      period: Number.isFinite(m.end_ts) && Number.isFinite(m.start_ts) ? m.end_ts - m.start_ts : null,
      strike: Number.isFinite(m.strike) ? m.strike : null, bnClose60: bn >= 45 ? bs / bn : null, btcOpen });
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
    const pj = cfg.blend ? r.pAdjB : r.pAdj;
    if (pj == null) return false;
    // minTrend: el ask del lado comprado tiene que haber subido al menos eso en los 3 s previos (el mercado ya se
    // mueve a favor; hipótesis del 12/10, ver [BACKTEST-B-HIPOTESIS])
    if (cfg.minTrend != null) {
      const prev = R[i - 3], a3 = prev ? (side === 'UP' ? prev.ya : prev.na) : null;
      if (a3 == null || ask - a3 < cfg.minTrend - 1e-9) return false;
    }
    const pa = side === 'UP' ? pj : 1 - pj;
    return pa - ask - fee(ask) >= cfg.e;
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

// Intentos de B15 en vivo por inicio de mercado: { side, sl, ask200 } (el primero que aparece en los archivos)
function loadLiveAttempts(files) {
  const byStart = new Map();
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      let a; try { a = JSON.parse(line); } catch { continue; }
      if (!a || !Number.isFinite(a.start) || !Number.isFinite(a.ask200) || !Number.isFinite(a.sl) || !a.side) continue;
      if (!byStart.has(a.start)) byStart.set(a.start, { side: a.side, sl: a.sl, ask200: a.ask200 });
    }
  }
  return byStart;
}
function attachLive(markets, byStart) {
  let n = 0;
  for (const mk of markets) { const a = byStart.get(mk.start); if (a) { mk.liveAtt = a; n++; } }
  return n;
}
// Archivos de intentos de la serie de IN (shadow-ticks-<id>.jsonl); el de 5 min (shadow-ticks.jsonl) no tiene B15
function liveAttemptFiles(inFile) {
  const m = /^shadow-ticks-(.+)\.jsonl$/.exec(path.basename(inFile));
  if (!m) return [];
  return [path.join(path.dirname(inFile), `paper-b15-attempts-${m[1]}.jsonl`),
    path.join(__dirname, 'b15-seed', `paper-b15-attempts-seed-${m[1]}.jsonl`)];
}
const LIVE_SL_TOL = 3;

// Primer disparo de una regla en un mercado → { side, i, ask, ask2 (1 s después), price, escaped, live } o null.
// escaped: el precio se escapó en ese segundo (fill conservador por encima del tope): no hay entrada.
// live: B15 intentó en vivo en ese mercado, mismo lado y ±LIVE_SL_TOL s: ask2 es el ask del REST a +200 ms del vivo.
function firstFire(mk, cfg) {
  const R = mk.rows;
  for (let i = 0; i < R.length - 1; i++) {
    const r = R[i];
    if (!r || r.sl > cfg.tMax || r.sl < cfg.tMin) continue;
    for (const side of cfg.side ? [cfg.side] : ['UP', 'DOWN']) {
      const ask = side === 'UP' ? r.ya : r.na, bid = side === 'UP' ? r.yb : r.nb;
      if (ask == null || ask < cfg.lo || ask > cfg.hi) continue;
      if (!fires(R, i, side, cfg, ask, bid)) continue;
      const nx = R[i + 1], la = mk.liveAtt;
      const live = !!la && la.side === side && Math.abs(la.sl - r.sl) <= LIVE_SL_TOL;
      const ask2 = live ? la.ask200 : nx ? (side === 'UP' ? nx.ya : nx.na) : null;
      const price = Math.max(ask, ask2 ?? ask);
      return { side, i, ask, ask2, price, escaped: price > cfg.hi + 0.02 || price >= 0.99, live };
    }
  }
  return null;
}

// Primera entrada de una regla en un mercado → { side, price, i } o null (sin entrada si el precio se escapó)
function entry(mk, cfg) {
  const f = firstFire(mk, cfg);
  return f && !f.escaped ? { side: f.side, price: f.price, i: f.i } : null;
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
    const q = breakEven(e.price);
    exp += q; varr += q * (1 - q);
  }
  return { n, wr: n ? +(w / n).toFixed(3) : null, avgPrice: n ? +(exp / n).toFixed(3) : null,
    evPerShare: n ? +(perShare / n).toFixed(4) : null, pnl: +pnl.toFixed(2),
    z: varr ? +((w - exp) / Math.sqrt(varr)).toFixed(2) : null };
}

// Tendencia de BTC de las 2 h previas, orientada al lado comprado (+ = a favor). Hipótesis del
// análisis de pérdidas del 08/10 (128 operaciones de la cuenta A): contra la tendencia (< −0.1 %)
// 24-11 −5.4¢/acc, a favor (> +0.1 %) 27-7 +7.0¢/acc, z ≈ 1.2. Se mide con el BTC de Binance en la
// apertura de cada mercado: cambio % entre la apertura del mercado y la de 2 h antes (hueco ≤ 10 min).
function btcSeries(markets) {
  return markets.filter(m => m.btcOpen != null).map(m => [m.start, m.btcOpen]);
}
function priceAt(series, t, maxGapMs = 600000) {
  let lo = 0, hi = series.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  return k >= 0 && t - series[k][0] <= maxGapMs ? series[k][1] : null;
}
function trendSplit(population, cfg, series, thr = 0.1, horizonMs = 7200000) {
  const g = { fav: [], neu: [], against: [] };
  let noData = 0;
  for (const mk of population) {
    const e = entry(mk, cfg);
    if (!e) continue;
    const now = priceAt(series, mk.start), then = priceAt(series, mk.start - horizonMs);
    if (now == null || then == null) { noData++; continue; }
    const tr = (now / then - 1) * 100 * (e.side === 'UP' ? 1 : -1);
    const win = e.side === mk.winner;
    const ps = (win ? 1 - e.price : -e.price) - fee(e.price);
    (tr > thr ? g.fav : tr < -thr ? g.against : g.neu).push({ win, price: e.price, ps });
  }
  return { fav: groupStat(g.fav), neu: groupStat(g.neu), against: groupStat(g.against), noData, ...diffOf(g.fav, g.against) };
}

// Grupo de entradas ({ win, price, ps }): n, acierto, EV por acción y z del acierto contra el de empate (precio + comisión)
function groupStat(a) {
  const n = a.length, w = a.filter(x => x.win).length, exp = a.reduce((s, x) => s + breakEven(x.price), 0);
  const varr = a.reduce((s, x) => { const q = breakEven(x.price); return s + q * (1 - q); }, 0);
  return { n, wr: n ? +(w / n).toFixed(3) : null, evPerShare: n ? +(a.reduce((s, x) => s + x.ps, 0) / n).toFixed(4) : null,
    z: varr ? +((w - exp) / Math.sqrt(varr)).toFixed(2) : null };
}
// Diferencia de EV por acción entre dos grupos y su z (Welch); sin dato con menos de 2 entradas en alguno
function diffOf(a, b) {
  if (a.length < 2 || b.length < 2) return { diff: null, zDiff: null };
  const mv = x => { const n = x.length, m = x.reduce((s, y) => s + y.ps, 0) / n;
    return { n, m, v: x.reduce((s, y) => s + (y.ps - m) ** 2, 0) / (n - 1) }; };
  const f = mv(a), g = mv(b), se = Math.sqrt(f.v / f.n + g.v / g.n);
  return { diff: +(f.m - g.m).toFixed(4), zDiff: se ? +((f.m - g.m) / se).toFixed(2) : null };
}

// Doble filtro: las entradas de una regla (la actual de A) separadas por la ventaja anclada (la de la
// regla de B: precio justo anclado − ask − comisión) en el segundo de la entrada. En vivo [GATE-SOMBRA]
// marca "anclado: no" debajo de FAIR_ANCHOR_EDGE (3 pts) y B entra desde 8 pts. Hipótesis del 09/10: la
// pérdida de A de las 11:57 UTC entró con el anclado en −2.8 pts; si las de A con el anclado en contra
// rinden mucho peor, exigir los dos filtros sacaría perdedoras.
function anchorSplit(population, cfg, cuts = [0.03, 0.08]) {
  const g = { lo: [], mid: [], hi: [] };
  let noData = 0;
  for (const mk of population) {
    const e = entry(mk, cfg);
    if (!e) continue;
    const r = mk.rows[e.i], ask = e.side === 'UP' ? r.ya : r.na;
    if (r.pAdj == null || ask == null) { noData++; continue; }
    const edge = (e.side === 'UP' ? r.pAdj : 1 - r.pAdj) - ask - fee(ask);
    const win = e.side === mk.winner, ps = (win ? 1 - e.price : -e.price) - fee(e.price);
    (edge >= cuts[1] - 1e-9 ? g.hi : edge >= cuts[0] - 1e-9 ? g.mid : g.lo).push({ win, price: e.price, ps, pnl: Math.floor(STAKE / e.price) * ps });
  }
  const agree = [...g.mid, ...g.hi], pnl = a => +a.reduce((s, x) => s + x.pnl, 0).toFixed(2);
  return { cuts, lo: groupStat(g.lo), mid: groupStat(g.mid), hi: groupStat(g.hi), noData,
    agree: { ...groupStat(agree), pnl: pnl(agree) }, disagree: { ...groupStat(g.lo), pnl: pnl(g.lo) }, ...diffOf(agree, g.lo) };
}

// Regla con límite de precio (como B en vivo: límite = ask al decidir + buffer): llena solo si el ask
// 1 s después sigue ≤ límite (cota pesimista: en vivo se mira el libro a +400 ms) y paga max(ask, ask 1 s después).
// El backtest normal en cambio paga el ask de 1 s después hasta el tope del rango + 2¢.
function limitExec(markets, cfg, buffer) {
  let fires = 0, moved = 0, n = 0, w = 0, ps = 0, pnl = 0, exp = 0, varr = 0;
  for (const mk of markets) {
    const f = firstFire(mk, cfg);
    if (!f) continue;
    fires++;
    const a2 = f.ask2 ?? f.ask;
    if (a2 > f.ask + buffer + 1e-9) { moved++; continue; }
    const price = Math.max(f.ask, a2), win = f.side === mk.winner;
    const x = (win ? 1 - price : -price) - fee(price);
    const q = breakEven(price);
    n++; if (win) w++; ps += x; pnl += Math.floor(STAKE / price) * x; exp += q; varr += q * (1 - q);
  }
  return { fires, moved, n, wr: n ? +(w / n).toFixed(3) : null, evPerShare: n ? +(ps / n).toFixed(4) : null,
    pnl: +pnl.toFixed(2), z: varr ? +((w - exp) / Math.sqrt(varr)).toFixed(2) : null };
}

// Límite por precio justo (B con PAPER_B_LIMIT=fair): el precio más alto con el que todavía quedan `margin`
// pts de ventaja contra el precio justo anclado del disparo, neto de comisión (al centavo, hacia abajo),
// entre ask + 1¢ y el tope (por defecto, máximo del rango + 2¢, como en vivo). Llena si el ask 1 s después
// sigue ≤ límite y paga max(ask, ask 1 s después); acciones = floor($5 / límite), como en vivo.
function fairLimitOf(f, mk, cfg, margin, cap = cfg.hi + 0.02) {
  const r = mk.rows[f.i], pj = cfg.blend ? r.pAdjB : r.pAdj;
  const pa = f.side === 'UP' ? pj : 1 - pj, l0 = pa - margin;
  const L = Math.floor((l0 - fee(Math.min(0.99, Math.max(0.01, l0)))) * 100 + 1e-9) / 100;
  return Math.max(+(f.ask + 0.01).toFixed(2), Math.min(+cap.toFixed(2), L));
}
// miss: los disparos que el límite no llena, valuados al precio de 1 s después (si < $0.99): si salen
// mucho mejor que los llenados, el límite deja pasar sobre todo ganadoras (selección adversa).
// jump: las llenadas con el ask 3¢ o más arriba 1 s después (el mercado ya se movía al disparar; en vivo,
// con el WS atrasado, son los disparos con precio viejo que el límite justo deja llenar al precio nuevo)
function fairLimitExec(markets, cfg, margin, cap) {
  let fires = 0, n = 0, w = 0, ps = 0, pnl = 0, exp = 0, varr = 0, mn = 0, mw = 0, mps = 0, jn = 0, jw = 0, jps = 0;
  for (const mk of markets) {
    const f = firstFire(mk, cfg);
    if (!f) continue;
    fires++;
    const L = fairLimitOf(f, mk, cfg, margin, cap), a2 = f.ask2 ?? f.ask;
    const price = Math.max(f.ask, a2), win = f.side === mk.winner;
    const x = (win ? 1 - price : -price) - fee(price);
    if (a2 > L + 1e-9) {
      if (price < 0.99) { mn++; if (win) mw++; mps += x; }
      continue;
    }
    const q = breakEven(price);
    n++; if (win) w++; ps += x; pnl += Math.floor(STAKE / L) * x; exp += q; varr += q * (1 - q);
    if (a2 - f.ask >= 0.03 - 1e-9) { jn++; if (win) jw++; jps += x; }
  }
  return { fires, n, wr: n ? +(w / n).toFixed(3) : null, evPerShare: n ? +(ps / n).toFixed(4) : null,
    pnl: +pnl.toFixed(2), z: varr ? +((w - exp) / Math.sqrt(varr)).toFixed(2) : null,
    miss: { n: mn, wr: mn ? +(mw / mn).toFixed(3) : null, evPerShare: mn ? +(mps / mn).toFixed(4) : null },
    jump: { n: jn, wr: jn ? +(jw / jn).toFixed(3) : null, evPerShare: jn ? +(jps / jn).toFixed(4) : null } };
}

// Disparos de una regla anclada con el fill del límite justo (como B en vivo) y sus rasgos al disparar: ventaja
// anclada neta de comisión, σ corta del modelo (sin el ×1.4), P del modelo del lado comprado y cuánto se movió el
// ask de ese lado en los 3 s previos. Sirve para ver de qué disparos sale la ganancia (o la pérdida) de la regla.
// También (variables del 21/10): segundos restantes, ask, lado, hora UTC de inicio del mercado, spread del lado
// comprado y si el mercado anterior de la serie (5 o 15 min antes) terminó para el mismo lado.
function fireRecords(markets, cfg, margin, cap) {
  const out = [], winnerAt = new Map(markets.map(m => [m.start, m.winner]));
  for (const mk of markets) {
    const f = firstFire(mk, cfg);
    if (!f) continue;
    const R = mk.rows, r = R[f.i], pj = cfg.blend ? r.pAdjB : r.pAdj;
    const prev = R[f.i - 3], a3 = prev ? (f.side === 'UP' ? prev.ya : prev.na) : null;
    const L = fairLimitOf(f, mk, cfg, margin, cap), a2 = f.ask2 ?? f.ask;
    const price = Math.max(f.ask, a2), win = f.side === mk.winner, ps = (win ? 1 - price : -price) - fee(price);
    const bid = f.side === 'UP' ? r.yb : r.nb;
    const prevWinner = mk.period ? winnerAt.get(mk.start - mk.period) : winnerAt.get(mk.start - 300000) ?? winnerAt.get(mk.start - 900000);
    out.push({ filled: a2 <= L + 1e-9, win, price, ps, pnl: Math.floor(STAKE / L) * ps,
      edge: (f.side === 'UP' ? pj : 1 - pj) - f.ask - fee(f.ask), sigS: r.sigS ?? null,
      pModel: f.side === 'UP' ? r.p : 1 - r.p, trend: a3 != null ? +(f.ask - a3).toFixed(4) : null,
      sl: r.sl, ask: f.ask, side: f.side, hour: new Date(mk.start).getUTCHours(),
      spread: bid != null ? +(f.ask - bid).toFixed(4) : null, prevSame: prevWinner ? prevWinner === f.side : null });
  }
  return out;
}
// Las llenadas de fireRecords separadas por ventaja (8-15, 15-25, ≥ 25 pts), σ corta contra el piso del modo blend,
// modelo saturado (P del lado comprado ≥ 99 %) y movimiento del ask en los 3 s previos (bajó / estable / subió 2¢)
function cutStats(recs, floorE6 = SIGMA_FLOOR_E6) {
  const f = recs.filter(x => x.filled);
  const g = pred => { const a = f.filter(pred); return { ...groupStat(a), pnl: +a.reduce((s, x) => s + x.pnl, 0).toFixed(2) }; };
  return { fires: recs.length, n: f.length,
    edge: [g(x => x.edge < 0.15), g(x => x.edge >= 0.15 && x.edge < 0.25), g(x => x.edge >= 0.25)],
    sigma: [g(x => x.sigS != null && x.sigS < floorE6), g(x => x.sigS != null && x.sigS >= floorE6), g(x => x.sigS == null)],
    sat: [g(x => x.pModel >= 0.99), g(x => x.pModel < 0.99)],
    trend: [g(x => x.trend != null && x.trend <= -0.02 + 1e-9), g(x => x.trend != null && Math.abs(x.trend) < 0.02 - 1e-9),
      g(x => x.trend != null && x.trend >= 0.02 - 1e-9), g(x => x.trend == null)] };
}
// Las mismas llenadas por las variables del 21/10: segundos restantes (30-60, 60-90, 90-120), ask (< $0.45,
// $0.45-0.55, > $0.55), lado, franja UTC del inicio (00-08 Asia, 08-13 Europa, 13-21 EE.UU., 21-24), spread del lado
// comprado (1¢ o ≥ 2¢) y mercado anterior a favor / en contra / sin dato
function cutStats2(recs) {
  const f = recs.filter(x => x.filled);
  const g = pred => { const a = f.filter(pred); return { ...groupStat(a), pnl: +a.reduce((s, x) => s + x.pnl, 0).toFixed(2) }; };
  return { fires: recs.length, n: f.length,
    secs: [g(x => x.sl < 60), g(x => x.sl >= 60 && x.sl < 90), g(x => x.sl >= 90)],
    ask: [g(x => x.ask < 0.45 - 1e-9), g(x => x.ask >= 0.45 - 1e-9 && x.ask <= 0.55 + 1e-9), g(x => x.ask > 0.55 + 1e-9)],
    side: [g(x => x.side === 'UP'), g(x => x.side === 'DOWN')],
    hour: [g(x => x.hour < 8), g(x => x.hour >= 8 && x.hour < 13), g(x => x.hour >= 13 && x.hour < 21), g(x => x.hour >= 21)],
    spread: [g(x => x.spread != null && x.spread <= 0.01 + 1e-9), g(x => x.spread != null && x.spread > 0.01 + 1e-9)],
    prev: [g(x => x.prevSame === true), g(x => x.prevSame === false), g(x => x.prevSame == null)] };
}
// Variante maker de una regla anclada: en vez de pagar el ask deja una compra límite y espera. Precio: 'near' = 1¢
// debajo del ask y como poco el bid (con 1¢ de spread se suma al bid); 'deep' = 3¢ debajo del ask. Llena si en un
// segundo posterior el ask del lado comprado baja hasta ese precio (si la orden se sumó al bid, tiene que bajar más:
// la fila de adelante se llena primero) antes de los últimos endSl s, y se cancela si el precio justo anclado cae
// por debajo del precio de la orden. Sin comisión: los makers no pagan (el rebate de Polymarket no se cuenta).
// Lo que mide: si las que llenan son las que el mercado tenía en contra (los bots rápidos venden ahí).
function makerExec(markets, cfg, mode = 'near', endSl = 10) {
  let fires = 0, n = 0, w = 0, ps = 0, pnl = 0, exp = 0, varr = 0, canc = 0;
  for (const mk of markets) {
    const f = firstFire(mk, cfg);
    if (!f) continue;
    const R = mk.rows, r0 = R[f.i], bid = f.side === 'UP' ? r0.yb : r0.nb;
    const X = +(mode === 'deep' ? f.ask - 0.03 : Math.max(f.ask - 0.01, bid ?? 0)).toFixed(2);
    if (!(X > 0)) continue;
    fires++;
    const joined = bid != null && Math.abs(X - bid) < 1e-9;
    let filled = false;
    for (let j = f.i + 1; j < R.length; j++) {
      const r = R[j];
      if (!r) continue;
      if (r.sl < endSl) break;
      const a = f.side === 'UP' ? r.ya : r.na;
      if (a != null && (joined ? a < X - 1e-9 : a <= X + 1e-9)) { filled = true; break; }
      const pj = cfg.blend ? r.pAdjB : r.pAdj;
      if (pj != null && (f.side === 'UP' ? pj : 1 - pj) < X) { canc++; break; }
    }
    if (!filled) continue;
    const win = f.side === mk.winner, x = win ? 1 - X : -X;
    n++; if (win) w++; ps += x; pnl += Math.floor(STAKE / X) * x; exp += X; varr += X * (1 - X);
  }
  return { fires, n, canc, wr: n ? +(w / n).toFixed(3) : null, evPerShare: n ? +(ps / n).toFixed(4) : null,
    pnl: +pnl.toFixed(2), z: varr ? +((w - exp) / Math.sqrt(varr)).toFixed(2) : null };
}

// Resultado de una regla por día (UTC) de entrada: para ver si la ventaja es pareja o sale de pocos días
function byDay(markets, cfg) {
  const d = new Map();
  for (const mk of markets) {
    const e = entry(mk, cfg);
    if (!e) continue;
    const k = new Date(mk.start).toISOString().slice(5, 10);
    const win = e.side === mk.winner, ps = (win ? 1 - e.price : -e.price) - fee(e.price);
    const c = d.get(k) || { n: 0, w: 0, ps: 0, pnl: 0 };
    c.n++; if (win) c.w++; c.ps += ps; c.pnl += Math.floor(STAKE / e.price) * ps;
    d.set(k, c);
  }
  return [...d.entries()].map(([day, c]) => ({ day, n: c.n, wins: c.w, evPerShare: +(c.ps / c.n).toFixed(4), pnl: +c.pnl.toFixed(2) }));
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

// Modelo contra mercado (23/10: sin latencia, ¿dónde sabe el modelo algo que el precio no?). En momentos fijos antes del
// cierre (CAL_POINTS; la fila más cercana a ±2 s, una por mercado y momento): P(UP) del modelo contra el punto medio del
// libro de Sí (spread ≤ maxSpread) y el resultado.
//  - points: error cuadrático (Brier, menos es mejor) de cada uno y la diferencia mercado − modelo, mercado a mercado
//    (z > 0: el modelo acierta mejor que el precio)
//  - dis: cuando difieren en ≥ gap, la primera vez por mercado en cada tramo (antes de 120 s / 120-10 s), del lado que
//    prefiere el modelo: qué daba el mercado, qué el modelo, cuántas pasaron (z contra lo que daba el mercado) y comprar
//    ese lado al ask con comisión (z contra el empate, como evaluate)
//  - mix: peso w del modelo en logit(q) = (1−w)·logit(mid) + w·logit(p), elegido con el 60 % más viejo de los mercados;
//    mejora del log-loss contra el precio solo en el 40 % nuevo (promedio por mercado, z). w = 0: el precio ya tiene todo
// pField 'pAdj': lo mismo con el precio justo anclado de la regla de B (mid + lo que se movió el modelo desde el último
// cambio del mid): mide si el movimiento que el libro todavía no reflejó informa, aunque el nivel del modelo no lo haga
const CAL_POINTS = [1800, 900, 600, 300, 180, 120, 90, 60, 30, 10];
const clampP = x => Math.min(0.999, Math.max(0.001, x));
const logit = x => Math.log(x / (1 - x));
const logLoss = (q, y) => -(y ? Math.log(q) : Math.log(1 - q));
function calSamples(mk, maxSpread, pField = 'p') {
  const best = new Map();
  for (const r of mk.rows) {
    if (!r) continue;
    for (const c of CAL_POINTS) {
      const d = Math.abs(r.sl - c), b = best.get(c);
      if (d <= 2 && (!b || d < Math.abs(b.sl - c))) best.set(c, r);
    }
  }
  const out = [];
  for (const c of CAL_POINTS) {
    const r = best.get(c);
    if (!r || r[pField] == null || r.ya == null || r.yb == null || r.ya < r.yb || r.ya - r.yb > maxSpread + 1e-9) continue;
    out.push({ c, r, p: clampP(r[pField]), mid: clampP((r.ya + r.yb) / 2) });
  }
  return out;
}
function modelVsMarket(markets, { gap = 0.10, maxSpread = 0.10, trainFrac = 0.6, minN = 20, pField = 'p' } = {}) {
  const per = markets.map(mk => ({ mk, y: mk.winner === 'UP' ? 1 : 0, s: calSamples(mk, maxSpread, pField) }));
  const points = [];
  for (const c of CAL_POINTS) {
    let n = 0, bm = 0, bk = 0, sd = 0, sd2 = 0;
    for (const { y, s } of per) {
      const x = s.find(v => v.c === c);
      if (!x) continue;
      const em = (x.p - y) ** 2, ek = (x.mid - y) ** 2, d = ek - em;
      n++; bm += em; bk += ek; sd += d; sd2 += d * d;
    }
    if (n < minN) continue;
    const m = sd / n, v = Math.max(0, sd2 / n - m * m);
    points.push({ c, n, model: +(bm / n).toFixed(4), market: +(bk / n).toFixed(4), z: v > 0 ? +(m / Math.sqrt(v / n)).toFixed(2) : null });
  }
  const groups = { early: c => c > 120, final: c => c <= 120 };
  const dis = {}, mix = {};
  for (const [g, inG] of Object.entries(groups)) {
    let n = 0, sq = 0, sp = 0, w = 0, vq = 0, ne = 0, ev = 0, we = 0, be = 0, vbe = 0;
    for (const { mk, s } of per) {
      const x = s.find(v => inG(v.c) && Math.abs(v.p - v.mid) >= gap - 1e-9);
      if (!x) continue;
      const up = x.p > x.mid, side = up ? 'UP' : 'DOWN', hit = mk.winner === side ? 1 : 0, q = up ? x.mid : 1 - x.mid;
      n++; sq += q; sp += up ? x.p : 1 - x.p; w += hit; vq += q * (1 - q);
      const ask = up ? x.r.ya : x.r.na;
      if (ask != null && ask > 0.01 && ask < 0.99) {
        const b = breakEven(ask);
        ne++; ev += hit - ask - fee(ask); we += hit; be += b; vbe += b * (1 - b);
      }
    }
    dis[g] = { n, market: n ? +(sq / n).toFixed(3) : null, model: n ? +(sp / n).toFixed(3) : null, hit: n ? +(w / n).toFixed(3) : null,
      z: vq ? +((w - sq) / Math.sqrt(vq)).toFixed(2) : null,
      buy: { n: ne, evPerShare: ne ? +(ev / ne).toFixed(4) : null, z: vbe ? +((we - be) / Math.sqrt(vbe)).toFixed(2) : null } };
    // Peso del modelo: elegido en train (todas las muestras del tramo), medido en test por mercado
    const cut = Math.floor(per.length * trainFrac), mixQ = (x, wt) => 1 / (1 + Math.exp(-((1 - wt) * logit(x.mid) + wt * logit(x.p))));
    let bestW = 0, bestL = Infinity, trainN = 0;
    for (let k = 0; k <= 20; k++) {
      const wt = k / 20;
      let L = 0, cnt = 0;
      for (const { y, s } of per.slice(0, cut)) for (const x of s) if (inG(x.c)) { L += logLoss(mixQ(x, wt), y); cnt++; }
      if (cnt && L < bestL - 1e-12) { bestL = L; bestW = wt; trainN = cnt; }
    }
    let tn = 0, sd = 0, sd2 = 0, lk = 0;
    for (const { y, s } of per.slice(cut)) {
      const xs = s.filter(x => inG(x.c));
      if (!xs.length) continue;
      let d = 0, l = 0;
      for (const x of xs) { const a = logLoss(x.mid, y); d += a - logLoss(mixQ(x, bestW), y); l += a; }
      tn++; sd += d / xs.length; sd2 += (d / xs.length) ** 2; lk += l / xs.length;
    }
    const m = tn ? sd / tn : 0, v = tn ? Math.max(0, sd2 / tn - m * m) : 0;
    mix[g] = { w: bestW, trainSamples: trainN, testMarkets: tn, gainPct: tn && lk ? +(m / (lk / tn) * 100).toFixed(2) : null,
      z: v > 0 ? +(m / Math.sqrt(v / tn)).toFixed(2) : null };
  }
  return { markets: markets.length, pField, gap, maxSpread, points, dis, mix };
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

module.exports = { load, loadLiveAttempts, attachLive, liveAttemptFiles, firstFire, entry, evaluate, limitExec, fairLimitOf, fairLimitExec, btcSeries, priceAt, trendSplit, anchorSplit, byDay,
  normInv, blendP, fireRecords, cutStats, cutStats2, makerExec, modelVsMarket };
if (require.main === module) (async () => {
  const t0 = Date.now();
  const markets = await load(IN);
  const liveMatched = attachLive(markets, loadLiveAttempts(liveAttemptFiles(IN)));
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
    modelVsMarket: modelVsMarket(markets),
    modelVsMarketAnchored: modelVsMarket(markets, { pField: 'pAdj', gap: 0.05 }),
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
  // Regla de la cuenta B (src/paper-b.js, mismas variables): por día, y fuera de muestra desde que se
  // fijó (08/10 14:49 UTC). En esos mercados las entradas tienen que coincidir con las [PAPER-B] en vivo.
  const envNum = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
  const bCfg = { kind: 'anchored', e: envNum('PAPER_B_EDGE', 0.08), lo: envNum('PAPER_B_MIN_ASK', 0.30),
    hi: envNum('PAPER_B_MAX_ASK', 0.70), tMax: envNum('PAPER_B_TMAX', 120), tMin: envNum('PAPER_B_TMIN', 30) };
  const bFrom = Date.parse(process.env.PAPER_B_DESDE || '2026-10-08T14:49:00Z');
  const bMk = markets.filter(m => m.start >= bFrom);
  const bBuf = envNum('ORDER_LIMIT_BUFFER', 0.02), bMargin = envNum('PAPER_B_LIMIT_MARGIN', 0.02);
  report.paperB = { cfg: bCfg, byDay: byDay(markets, bCfg), from: new Date(bFrom).toISOString(), markets: bMk.length,
    limit: { buffer: bBuf, all: limitExec(markets, bCfg, bBuf), test: limitExec(test, bCfg, bBuf), stdAll: evaluate(markets, bCfg), stdTest: evaluate(test, bCfg) },
    fair: [0, 0.02, 0.04].map(mg => ({ margin: mg, all: fairLimitExec(markets, bCfg, mg), test: fairLimitExec(test, bCfg, mg) })),
    // Mismo límite justo con topes más altos: ¿conviene dejar pagar más cuando la ventaja es grande?
    fairCap: [0.80, 0.90].map(cap => ({ cap, all: fairLimitExec(markets, bCfg, bMargin, cap), test: fairLimitExec(test, bCfg, bMargin, cap) })),
    holdout: evaluate(bMk, bCfg),
    // Disparos (entradas y los que se escaparon en 1 s): cada intento de B en vivo tiene que estar acá
    entries: bMk.map(mk => ({ mk, f: firstFire(mk, bCfg) })).filter(x => x.f).map(({ mk, f }) => {
      const L = fairLimitOf(f, mk, bCfg, bMargin);
      return { start: new Date(mk.start).toISOString(), side: f.side, ask: f.ask, ask2: f.ask2, price: f.price,
        secsLeft: mk.rows[f.i].sl, escaped: f.escaped, win: f.side === mk.winner, fairLimit: L, fairFill: (f.ask2 ?? f.ask) <= L + 1e-9, live: f.live };
    }), liveMatched };
  // Doble filtro (regla actual de A según el gate anclado al entrar): todos, la parte de test (el 40 % más
  // nuevo de los mercados de la regla actual: todos caen dentro del test general) y fuera de muestra desde
  // que se planteó la hipótesis (DOBLE_DESDE)
  const cuts = [envNum('FAIR_ANCHOR_EDGE', 0.03), bCfg.e], liveTest = liveMk.slice(Math.floor(liveMk.length * 0.6));
  const dFrom = Date.parse(process.env.DOBLE_DESDE || '2026-10-09T12:33:00Z');
  report.doubleGate = { all: anchorSplit(liveMk, cur, cuts), test: anchorSplit(liveTest, cur, cuts), testMarkets: liveTest.length,
    from: new Date(dFrom).toISOString(), holdout: anchorSplit(liveMk.filter(m => m.start >= dFrom), cur, cuts) };
  // Tendencia de BTC de 2 h (hipótesis del análisis de pérdidas): se confirma solo con z ≥ 2
  const series = btcSeries(markets);
  report.trend2h = {
    current: trendSplit(liveMk, cur, series),
    firstSignal: trendSplit(liveMk, { kind: 'live', field: 'sig', lo: 0.5, hi: 0.85, tMax: 240, tMin: 10 }, series),
    anchoredB: trendSplit(markets, bCfg, series),
    fairBase: trendSplit(markets, base240, series),
  };
  // Regla de B por partes (de qué disparos sale el resultado), con el modelo en modo blend (σ con piso) y como
  // maker. Lo de blend se recalcula sobre lo grabado: solo los mercados con las dos σ, comparado con el modelo actual
  // en esos mismos mercados.
  { const blendCfg = { ...bCfg, blend: true };
    const sigSet = new Set(markets.filter(m => m.rows.some(r => r && r.pB != null)));
    const sub = a => a.filter(m => sigSet.has(m));
    const fl = (mks, cfg) => fairLimitExec(mks, cfg, bMargin);
    report.paperBParts = { floorE6: SIGMA_FLOOR_E6,
      cuts: { all: cutStats(fireRecords(markets, bCfg, bMargin)), test: cutStats(fireRecords(test, bCfg, bMargin)) },
      cuts2: { all: cutStats2(fireRecords(markets, bCfg, bMargin)), test: cutStats2(fireRecords(test, bCfg, bMargin)) },
      blend: { markets: sigSet.size,
        blend: { all: fl(sub(markets), blendCfg), test: fl(sub(test), blendCfg), holdout: fl(sub(bMk), blendCfg) },
        short: { all: fl(sub(markets), bCfg), test: fl(sub(test), bCfg), holdout: fl(sub(bMk), bCfg) },
        cutsBlend: cutStats(fireRecords(sub(markets), blendCfg, bMargin)) },
      maker: ['near', 'deep'].map(mode => ({ mode, all: makerExec(markets, bCfg, mode), test: makerExec(test, bCfg, mode), holdout: makerExec(bMk, bCfg, mode) })) };
    // Hipótesis registradas el 12/10 (bitácora) con lo que mostraron los cortes: se juzgan solo con mercados posteriores
    // (HIPOTESIS_DESDE); pasan a una cuenta en paper con z ≥ 2 y ≥ 30 llenadas en esos datos nuevos
    const hFrom = Date.parse(process.env.HIPOTESIS_DESDE || '2026-10-12T12:35:00Z'), hMk = markets.filter(m => m.start >= hFrom);
    const variants = [['B como está', bCfg], ['(i) modelo en modo blend', blendCfg], ['(ii) ask del lado comprado subiendo ≥ 2¢ en los 3 s previos', { ...bCfg, minTrend: 0.02 }],
      ['(iii) las dos juntas', { ...blendCfg, minTrend: 0.02 }]];
    report.paperBHyp = { from: new Date(hFrom).toISOString(), markets: hMk.length,
      variants: variants.map(([label, cfg]) => ({ label, hold: fl(hMk, cfg), all: fl(markets, cfg) })) };
    // Hipótesis (iv), registrada el 16/10 (bitácora ~00:30 ARG) con [BACKTEST-B-CORTES]: en el tramo de prueba las de
    // 8-15 pts dieron n=31 −17¢ z −1,97 y las ≥ 15 pts n=25 ~+4¢. B solo con ventaja ≥ 15 pts al decidir; se juzga
    // solo con mercados desde HIPOTESIS4_DESDE (el arranque en que se registró) y con la misma vara (z ≥ 2, ≥ 30 llenadas)
    const h4From = Date.parse(process.env.HIPOTESIS4_DESDE || '2026-10-16T03:24:00Z'), h4Mk = markets.filter(m => m.start >= h4From);
    const c15 = { ...bCfg, e: 0.15 };
    report.paperBHyp4 = { from: new Date(h4From).toISOString(), markets: h4Mk.length, hold: fl(h4Mk, c15), base: fl(h4Mk, bCfg), all: fl(markets, c15) };
    // Hipótesis (vi), registrada el 21/10 (pedido del usuario: buscar filtros en 5 min): en [BACKTEST-B-CORTES] el único
    // tramo positivo fue ventaja ≥ 25 pts (todos n=41 +17¢ z 2,23; test 6-1). B solo con ventaja ≥ 25 pts; se juzga con
    // mercados desde HIPOTESIS6_DESDE y la misma vara (z ≥ 2, ≥ 30 llenadas)
    const h6From = Date.parse(process.env.HIPOTESIS6_DESDE || '2026-10-21T13:00:00Z'), h6Mk = markets.filter(m => m.start >= h6From);
    const c25 = { ...bCfg, e: 0.25 };
    report.paperBHyp6 = { from: new Date(h6From).toISOString(), markets: h6Mk.length, hold: fl(h6Mk, c25), base: fl(h6Mk, bCfg), all: fl(markets, c25) }; }
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
  { const pb = report.paperB, dd = d => `${d.slice(3, 5)}/${d.slice(0, 2)}`;
    console.log(`[BACKTEST-ANCLA] regla de la cuenta B por día (UTC): ${pb.byDay.map(d => `${dd(d.day)} ${d.wins}-${d.n - d.wins} EV/acc=${d.evPerShare}`).join(' | ') || 'sin entradas'}`);
    const L = pb.limit, lx = x => `disparos ${x.fires}, el ask subió más de ${Math.round(L.buffer * 100)}¢ en 1 s en ${x.moved} (${x.fires ? Math.round(x.moved / x.fires * 100) : 0}%) | llenadas n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare} z=${x.z} P&L=$${x.pnl}`;
    console.log(`[BACKTEST-ANCLA] regla de la cuenta B con límite ask+${Math.round(L.buffer * 100)}¢ como en vivo (llena si el ask 1 s después sigue ≤ límite): todos ${lx(L.all)} || test ${lx(L.test)} || con el fill normal del backtest (paga el ask 1 s después hasta $${(bCfg.hi + 0.02).toFixed(2)}): todos n=${L.stdAll.n} EV/acc=${L.stdAll.evPerShare} z=${L.stdAll.z} | test n=${L.stdTest.n} EV/acc=${L.stdTest.evPerShare} z=${L.stdTest.z}`);
    const fx = x => `n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare} z=${x.z} P&L=$${x.pnl}; no llena ${x.miss.n} (WR=${x.miss.wr} EV/acc a su precio=${x.miss.evPerShare}); llenadas con el ask +3¢ o más en 1 s ${x.jump.n} (WR=${x.jump.wr} EV/acc=${x.jump.evPerShare})`;
    console.log(`[BACKTEST-ANCLA] regla de la cuenta B con límite por precio justo (paga hasta donde quedan M pts de ventaja, tope $${(bCfg.hi + 0.02).toFixed(2)}; llena si el ask 1 s después sigue ≤ límite): ${pb.fair.map(f => `margen ${Math.round(f.margin * 100)}: todos ${fx(f.all)} | test ${fx(f.test)}`).join(' || ')}`);
    console.log(`[BACKTEST-ANCLA] regla de la cuenta B con límite justo (margen ${Math.round(bMargin * 100)}) y tope más alto: ${pb.fairCap.map(f => `tope $${f.cap.toFixed(2)}: todos ${fx(f.all)} | test ${fx(f.test)}`).join(' || ')}`);
    const h = pb.holdout, hm = t => t.slice(11, 16);
    const one = x => `${hm(x.start)} UTC ${x.side} ${Math.round(x.secsLeft)} s ask $${x.ask.toFixed(2)}${x.escaped ? ` → $${x.ask2 == null ? 'n/a' : x.ask2.toFixed(2)} ${x.live ? 'a +200 ms (vivo)' : '1 s después'}: se escapó` : ` → paga $${x.price.toFixed(2)} ${x.win ? 'G' : 'P'}${x.live ? ' V' : ''}`} (límite justo $${x.fairLimit.toFixed(2)}: ${x.fairFill ? 'llena' : 'no llena'})`;
    const esc = pb.entries.filter(x => x.escaped).length, nLive = pb.entries.filter(x => x.live).length;
    const list = `${pb.entries.length > 12 ? `últimos 12 de ${pb.entries.length}: ` : ''}${pb.entries.slice(-12).map(one).join(', ')}`;
    console.log(`[BACKTEST-ANCLA] regla de la cuenta B desde ${pb.from} (fuera de muestra, ${pb.markets} mercados): n=${h.n} WR=${h.wr} EV/acc=${h.evPerShare} P&L=$${h.pnl}${pb.entries.length ? ` | disparos (inicio del mercado; ${esc} con el precio escapado, sin entrada; ${nLive} con el ask a +200 ms de B15 en vivo, marcados V o "(vivo)", el resto con el de 1 s después): ${list}` : ''}`); }
  { const P = report.paperBParts, f6 = Math.round(P.floorE6);
    const sd = x => `n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare} z=${x.z} P&L=$${x.pnl}`;
    const cut = c => `ventaja 8-15 pts ${sd(c.edge[0])} | 15-25 ${sd(c.edge[1])} | ≥ 25 ${sd(c.edge[2])} || σ corta < piso del modo blend (${f6}e-6) ${sd(c.sigma[0])} | ≥ piso ${sd(c.sigma[1])}${c.sigma[2].n ? ` | sin σ ${c.sigma[2].n}` : ''} || P del modelo ≥ 99 % ${sd(c.sat[0])} | < 99 % ${sd(c.sat[1])} || ask del lado comprado en los 3 s previos: bajó ≥ 2¢ ${sd(c.trend[0])} | estable ${sd(c.trend[1])} | subió ≥ 2¢ ${sd(c.trend[2])}`;
    console.log(`[BACKTEST-B-CORTES] regla de la cuenta B con límite justo (margen ${Math.round(bMargin * 100)}, como en vivo), llenadas: todos (${P.cuts.all.n} de ${P.cuts.all.fires} disparos): ${cut(P.cuts.all)}`);
    console.log(`[BACKTEST-B-CORTES] test (${P.cuts.test.n} de ${P.cuts.test.fires} disparos): ${cut(P.cuts.test)}`);
    const cut2 = c => `segundos restantes 30-60 ${sd(c.secs[0])} | 60-90 ${sd(c.secs[1])} | 90-120 ${sd(c.secs[2])} || ask < $0.45 ${sd(c.ask[0])} | $0.45-0.55 ${sd(c.ask[1])} | > $0.55 ${sd(c.ask[2])} || UP ${sd(c.side[0])} | DOWN ${sd(c.side[1])} || hora UTC 00-08 ${sd(c.hour[0])} | 08-13 ${sd(c.hour[1])} | 13-21 ${sd(c.hour[2])} | 21-24 ${sd(c.hour[3])} || spread 1¢ ${sd(c.spread[0])} | ≥ 2¢ ${sd(c.spread[1])} || mercado anterior a favor ${sd(c.prev[0])} | en contra ${sd(c.prev[1])}${c.prev[2].n ? ` | sin dato ${c.prev[2].n}` : ''}`;
    console.log(`[BACKTEST-B-CORTES2] regla de la cuenta B, llenadas por variables nuevas (21/10): todos (${P.cuts2.all.n}): ${cut2(P.cuts2.all)}`);
    console.log(`[BACKTEST-B-CORTES2] test (${P.cuts2.test.n}): ${cut2(P.cuts2.test)}`);
    const B = P.blend, fb = x => `n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare} z=${x.z} P&L=$${x.pnl} (disparos ${x.fires})`;
    console.log(`[BACKTEST-B-BLEND] regla de la cuenta B con FAIR_SIGMA_MODE=blend (σ = √(0.25σc² + 0.75σl²), piso ${f6}e-6; recalculada en ${B.markets} mercados con las dos σ grabadas; límite justo margen ${Math.round(bMargin * 100)}): todos ${fb(B.blend.all)} | test ${fb(B.blend.test)} | fuera de muestra desde ${report.paperB.from.slice(0, 10)} ${fb(B.blend.holdout)} || modelo actual en esos mercados: todos ${fb(B.short.all)} | test ${fb(B.short.test)} | fuera de muestra ${fb(B.short.holdout)} || con blend, por ventaja: 8-15 pts ${sd(B.cutsBlend.edge[0])} | 15-25 ${sd(B.cutsBlend.edge[1])} | ≥ 25 ${sd(B.cutsBlend.edge[2])}`);
    const mx = x => `disparos ${x.fires}, llenadas ${x.n} (${x.fires ? Math.round(x.n / x.fires * 100) : 0} %), canceladas ${x.canc}, WR=${x.wr} EV/acc=${x.evPerShare} z=${x.z} P&L=$${x.pnl}`;
    const H = report.paperBHyp, hx = x => `n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare} z=${x.z} P&L=$${x.pnl} (disparos ${x.fires})`;
    console.log(`[BACKTEST-B-HIPOTESIS] fuera de muestra desde ${H.from.slice(0, 16).replace('T', ' ')} UTC (${H.markets} mercados; límite justo margen ${Math.round(bMargin * 100)}; se adopta en paper con z ≥ 2 y ≥ 30 llenadas acá): ${H.variants.map(v => `${v.label}: ${hx(v.hold)}`).join(' | ')} || todos los datos (con los que se eligió, solo referencia): ${H.variants.map(v => `${v.label.split(' ')[0]} ${hx(v.all)}`).join(' | ')}`);
    const H4 = report.paperBHyp4;
    console.log(`[BACKTEST-B-HIPOTESIS] (iv) ventaja ≥ 15 pts, fuera de muestra desde ${H4.from.slice(0, 16).replace('T', ' ')} UTC (${H4.markets} mercados; se adopta en paper con z ≥ 2 y ≥ 30 llenadas acá): ${hx(H4.hold)} | B como está en esos mercados: ${hx(H4.base)} || todos los datos (con los que se eligió, solo referencia): ${hx(H4.all)}`);
    const H6 = report.paperBHyp6;
    console.log(`[BACKTEST-B-HIPOTESIS] (vi) ventaja ≥ 25 pts, fuera de muestra desde ${H6.from.slice(0, 16).replace('T', ' ')} UTC (${H6.markets} mercados; se adopta en paper con z ≥ 2 y ≥ 30 llenadas acá): ${hx(H6.hold)} | B como está en esos mercados: ${hx(H6.base)} || todos los datos (con los que se eligió, solo referencia): ${hx(H6.all)}`);
    console.log(`[BACKTEST-B-MAKER] regla de la cuenta B como maker (compra límite sin comisión; se cancela si el precio justo anclado baja de la orden; llena si el ask baja hasta la orden antes de los últimos 10 s): ${P.maker.map(m => `${m.mode === 'near' ? '1¢ debajo del ask (o en el bid)' : '3¢ debajo del ask'}: todos ${mx(m.all)} | test ${mx(m.test)} | fuera de muestra ${mx(m.holdout)}`).join(' || ')}`); }
  { const t = report.trend2h, sd3 = x => `n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare}`;
    const ln = (lab, x) => `[BACKTEST-TEND2H] ${lab}: a favor ${sd3(x.fav)} | neutra ${sd3(x.neu)} | en contra ${sd3(x.against)} | a favor − en contra ${x.diff == null ? 'n/a' : `${(x.diff * 100).toFixed(1)}¢/acc z=${x.zDiff}`}${x.noData ? ` | sin dato de 2 h: ${x.noData}` : ''}`;
    console.log(ln(`regla actual (${liveMk.length} mercados; tendencia de BTC de 2 h a favor > +0.1 %, en contra < −0.1 % del lado comprado)`, t.current));
    console.log(ln('primera señal 240-10 s $0.50-0.85', t.firstSignal));
    console.log(ln(`anclada de la cuenta B (${markets.length} mercados)`, t.anchoredB));
    console.log(ln(`modelo FAIR sin señal (${markets.length} mercados, 240-10 s, $0.59-0.79, e≥8)`, t.fairBase)); }
  { const d = report.doubleGate, [c0, c1] = d.all.cuts.map(c => Math.round(c * 100)), sd4 = x => `n=${x.n} WR=${x.wr} EV/acc=${x.evPerShare}`;
    const ln = (lab, x) => `[BACKTEST-DOBLE] ${lab}: anclado ≥ ${c1} pts ${sd4(x.hi)} | ${c0}-${c1} pts ${sd4(x.mid)} | < ${c0} pts (no entraría) ${sd4(x.lo)}${x.noData ? ` | sin dato ${x.noData}` : ''} || con doble filtro (≥ ${c0}) ${sd4(x.agree)} z=${x.agree.z} P&L=$${x.agree.pnl} | las que saca (< ${c0}) P&L=$${x.disagree.pnl} | diferencia ${x.diff == null ? 'n/a' : `${(x.diff * 100).toFixed(1)}¢/acc z=${x.zDiff}`}`;
    console.log(ln(`regla actual de A (${liveMk.length} mercados) según la ventaja anclada de la regla de B al entrar`, d.all));
    console.log(ln(`test (40 % más nuevo: ${d.testMarkets} mercados)`, d.test));
    console.log(ln(`fuera de muestra desde ${d.from.slice(0, 16)}`, d.holdout)); }
  { const V = report.modelVsMarket, pc = v => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
    const verdict = z => (z == null ? '' : z >= 2 ? ' → el modelo suma' : z <= -2 ? ' → el modelo resta' : ' → sin diferencia clara');
    const gain = m => (m.gainPct == null ? 'sin datos' : m.w === 0 ? 'w=0: el precio ya tiene todo'
      : `${m.gainPct >= 0 ? 'mejora' : 'empeora'} ${Math.abs(m.gainPct)}% el log-loss contra el precio solo${m.z != null ? ` z=${m.z}` : ''}${verdict(m.z)}`);
    const dx = (label, d, m) => `${label}: difieren ≥ ${Math.round(V.gap * 100)} pts en ${d.n} mercados (mercado ${pc(d.market)}, modelo ${pc(d.model)}, pasó ${pc(d.hit)}, z contra el mercado ${d.z ?? 'n/a'}); `
      + `comprando ese lado al ask n=${d.buy.n} EV/acc=${d.buy.evPerShare ?? 'n/a'} z=${d.buy.z ?? 'n/a'} | peso del modelo w=${m.w.toFixed(2)} (elegido con el 60 % viejo; en el 40 % nuevo: ${gain(m)})`;
    console.log(`[BACKTEST-CALIBRACION] modelo contra mercado en ${V.markets} mercados, error cuadrático (Brier, menos es mejor; z > 0: el modelo acierta mejor que el precio): `
      + `${V.points.map(p => `${p.c} s n=${p.n} modelo ${p.model.toFixed(3)} mercado ${p.market.toFixed(3)} z=${p.z ?? 'n/a'}`).join(' | ') || 'sin datos'}`);
    console.log(`[BACKTEST-CALIBRACION] ${dx('antes de los 120 s', V.dis.early, V.mix.early)} || ${dx('120-10 s', V.dis.final, V.mix.final)}`);
    const A = report.modelVsMarketAnchored, dxA = (label, d, m) => dx(label, d, m).replace(`≥ ${Math.round(V.gap * 100)} pts`, `≥ ${Math.round(A.gap * 100)} pts`);
    console.log(`[BACKTEST-CALIBRACION] anclado (mid + lo que se movió el modelo desde el último cambio del mid, como la regla de B): Brier z por momento `
      + `${A.points.map(p => `${p.c} s ${p.z ?? 'n/a'}`).join(', ') || 'sin datos'} || ${dxA('antes de los 120 s', A.dis.early, A.mix.early)} || ${dxA('120-10 s', A.dis.final, A.mix.final)}`); }
  console.log(`[BACKTEST] ${markets.length} mercados (${report.from} → ${report.to}) en ${report.secs}s | base: n=${b.n} WR=${b.wr} EV/acc=${b.evPerShare} | mejor train ${JSON.stringify(best?.cfg)} → test n=${best?.test.n} EV/acc=${best?.test.evPerShare} | ${OUT}`);
})().catch(e => { console.error(`[BACKTEST] error: ${e.stack || e.message}`); process.exit(1); });
