/**
 * Shadow: columnas nuevas (z, move_pct, sig, pass) y filtro anclado al mercado en sombra.
 * Uso: node test/shadow-anchor.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'shadow-'));
const assert = require('assert');
const { Shadow, COLS } = require('../src/shadow');

const now0 = Date.now();
const book = new Map();
const setMid = (bid, ask, nb, na) => {
  book.set('Y', { bestBid: bid, bestAsk: ask, updatedAt: Date.now() });
  book.set('N', { bestBid: nb, bestAsk: na, updatedAt: Date.now() });
};
const poly = { _connected: true, _yesTokenId: 'Y', _topOfBook: book, getDepthImbalance: () => null };
const fv = { lastPrice: 60000, lastTs: Date.now(), priceAt: () => null, sigma: () => 3e-5 };
let pModel = 0.60;
const sh = new Shadow({ fairValue: fv, polyWs: poly });
sh.setFairFn(() => ({ p: pModel, strike: 60000, src: 'chainlink_twap', sigma: 3e-5 }));
sh.setSignalFn(() => ({ z: 1.8, movePct: 0.045 }));
sh.startMarket({ marketId: 'm', gammaId: 'g', question: 'q', endTs: now0 + 200000, yesTokenId: 'Y', noTokenId: 'N' });

// Segundo 1: mid 0.60 → ancla (mid 0.60, p 0.60)
setMid(0.59, 0.61, 0.39, 0.41);
sh.recordBotSignal('UP');
sh._sample();
let row = sh.cur.rows.at(-1);
const col = k => row[COLS.indexOf(k)];
assert.strictEqual(col('z'), 1.8);
assert.strictEqual(col('move_pct'), 0.045);
assert.strictEqual(col('sig'), 1, 'señal UP en ese segundo');
assert.strictEqual(col('pass'), 0, 'sin intento de compra');

// Segundo 2: Binance se movió (modelo 0.60 → 0.72) y Polymarket no (mid sigue 0.60)
pModel = 0.72;
sh.recordBotTrade({ direction: 'UP', price: 0.62, zScore: 2, posId: 'p1' });
sh._sample();
row = sh.cur.rows.at(-1);
assert.strictEqual(col('sig'), 0, 'la señal se resetea cada segundo');
assert.strictEqual(col('pass'), 1, 'intento de compra UP registrado');

// P ajustada = 0.60 + (0.72 − 0.60) = 0.72; ventaja = 0.72 − 0.61 − 0.07·0.61·0.39 ≈ 0.093
let g = sh.evaluateEntryAnchored({ gammaId: 'g', direction: 'UP', ask: 0.61, actualOk: false });
assert.ok(g && g.ok && Math.abs(g.pSide - 0.72) < 1e-9, `ancla UP: ${JSON.stringify(g)}`);
assert.ok(Math.abs(g.edge - (0.72 - 0.61 - 0.07 * 0.61 * 0.39)) < 1e-9);
// DOWN con la misma ancla: 0.28 − 0.41 − comisión < 0
g = sh.evaluateEntryAnchored({ gammaId: 'g', direction: 'DOWN', ask: 0.41, actualOk: false });
assert.ok(g && !g.ok);

// Polymarket se actualiza (mid 0.71): ancla = ahora, ventaja = mid − ask − comisión < 0.03
setMid(0.70, 0.72, 0.28, 0.30);
g = sh.evaluateEntryAnchored({ gammaId: 'g', direction: 'UP', ask: 0.72, actualOk: true });
assert.ok(g && !g.ok && Math.abs(g.pSide - 0.71) < 1e-9, 'mid actualizado → sin ventaja');

// Comparación con el filtro actual y primera entrada anclada
assert.deepStrictEqual(sh.cur.gateCmp, { both: 0, onlyActual: 1, onlyAnchored: 1, neither: 1 });
assert.strictEqual(sh.cur.firstAnchored.side, 'UP');
assert.strictEqual(sh.cur.firstAnchored.actual_ok, false);

// Otro mercado o modelo sin Chainlink → null (no cuenta)
assert.strictEqual(sh.evaluateEntryAnchored({ gammaId: 'otro', direction: 'UP', ask: 0.6 }), null);
sh.setFairFn(() => ({ p: 0.7, src: 'binance' }));
assert.strictEqual(sh.evaluateEntryAnchored({ gammaId: 'g', direction: 'UP', ask: 0.6 }), null);
console.log('shadow-anchor: 15 ok');
