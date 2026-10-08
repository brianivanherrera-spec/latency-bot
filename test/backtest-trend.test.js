/**
 * Backtest: tendencia de BTC de 2 h y resultado por día (scripts/backtest.js) con mercados armados a mano.
 * Uso: node test/backtest-trend.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, firstFire, entry, btcSeries, priceAt, trendSplit, byDay } = require('../scripts/backtest');

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
const mks = [
  anchoredMarket(S0 + 400 * MIN, true), anchoredMarket(S0 + 405 * MIN, false),
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
  assert.strictEqual(markets.length, 11);
  // Regla anclada (cuenta B): el primer disparo se escapa en 1 s → sin entrada; sin salto, entra a $0.50
  const bCfg = { kind: 'anchored', e: 0.08, lo: 0.30, hi: 0.70, tMax: 120, tMin: 30 };
  const [mEsc, mOk] = markets.slice(-2);
  const f = firstFire(mEsc, bCfg);
  assert.deepStrictEqual([f.side, f.ask, f.ask2, f.price, f.escaped, mEsc.rows[f.i].sl], ['UP', 0.50, 0.80, 0.80, true, 100]);
  assert.strictEqual(entry(mEsc, bCfg), null, 'precio escapado: sin entrada');
  assert.strictEqual(firstFire(mOk, bCfg).escaped, false);
  assert.strictEqual(entry(mOk, bCfg).price, 0.50);
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
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('backtest-trend: 20 ok');
})().catch(err => { console.error(err); process.exit(1); });
