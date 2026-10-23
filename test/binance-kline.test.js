/**
 * Velas de Binance para los mercados horarios (src/binance-kline.js): apertura sincrónica con pedido en segundo plano,
 * reintento espaciado, segundo host si el primero falla y ganador solo con la vela cerrada.
 * Uso: node test/binance-kline.test.js
 */
'use strict';
const assert = require('assert');
const { BinanceKlines } = require('../src/binance-kline');

const H = 3600000, H0 = Date.parse('2026-10-23T14:00:00Z');
const kl = (start, open, close) => [start, String(open), '0', '0', String(close), '0', start + H - 1];

(async () => {
  let clock = H0 + 1000, fail = new Set(), close = 100050;
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (fail.has(u.host)) return { ok: false, status: 451, json: async () => ({}) };
    const start = Number(u.searchParams.get('startTime'));
    return { ok: true, json: async () => [kl(start, 100000.5, close)] };
  };
  const k = new BinanceKlines({ fetchFn, now: () => clock, retryMs: 5000 });
  // Primera llamada: null y un pedido en segundo plano; cuando llega, la apertura queda guardada
  assert.strictEqual(k.open(H0), null);
  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].startsWith('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=' + H0), urls[0]);
  assert.strictEqual(k.open(H0), null, 'mientras el pedido está en vuelo no pide otro');
  assert.strictEqual(urls.length, 1);
  await k.tries.get(H0).done;
  assert.strictEqual(k.open(H0), 100000.5);
  assert.strictEqual(urls.length, 1, 'ya la tiene: no vuelve a pedir');
  // Una hora que todavía no empezó: no pide
  assert.strictEqual(k.open(H0 + H), null);
  assert.strictEqual(urls.length, 1);
  // El primer host falla: usa el espejo; si fallan los dos, reintenta recién a los retryMs
  clock = H0 + H + 1000;
  fail = new Set(['api.binance.com']);
  k.open(H0 + H); await k.tries.get(H0 + H).done;
  assert.strictEqual(k.open(H0 + H), 100000.5);
  assert.ok(urls[urls.length - 1].startsWith('https://data-api.binance.vision/'), urls[urls.length - 1]);
  clock = H0 + 2 * H + 1000;
  fail = new Set(['api.binance.com', 'data-api.binance.vision']);
  const n0 = urls.length;
  assert.strictEqual(k.open(H0 + 2 * H), null);
  await k.tries.get(H0 + 2 * H).done;
  assert.strictEqual(urls.length, n0 + 2);
  clock += 1000;
  assert.strictEqual(k.open(H0 + 2 * H), null);
  assert.strictEqual(urls.length, n0 + 2, 'antes de retryMs no reintenta');
  clock += 5000;
  fail = new Set();
  k.open(H0 + 2 * H); await k.tries.get(H0 + 2 * H)?.done;
  assert.strictEqual(k.open(H0 + 2 * H), 100000.5);
  // Ganador: solo con la vela cerrada; cierre ≥ apertura es UP
  clock = H0 + H - 10;
  assert.strictEqual(await k.winner(H0), null, 'la vela todavía no cerró');
  clock = H0 + H + 5000;
  assert.strictEqual(await k.winner(H0), 'UP');
  close = 99999;
  assert.strictEqual(await k.winner(H0), 'DOWN');
  close = 100000.5;
  assert.strictEqual(await k.winner(H0), 'UP', 'igual a la apertura: UP');
  // Respuesta de otra vela (startTime distinto): no sirve
  const kx = new BinanceKlines({ fetchFn: async () => ({ ok: true, json: async () => [kl(H0 - H, 1, 2)] }), now: () => H0 + 2 * H });
  assert.strictEqual(await kx.winner(H0), null);
  console.log('binance-kline: 18 ok');
})().catch(e => { console.error(e); process.exit(1); });
