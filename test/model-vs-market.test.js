/**
 * Backtest: modelo contra mercado ([BACKTEST-CALIBRACION], scripts/backtest.js) sobre mercados armados a mano: un modelo
 * que sabe más que el precio (tiene que salir w = 1 y z > 0) y uno que no sabe nada (w = 0, el precio ya tiene todo).
 * Uso: node test/model-vs-market.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, modelVsMarket } = require('../scripts/backtest');

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
const S0 = Date.UTC(2026, 9, 20, 0, 0, 0);
const cols = ['t', 'secs_left', 'p_up', 'src', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'sigma_e6', 'sigma_short_e6', 'sigma_long_e6', 'btc'];

// Mercado de periodS s con el modelo y el libro de Sí fijos todo el mercado
function market(i, periodS, winner, pUp, yb, ya) {
  const rows = [];
  for (let t = 0; t < periodS; t++) rows.push([t, periodS - t, pUp, 1, yb, ya, +(1 - ya).toFixed(2), +(1 - yb).toFixed(2), 70, 50, 50, 100000]);
  return { start_ts: S0 + i * periodS * 1000, end_ts: S0 + (i + 1) * periodS * 1000, winner, strike: 100000, cols, rows };
}
async function loadMarkets(list) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mvm-')), 'ticks.jsonl');
  fs.writeFileSync(file, list.map(m => JSON.stringify(m)).join('\n') + '\n');
  return load(file);
}

(async () => {
  // A) El precio no sabe nada (49/51) y el modelo dice 80 % del lado correcto, salvo 1 de cada 5 (calibrado)
  const A = await loadMarkets(Array.from({ length: 100 }, (_, i) => {
    const winner = i % 2 ? 'DOWN' : 'UP', right = i % 5 !== 4;
    const pUp = (winner === 'UP') === right ? 0.8 : 0.2;
    return market(i, 300, winner, pUp, 0.49, 0.51);
  }));
  assert.strictEqual(A[0].period, 300000);
  const a = modelVsMarket(A);
  assert.deepStrictEqual(a.points.map(p => p.c), [300, 180, 120, 90, 60, 30, 10]);
  for (const p of a.points) {
    assert.strictEqual(p.n, 100);
    near(p.model, 0.16, 1e-9);   // 0.8·0.04 + 0.2·0.64
    near(p.market, 0.25, 1e-9);
    assert.ok(p.z > 3, `z ${p.z}`);
  }
  // Desacuerdos: una muestra por mercado y tramo; el lado del modelo gana 80 %, el mercado daba 50 %
  for (const g of ['early', 'final']) {
    const d = a.dis[g];
    assert.strictEqual(d.n, 100);
    near(d.market, 0.5); near(d.model, 0.8); near(d.hit, 0.8);
    assert.ok(d.z > 5, `z ${d.z}`);
    // Comprar ese lado a $0.51 con comisión: 0.8 − 0.51 − 0.072·0.51·0.49
    near(d.buy.evPerShare, 0.8 - 0.51 - 0.072 * 0.51 * 0.49, 1e-4);
    assert.strictEqual(d.buy.n, 100);
  }
  // Mezcla: w = 1 (el modelo calibrado le gana al precio) y en el 40 % nuevo el log-loss baja ~28 %
  for (const g of ['early', 'final']) {
    const m = a.mix[g];
    assert.strictEqual(m.w, 1);
    assert.strictEqual(m.testMarkets, 40);
    near(m.gainPct, (Math.log(2) - (0.8 * -Math.log(0.8) + 0.2 * -Math.log(0.2))) / Math.log(2) * 100, 0.05);
    assert.ok(m.z > 2, `z ${m.z}`);
  }

  // B) El precio sabe (65 % del lado ganador) y el modelo no (80/20 sin relación con el resultado)
  const B = await loadMarkets(Array.from({ length: 100 }, (_, i) => {
    const winner = i % 2 ? 'DOWN' : 'UP', mid = winner === 'UP' ? 0.65 : 0.35;
    return market(i, 300, winner, i % 4 < 2 ? 0.8 : 0.2, +(mid - 0.01).toFixed(2), +(mid + 0.01).toFixed(2));
  }));
  const b = modelVsMarket(B);
  for (const p of b.points) assert.ok(p.z < -3 && p.model > p.market, `z ${p.z}`);
  for (const g of ['early', 'final']) {
    assert.strictEqual(b.mix[g].w, 0);
    assert.strictEqual(b.mix[g].gainPct, 0);
    assert.strictEqual(b.mix[g].z, null);
    near(b.dis[g].hit, 0.5);
  }

  // C) Mercados de 1 h: aparecen los momentos de 30 y 15 min; libro con spread > 10¢ no cuenta
  const C = await loadMarkets([
    ...Array.from({ length: 25 }, (_, i) => market(i, 3600, i % 2 ? 'DOWN' : 'UP', i % 2 ? 0.3 : 0.7, 0.49, 0.51)),
    market(30, 3600, 'UP', 0.7, 0.30, 0.70)]);
  assert.strictEqual(C[0].period, 3600000);
  const c = modelVsMarket(C);
  assert.deepStrictEqual(c.points.map(p => p.c), [1800, 900, 600, 300, 180, 120, 90, 60, 30, 10]);
  for (const p of c.points) assert.strictEqual(p.n, 25);

  // Sin mercados: sin puntos ni desacuerdos, sin romper
  const e = modelVsMarket([]);
  assert.deepStrictEqual(e.points, []);
  assert.strictEqual(e.dis.final.n, 0);
  assert.strictEqual(e.mix.final.gainPct, null);
  console.log('model-vs-market: ok');
})().catch(e => { console.error(e); process.exit(1); });
