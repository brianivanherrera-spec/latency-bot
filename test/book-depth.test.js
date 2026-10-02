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

ws._onPriceChange({ price_changes: [{ asset_id: T, price: '0.60', size: '0', side: 'SELL', best_bid: '0.58', best_ask: '0.61' }] });
assert.strictEqual(ws.getAskSizeUpTo(T, 0.61), 4, 'nivel retirado no cuenta');

ws._topOfBook.get(T).updatedAt -= 10_000;
assert.strictEqual(ws.getAskSizeUpTo(T, 0.61), null, 'libro viejo = sin dato');
assert.strictEqual(ws.getAskSizeUpTo('otro', 0.61), null, 'token sin libro = sin dato');
console.log('book-depth: 8 ok');
process.exit(0);
