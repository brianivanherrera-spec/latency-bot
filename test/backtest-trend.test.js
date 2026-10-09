/**
 * Backtest: tendencia de BTC de 2 h y resultado por día (scripts/backtest.js) con mercados armados a mano.
 * Uso: node test/backtest-trend.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, firstFire, entry, limitExec, fairLimitOf, fairLimitExec, btcSeries, priceAt, trendSplit, anchorSplit, byDay } = require('../scripts/backtest');

const FEE = 0.072, fee = p => FEE * p * (1 - p);
const S0 = Date.UTC(2026, 9, 8, 10, 0, 0);
const MIN = 60000;
const cols = ['t', 'secs_left', 'p_up', 'src', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'sigma_e6', 'btc', 'sig', 'pass', 'z', 'move_pct'];
// Mercado de 300 filas: desde t=100 el modelo da 0.85 con YES a $0.70 y la señal del bot en UP (si signal)
function market(start, btc, winner, signal) {
  const rows = [];
  for (let t = 0; t < 300; t++) {
    const on = signal && t >= 100;
    rows.push([t, 300 - t, on ? 0.85 : 0.5, 1, on ? 0.69 : 0.49, on ? 0.70 : 0.50, on ? 0.30 : 0.50, on ? 0.31 : 0.51, 50, btc, on ? 1 : 0, 0, null, null]);
  }
  return { start_ts: start, winner, strike: 100000, cols, rows };
}
// Mercado para la regla anclada: libro quieto (YES 0.49/0.50) y a 100 s del cierre el modelo sube 15 pts
// (ventaja UP ≈ 12.7 pts); con jump el ask de YES salta a 0.80 un segundo después (el precio se escapa)
function anchoredMarket(start, jump) {
  const rows = [];
  for (let t = 0; t < 300; t++) {
    const up = t >= 200, j = jump && t >= 201;
    rows.push([t, 300 - t, up ? 0.65 : 0.5, 1, j ? 0.79 : 0.49, j ? 0.80 : 0.50, j ? 0.20 : 0.50, j ? 0.21 : 0.51, 50, 100000, 0, 0, null, null]);
  }
  return { start_ts: start, winner: 'UP', strike: 100000, cols, rows };
}
// Ventaja grande con el ask cerca del tope: YES quieto 0.68/0.69 y a 100 s del cierre el modelo sube 27 pts
// (precio justo anclado 0.955); un segundo después el ask de YES salta a 0.76, arriba del tope de $0.72 de B
function highMarket(start) {
  const rows = [];
  for (let t = 0; t < 300; t++) {
    const up = t >= 200, j = t >= 201;
    rows.push([t, 300 - t, up ? 0.77 : 0.5, 1, j ? 0.75 : 0.68, j ? 0.76 : 0.69, j ? 0.24 : 0.31, j ? 0.25 : 0.32, 50, 100000, 0, 0, null, null]);
  }
  return { start_ts: start, winner: 'UP', strike: 100000, cols, rows };
}
// Doble filtro: señal de A en UP y desde t=100 el libro queda en YES 0.69/0.70 (el ancla toma el modelo de ese
// segundo). Sin pLate el modelo ya está en 0.85 al moverse el libro: ventaja anclada −2 pts. Con pLate el modelo
// sube a pLate en t=150 sin que el libro se mueva: ventaja anclada = 0.695 + (pLate − 0.70) − 0.70 − comisión.
function gateMarket(start, winner, { pLate = null, noBid = false } = {}) {
  const rows = [];
  for (let t = 0; t < 300; t++) {
    const on = t >= 100, p = !on ? 0.5 : pLate != null ? (t >= 150 ? pLate : 0.70) : 0.85;
    rows.push([t, 300 - t, p, 1, on ? (noBid ? null : 0.69) : 0.49, on ? 0.70 : 0.50, on ? 0.30 : 0.50, on ? 0.31 : 0.51, 50, 100000, on ? 1 : 0, 0, null, null]);
  }
  return { start_ts: start, winner, strike: 100000, cols, rows };
}
const mks = [
  anchoredMarket(S0 + 400 * MIN, true), anchoredMarket(S0 + 405 * MIN, false), highMarket(S0 + 410 * MIN),
  // referencias 2 h antes (sin señal), BTC 100.000
  ...[0, 1, 2, 3].map(k => market(S0 + k * 5 * MIN, 100000, 'UP', false)),
  // a favor: BTC +0.3 % en 2 h y el bot compra UP → gana
  market(S0 + 120 * MIN, 100300, 'UP', true), market(S0 + 125 * MIN, 100300, 'UP', true),
  // en contra: BTC −0.3 % en 2 h y el bot compra UP → pierde
  market(S0 + 130 * MIN, 99700, 'DOWN', true), market(S0 + 135 * MIN, 99700, 'DOWN', true),
  // sin referencia 2 h antes (hueco > 10 min)
  market(S0 + 300 * MIN, 100000, 'UP', true),
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
const file = path.join(dir, 'shadow-ticks.jsonl');
fs.writeFileSync(file, mks.map(m => JSON.stringify(m)).join('\n') + '\n');

(async () => {
  const markets = await load(file);
  assert.strictEqual(markets.length, 12);
  // Regla anclada (cuenta B): el primer disparo se escapa en 1 s → sin entrada; sin salto, entra a $0.50
  const bCfg = { kind: 'anchored', e: 0.08, lo: 0.30, hi: 0.70, tMax: 120, tMin: 30 };
  const [mEsc, mOk, mHi] = markets.slice(-3);
  const f = firstFire(mEsc, bCfg);
  assert.deepStrictEqual([f.side, f.ask, f.ask2, f.price, f.escaped, mEsc.rows[f.i].sl], ['UP', 0.50, 0.80, 0.80, true, 100]);
  assert.strictEqual(entry(mEsc, bCfg), null, 'precio escapado: sin entrada');
  assert.strictEqual(firstFire(mOk, bCfg).escaped, false);
  assert.strictEqual(entry(mOk, bCfg).price, 0.50);
  // Con límite ask+2¢ (como B en vivo): el que saltó a 0.80 no llena; el quieto llena a 0.50 y gana
  const lim = limitExec([mEsc, mOk], bCfg, 0.02);
  assert.deepStrictEqual([lim.fires, lim.moved, lim.n, lim.wr], [2, 1, 1, 1]);
  assert.strictEqual(lim.evPerShare, +((1 - 0.50) - fee(0.50)).toFixed(4));
  // Límite por precio justo: pAdj = 0.495 + 0.15 = 0.645 → margen 2 pts: floor((0.625 − comisión(0.625))·100)/100 = 0.60.
  // El salto a 0.80 tampoco llena; con margen 0: 0.62
  assert.strictEqual(fairLimitOf(f, mEsc, bCfg, 0.02), 0.60);
  assert.strictEqual(fairLimitOf(f, mEsc, bCfg, 0), 0.62);
  const fl = fairLimitExec([mEsc, mOk], bCfg, 0.02);
  assert.deepStrictEqual([fl.fires, fl.n, fl.wr], [2, 1, 1]);
  assert.strictEqual(fl.pnl, +(Math.floor(5 / 0.60) * ((1 - 0.50) - fee(0.50))).toFixed(2), 'acciones = floor($5 / límite)');
  // La que no llenó (saltó a 0.80) era ganadora: valuada a $0.80
  assert.deepStrictEqual(fl.miss, { n: 1, wr: 1, evPerShare: +((1 - 0.80) - fee(0.80)).toFixed(4) });
  // Tope: con ventaja grande (justo 0.955 → límite 0.93) el tope de $0.72 corta; con tope $0.80/$0.90 llena a $0.76
  const fh = firstFire(mHi, bCfg);
  assert.deepStrictEqual([fh.side, fh.ask, fh.ask2, fh.escaped], ['UP', 0.69, 0.76, true]);
  assert.strictEqual(fairLimitOf(fh, mHi, bCfg, 0.02), 0.72);
  assert.strictEqual(fairLimitOf(fh, mHi, bCfg, 0.02, 0.80), 0.80);
  assert.strictEqual(fairLimitOf(fh, mHi, bCfg, 0.02, 0.90), 0.90);
  const evHi = +((1 - 0.76) - fee(0.76)).toFixed(4);
  const h72 = fairLimitExec([mHi], bCfg, 0.02);
  assert.deepStrictEqual([h72.n, h72.miss.n, h72.miss.wr, h72.miss.evPerShare], [0, 1, 1, evHi]);
  const h80 = fairLimitExec([mHi], bCfg, 0.02, 0.80);
  assert.deepStrictEqual([h80.n, h80.wr, h80.evPerShare, h80.miss.n], [1, 1, evHi, 0]);
  assert.strictEqual(h80.pnl, +(Math.floor(5 / 0.80) * ((1 - 0.76) - fee(0.76))).toFixed(2), 'acciones = floor($5 / tope)');
  // Llenadas con el ask subiendo ≥ 3¢ en 1 s (el mercado ya se movía al disparar)
  assert.deepStrictEqual(fl.jump, { n: 0, wr: null, evPerShare: null }, 'la llenada de mOk fue sin salto del ask');
  assert.deepStrictEqual(h80.jump, { n: 1, wr: 1, evPerShare: evHi }, 'llenó con el ask 7¢ más arriba 1 s después');
  assert.strictEqual(markets[0].btcOpen, 100000);
  assert.strictEqual(markets[4].btcOpen, 100300);
  const series = btcSeries(markets);
  assert.strictEqual(priceAt(series, S0 + 11 * MIN), 100000, 'último ≤ t dentro de 10 min');
  assert.strictEqual(priceAt(series, S0 + 26 * MIN), null, 'hueco de 11 min: sin dato');
  assert.strictEqual(priceAt(series, S0 - 1), null, 'antes del primero: sin dato');
  const cur = { kind: 'livegate', e: 0.08, lo: 0.59, hi: 0.79, tMax: 240, tMin: 10 };
  const e = entry(markets[4], cur);
  assert.deepStrictEqual([e.side, e.price, markets[4].rows[e.i].sl], ['UP', 0.70, 200]);
  const t = trendSplit(markets, cur, series);
  assert.deepStrictEqual([t.fav.n, t.fav.wr, t.neu.n, t.against.n, t.against.wr, t.noData], [2, 1, 0, 2, 0, 1]);
  assert.strictEqual(t.fav.evPerShare, +((1 - 0.70) - fee(0.70)).toFixed(4));
  assert.strictEqual(t.against.evPerShare, +(-0.70 - fee(0.70)).toFixed(4));
  assert.strictEqual(t.diff, 1, 'a favor − en contra = 1 por acción');
  assert.strictEqual(t.zDiff, null, 'sin varianza no hay z');
  // Umbral: con ±0.5 % las cuatro quedan neutras
  const t5 = trendSplit(markets, cur, series, 0.5);
  assert.deepStrictEqual([t5.fav.n, t5.neu.n, t5.against.n], [0, 4, 0]);
  // Por día: las 5 entradas el mismo día UTC, 2 ganadas
  const d = byDay(markets, cur);
  assert.deepStrictEqual(d.map(x => [x.day, x.n, x.wins]), [['10-08', 5, 3]]);
  // Doble filtro: dos con el anclado en contra (−2 pts: una gana y otra pierde), una con 7 pts, dos con 23 pts
  // (gana y pierde) y una sin bid en el libro (sin ancla). Todas pagan $0.70 con 7 acciones.
  const S1 = Date.UTC(2026, 9, 9, 10, 0, 0);
  const gfile = path.join(dir, 'gate.jsonl');
  fs.writeFileSync(gfile, [gateMarket(S1, 'UP'), gateMarket(S1 + 5 * MIN, 'DOWN'), gateMarket(S1 + 10 * MIN, 'UP', { pLate: 0.79 }),
    gateMarket(S1 + 15 * MIN, 'UP', { pLate: 0.95 }), gateMarket(S1 + 20 * MIN, 'DOWN', { pLate: 0.95 }),
    gateMarket(S1 + 25 * MIN, 'UP', { noBid: true })].map(m => JSON.stringify(m)).join('\n') + '\n');
  const gm = await load(gfile);
  assert.deepStrictEqual(gm.map(m => { const x = entry(m, cur); return x && [x.side, x.price, m.rows[x.i].sl]; }),
    [['UP', 0.70, 200], ['UP', 0.70, 200], ['UP', 0.70, 150], ['UP', 0.70, 150], ['UP', 0.70, 150], ['UP', 0.70, 200]]);
  const ds = anchorSplit(gm, cur);
  assert.deepStrictEqual(ds.cuts, [0.03, 0.08]);
  assert.deepStrictEqual([ds.lo.n, ds.lo.wr, ds.mid.n, ds.mid.wr, ds.hi.n, ds.hi.wr, ds.noData], [2, 0.5, 1, 1, 2, 0.5, 1]);
  const win = (1 - 0.70) - fee(0.70), loss = -0.70 - fee(0.70);
  assert.deepStrictEqual([ds.agree.n, ds.agree.wr, ds.disagree.n], [3, 0.667, 2]);
  assert.strictEqual(ds.agree.evPerShare, +((2 * win + loss) / 3).toFixed(4));
  assert.strictEqual(ds.agree.pnl, +(7 * (2 * win + loss)).toFixed(2));
  assert.strictEqual(ds.disagree.pnl, +(7 * (win + loss)).toFixed(2));
  assert.strictEqual(ds.diff, +((2 * win + loss) / 3 - (win + loss) / 2).toFixed(4), 'con doble filtro − las que saca');
  assert.ok(ds.zDiff > 0);
  // Cortes 8/20 pts: la de 7 pts pasa a "en contra"
  const d20 = anchorSplit(gm, cur, [0.08, 0.20]);
  assert.deepStrictEqual([d20.lo.n, d20.mid.n, d20.hi.n, d20.agree.n], [3, 0, 2, 2]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('backtest-trend: 46 ok');
})().catch(err => { console.error(err); process.exit(1); });
