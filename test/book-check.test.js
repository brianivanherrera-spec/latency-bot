/**
 * Chequeo del libro (src/book-check.js): WS contra API REST de Polymarket.
 * Uso: node test/book-check.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const { BookCheck } = require('../src/book-check');

const top = new Map();
const setWs = (tok, bid, ask) => top.set(tok, { bestBid: bid, bestAsk: ask, updatedAt: Date.now() });
const poly = { _connected: true, _yesTokenId: 'Y', _noTokenId: 'N', _topOfBook: top };
let rest = {};
const fetchFn = async (url) => {
  const tok = new URL(url).searchParams.get('token_id');
  const b = rest[tok];
  if (!b) return { ok: false, status: 500 };
  if (b.during) b.during(); // el libro del WS cambia mientras viaja la consulta
  return { ok: true, json: async () => ({ timestamp: String(Date.now() - 500), bids: b.bids.map(p => ({ price: String(p), size: '10' })), asks: b.asks.map(p => ({ price: String(p), size: '10' })) }) };
};

(async () => {
  const bc = new BookCheck({ polyWs: poly, fetchFn, intervalMs: 0 });
  // Igual en los dos tokens (el REST trae varios niveles y desordenados)
  setWs('Y', 0.44, 0.45); setWs('N', 0.55, 0.56);
  rest = { Y: { bids: [0.40, 0.44, 0.43], asks: [0.50, 0.45, 0.47] }, N: { bids: [0.55, 0.50], asks: [0.60, 0.56] } };
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.oneCent, bc.s.more], [2, 2, 0, 0]);
  // 1¢ de diferencia en Sí; más de 1¢ en No
  rest = { Y: { bids: [0.44], asks: [0.46] }, N: { bids: [0.50], asks: [0.52] } };
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.oneCent, bc.s.more], [4, 2, 1, 1]);
  assert.deepStrictEqual([bc.s.moreStill, bc.s.moreMoving], [1, 0], 'No difiere con el WS quieto: diferencia real');
  assert.ok(bc.s.restAge.every(a => a >= 500 && a < 2000), 'edad del snapshot REST');
  // Lado vacío en los dos = igual; vacío en uno solo = diferencia
  setWs('Y', null, 0.01); rest = { Y: { bids: [], asks: [0.01] }, N: { bids: [0.99], asks: [] } };
  setWs('N', 0.99, 0.999);
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.more], [6, 3, 2]);
  // Ask a $1.00 en el WS y sin asks en el REST (mercado decidido): igual
  setWs('N', 0.99, 1); rest = { Y: { bids: [], asks: [0.01] }, N: { bids: [0.99], asks: [] } };
  setWs('Y', null, 0.01);
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.more], [8, 5, 2], 'ask $1.00 = sin oferta');
  // El WS se mueve durante la consulta: la diferencia es de tiempo, no de lectura
  setWs('Y', 0.40, 0.41); setWs('N', 0.59, 0.60);
  rest = { Y: { bids: [0.45], asks: [0.46], during: () => setWs('Y', 0.43, 0.44) }, N: { bids: [0.59], asks: [0.60] } };
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.moreMoving, bc.s.moreStill], [10, 6, 1, 2]); // el 2º quieto es el lado vacío de antes
  // REST caído y WS sin dato
  rest = {}; await bc.checkOnce();
  assert.strictEqual(bc.s.restErr, 2);
  top.clear(); rest = { Y: { bids: [0.4], asks: [0.41] }, N: { bids: [0.59], asks: [0.6] } };
  await bc.checkOnce();
  assert.strictEqual(bc.s.wsMissing, 2);
  assert.ok(/n=10 \| iguales 6 \(60.0%\).*libro moviéndose 1, con el libro quieto 2/.test(bc.summary()), bc.summary());
  console.log('book-check: 11 ok');
})().catch(e => { console.error(e); process.exit(1); });
