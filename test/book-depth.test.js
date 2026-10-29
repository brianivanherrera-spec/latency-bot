/**
 * Profundidad hasta el precio límite (polymarket-ws.js getAskSizeUpTo), que usa el
 * simulador de fills de paper. Uso: node test/book-depth.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const { PolymarketWS } = require('../src/polymarket-ws');

const ws = new PolymarketWS();
const T = 'tok';
ws._onBook({ asset_id: T, bids: [{ price: '0.58', size: '100' }], asks: [
  { price: '0.60', size: '5' }, { price: '0.61', size: '4' }, { price: '0.63', size: '50' },
] });
assert.strictEqual(ws.getBestAskSize(T), 5);
assert.strictEqual(ws.getAskSizeUpTo(T, 0.60), 5, 'solo el mejor nivel');
assert.strictEqual(ws.getAskSizeUpTo(T, 0.61), 9, 'mejor nivel + siguiente');
assert.strictEqual(ws.getAskSizeUpTo(T, 0.62), 9, 'no hay nivel en 0.62');
assert.strictEqual(ws.getAskSizeUpTo(T, 0.59), 0, 'límite debajo del mejor ask');

// Precio promedio de una compra con límite (getAskVwapUpTo): cruza los niveles en orden
const near = (a, b) => Math.abs(a - b) < 1e-9;
let v = ws.getAskVwapUpTo(T, 0.62, 8);
assert.ok(v.filled === 8 && near(v.vwap, (5 * 0.60 + 3 * 0.61) / 8), 'vwap 5 a 0.60 + 3 a 0.61');
v = ws.getAskVwapUpTo(T, 0.60, 8);
assert.ok(v.filled === 5 && near(v.vwap, 0.60), 'hasta el límite solo hay 5');
assert.deepStrictEqual(ws.getAskVwapUpTo(T, 0.59, 8), { vwap: null, filled: 0 }, 'límite debajo del mejor ask');

ws._onPriceChange({ price_changes: [{ asset_id: T, price: '0.60', size: '0', side: 'SELL', best_bid: '0.58', best_ask: '0.61' }] });
assert.strictEqual(ws.getAskSizeUpTo(T, 0.61), 4, 'nivel retirado no cuenta');

// Hora del servidor del mensaje que fijó el top (topTs, la usa el chequeo del libro) y retraso
const ts = Date.now() - 300;
ws._handleMessage({ event_type: 'price_change', timestamp: String(ts), price_changes: [{ asset_id: T, price: '0.61', size: '0', side: 'SELL', best_bid: '0.58', best_ask: '0.63' }] });
assert.strictEqual(ws._topOfBook.get(T).topTs, ts, 'topTs = timestamp del mensaje');
assert.strictEqual(ws._topOfBook.get(T).bestAsk, 0.63);
assert.ok(ws._lastLagMs >= 300 && ws._lastLagMs < 2000, 'retraso del último mensaje');

ws._topOfBook.get(T).updatedAt -= 10_000;
assert.strictEqual(ws.getAskSizeUpTo(T, 0.61), null, 'libro viejo = sin dato');
assert.strictEqual(ws.getAskSizeUpTo('otro', 0.61), null, 'token sin libro = sin dato');

// Top del server distinto del libro local (solo registro en [LOOP]): el 0.60 local ya no está en el server
const loopMonitor = require('../src/loop-monitor');
const w2 = new PolymarketWS();
w2._onBook({ asset_id: T, bids: [{ price: '0.58', size: '100' }], asks: [
  { price: '0.60', size: '5' }, { price: '0.61', size: '4' }, { price: '0.63', size: '50' },
] });
w2._onPriceChange({ price_changes: [{ asset_id: T, price: '0.63', size: '40', side: 'SELL', best_bid: '0.58', best_ask: '0.61' }] });
assert.strictEqual(w2._topOfBook.get(T).bestAsk, 0.61, 'manda el top del server');
const lt = loopMonitor.snapshot().text;
assert.ok(/book_override=1\b/.test(lt) && /book_phantom=1\b/.test(lt), lt);
assert.strictEqual(w2.getAskSizeUpTo(T, 0.61), 4, 'la profundidad arranca en el top del server: el nivel fantasma no cuenta');

// Desbalance de profundidad YES contra NO (filtro del book de agosto): todo el libro y niveles a ≤ 5¢ del mejor bid
const { bidDepth, depthImbalance } = require('../src/book-utils');
assert.deepStrictEqual(bidDepth([[0.60, 10], [0.58, 20], [0.40, 70]]), { all: 100, near: 30 }, '0.40 queda fuera de los 5¢');
assert.strictEqual(bidDepth(null), null);
assert.deepStrictEqual(depthImbalance({ all: 300, near: 30 }, { all: 100, near: 90 }), { yes: 300, no: 100, imb: 0.5, imb5: -0.5 });
assert.strictEqual(depthImbalance({ all: 0, near: 0 }, { all: 0, near: 0 }), null, 'libros vacíos');
assert.strictEqual(depthImbalance(null, { all: 5, near: 5 }), null, 'falta un lado');
const w3 = new PolymarketWS();
w3._yesTokenId = 'Y'; w3._noTokenId = 'N';
assert.strictEqual(w3.getDepthImbalance(), null, 'sin libros');
w3._onBook({ asset_id: 'Y', bids: [{ price: '0.60', size: '30' }, { price: '0.50', size: '270' }], asks: [{ price: '0.61', size: '5' }] });
assert.strictEqual(w3.getDepthImbalance(), null, 'falta el libro de NO');
w3._onBook({ asset_id: 'N', bids: [{ price: '0.39', size: '100' }], asks: [{ price: '0.40', size: '5' }] });
assert.deepStrictEqual(w3.getDepthImbalance(), { yes: 300, no: 100, imb: 0.5, imb5: -0.538 });
w3._bookByToken.get('N').updatedAt -= 6000;
assert.strictEqual(w3.getDepthImbalance(), null, 'libro de NO con más de 5 s');
console.log('book-depth: 27 ok');
process.exit(0);
