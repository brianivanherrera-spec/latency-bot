/**
 * Chequeo del libro (src/book-check.js): WS contra API REST de Polymarket.
 * Uso: node test/book-check.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const { BookCheck, fetchRestBook, restSizeUpTo, restVwapUpTo } = require('../src/book-check');

const top = new Map();
const setWs = (tok, bid, ask, topTs = null) => top.set(tok, { bestBid: bid, bestAsk: ask, updatedAt: Date.now(), topTs });
const poly = { _connected: true, _yesTokenId: 'Y', _noTokenId: 'N', _topOfBook: top, _lastLagMs: 20, _lastLagAt: Date.now() };
let rest = {};
const fetchFn = async (url) => {
  const tok = new URL(url).searchParams.get('token_id');
  const b = rest[tok];
  if (!b) return { ok: false, status: 500 };
  if (b.during) b.during(); // el libro del WS cambia mientras viaja la consulta
  return { ok: true, json: async () => ({ timestamp: String(Date.now() - 500), bids: b.bids.map(p => ({ price: String(p), size: '10' })), asks: b.asks.map(p => ({ price: String(p), size: '10' })) }) };
};

(async () => {
  // Libro REST: niveles ordenados, mejor bid/ask, tamaño hasta un límite
  rest = { Y: { bids: [0.40, 0.44, 0.43], asks: [0.50, 0.45, 0.47] } };
  const rb = await fetchRestBook(fetchFn, 'Y');
  assert.deepStrictEqual([rb.bid, rb.ask], [0.44, 0.45]);
  assert.deepStrictEqual(rb.asks.map(a => a[0]), [0.45, 0.47, 0.50], 'asks de menor a mayor');
  assert.ok(rb.age >= 500 && rb.ts > 1e12, 'hora y edad del snapshot');
  assert.strictEqual(restSizeUpTo(rb, 0.47), 20, 'hasta $0.47: 10 + 10');
  assert.strictEqual(restSizeUpTo(rb, 0.44), 0, 'límite debajo del mejor ask');
  const vw = restVwapUpTo(rb, 0.47, 15);
  assert.strictEqual(vw.filled, 15, '15 acciones hasta $0.47');
  assert.ok(Math.abs(vw.vwap - (10 * rb.asks[0][0] + 5 * rb.asks[1][0]) / 15) < 1e-9, 'promedio de los dos niveles');
  assert.deepStrictEqual(restVwapUpTo(rb, 0.44, 5), { vwap: null, filled: 0 }, 'nada hasta el límite');
  assert.strictEqual(restSizeUpTo(null, 0.5), null);

  const bc = new BookCheck({ polyWs: poly, fetchFn, intervalMs: 0, lagMs: 100 });
  // Igual en los dos tokens (el REST trae varios niveles y desordenados)
  setWs('Y', 0.44, 0.45); setWs('N', 0.55, 0.56);
  rest = { Y: { bids: [0.40, 0.44, 0.43], asks: [0.50, 0.45, 0.47] }, N: { bids: [0.55, 0.50], asks: [0.60, 0.56] } };
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.oneCent, bc.s.more], [2, 2, 0, 0]);
  // 1¢ de diferencia en Sí; más de 1¢ en No con el WS quieto y al día (retraso 20 ms): diferencia real
  rest = { Y: { bids: [0.44], asks: [0.46] }, N: { bids: [0.50], asks: [0.52] } };
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.oneCent, bc.s.more], [4, 2, 1, 1]);
  assert.deepStrictEqual([bc.s.moreReal, bc.s.moreLagged, bc.s.moreMoving], [1, 0, 0], 'WS quieto y al día: real');
  assert.ok(bc.s.restAge.every(a => a >= 500 && a < 2000), 'edad del snapshot REST');
  // Lo mismo con el WS atrasado (retraso 500 ms ≥ 100): la diferencia es del atraso
  poly._lastLagMs = 500; poly._lastLagAt = Date.now();
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.moreReal, bc.s.moreLagged], [1, 1], 'WS quieto pero atrasado');
  poly._lastLagMs = 20; poly._lastLagAt = Date.now();
  // Lado vacío en los dos = igual; vacío en uno solo = diferencia
  setWs('Y', null, 0.01); rest = { Y: { bids: [], asks: [0.01] }, N: { bids: [0.99], asks: [] } };
  setWs('N', 0.99, 0.999);
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.more], [8, 3, 3]);
  // Ask a $1.00 en el WS y sin asks en el REST (mercado decidido): igual
  setWs('N', 0.99, 1); rest = { Y: { bids: [], asks: [0.01] }, N: { bids: [0.99], asks: [] } };
  setWs('Y', null, 0.01);
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.more], [10, 5, 3], 'ask $1.00 = sin oferta');
  // El WS se mueve durante la consulta: la diferencia es de tiempo, no de lectura
  setWs('Y', 0.40, 0.41); setWs('N', 0.59, 0.60);
  rest = { Y: { bids: [0.45], asks: [0.46], during: () => setWs('Y', 0.43, 0.44) }, N: { bids: [0.59], asks: [0.60] } };
  await bc.checkOnce();
  assert.deepStrictEqual([bc.s.n, bc.s.same, bc.s.moreMoving, bc.s.moreReal], [12, 6, 1, 2]); // el 2º real es el lado vacío de antes
  // REST caído y WS sin dato
  rest = {}; await bc.checkOnce();
  assert.strictEqual(bc.s.restErr, 2);
  top.clear(); rest = { Y: { bids: [0.4], asks: [0.41] }, N: { bids: [0.59], asks: [0.6] } };
  await bc.checkOnce();
  assert.strictEqual(bc.s.wsMissing, 2);
  assert.ok(/n=12 \| iguales 6 \(50.0%\).*libro moviéndose 1, con el WS atrasado 1, con el WS al día 2/.test(bc.summary()), bc.summary());
  // Retraso del WS: se toma el del último mensaje si es reciente (< 5 s), si no se ignora
  assert.strictEqual(bc.s.wsLag.length, 8);
  assert.ok(/retraso del WS al chequear p50 20 ms, máx 500 ms/.test(bc.summary()), bc.summary());
  poly._lastLagAt = Date.now() - 10000;
  await bc.checkOnce();
  assert.strictEqual(bc.s.wsLag.length, 8, 'retraso viejo: no cuenta');
  console.log('book-check: 23 ok');
})().catch(e => { console.error(e); process.exit(1); });
