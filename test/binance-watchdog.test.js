/**
 * Watchdog de Binance (src/binance.js): con el mercado quieto, ping de prueba antes de reconectar.
 * Primero la decisión pura (_watchdogCheck) y después contra un servidor WS local que contesta o no el ping.
 * Uso: node test/binance-watchdog.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const { WebSocketServer } = require('ws');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function load(env) {
  for (const k of ['BINANCE_WS_URL', 'BINANCE_WATCHDOG_MS', 'BINANCE_WATCHDOG_PING', 'BINANCE_WATCHDOG_PONG_MS', 'BINANCE_WATCHDOG_HARD_MS']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/binance')];
  return require('../src/binance').BinanceWS;
}

// ── Decisión pura ───────────────────────────────────────────────────────────
{
  const BinanceWS = load({});
  const b = new BinanceWS();
  const t0 = 1_000_000;
  b._lastDataAt = t0;
  eq(b._watchdogCheck(t0 + 5000), null, 'hasta 5 s sin operaciones: nada');
  eq(b._watchdogCheck(t0 + 5001), 'ping', 'pasados los 5 s: ping de prueba');
  eq(b._watchdogCheck(t0 + 6000), null, 'esperando el pong');
  ok(/^sin datos hace 8001ms y sin pong en 3000ms$/.test(b._watchdogCheck(t0 + 8001) || ''), 'sin pong en 3 s: reconecta');
  // Con pong: sigue, y vuelve a probar cada 5 s
  b._probeAt = 0;
  eq(b._watchdogCheck(t0 + 5001), 'ping');
  b._lastPongAt = t0 + 5100;
  eq(b._watchdogCheck(t0 + 9000), null, 'contestó: sigue conectado');
  eq(b._watchdogCheck(t0 + 10001), 'ping', 'otro ping 5 s después del anterior');
  b._lastPongAt = t0 + 10050;
  eq(b._watchdogCheck(t0 + 15000), null);
  eq(b._watchdogCheck(t0 + 15001), 'ping');
  b._lastPongAt = t0 + 15060;
  eq(b._watchdogCheck(t0 + 20000), null);
  ok(/^sin datos hace 30001ms \(tope de 30000 ms/.test(b._watchdogCheck(t0 + 30001) || ''), '30 s sin operaciones: reconecta aunque conteste');
  // Llega una operación: se borra la prueba
  b._lastDataAt = t0 + 30500;
  eq([b._watchdogCheck(t0 + 31000), b._probeAt], [null, 0], 'con datos de nuevo: sin prueba en curso');
  // Coinbase: sin ping, 30 s de margen como antes
  const c = new BinanceWS({ source: 'coinbase' });
  c._lastDataAt = t0;
  eq(c._watchdogCheck(t0 + 30000), null);
  ok(/^sin datos hace 30001ms$/.test(c._watchdogCheck(t0 + 30001) || ''), 'Coinbase: corte a los 30 s, sin ping');
  // Apagado: el corte a los 5 s de antes
  const BinanceOff = load({ BINANCE_WATCHDOG_PING: 'off' });
  const d = new BinanceOff();
  d._lastDataAt = t0;
  ok(/^sin datos hace 5001ms$/.test(d._watchdogCheck(t0 + 5001) || ''), 'BINANCE_WATCHDOG_PING=off: reconecta a los 5 s como antes');
}

// ── Contra un servidor local ────────────────────────────────────────────────
async function run(autoPong) {
  const wss = new WebSocketServer({ port: 0, autoPong });
  await new Promise(r => wss.on('listening', r));
  let conns = 0;
  wss.on('connection', (s) => { conns++; s.send(JSON.stringify({ p: '83500.5', T: Date.now() })); });
  const BinanceWS = load({
    BINANCE_WS_URL: `ws://127.0.0.1:${wss.address().port}`,
    BINANCE_WATCHDOG_MS: '300', BINANCE_WATCHDOG_PONG_MS: '700', BINANCE_WATCHDOG_HARD_MS: '60000',
  });
  const b = new BinanceWS();
  const prices = [];
  b.onPrice((x) => prices.push(x.price));
  await b.connect();
  await sleep(3800);
  const res = { conns, prices: prices.length, probe: b._probeAt > 0, pong: b._lastPongAt > 0 };
  b.close();
  for (const s of wss.clients) s.terminate();
  await new Promise(r => wss.close(r));
  return res;
}

(async () => {
  const alive = await run(true);
  eq([alive.conns, alive.prices >= 1, alive.pong], [1, true, true], 'el server contesta el ping: no reconecta aunque no haya operaciones');
  const dead = await run(false);
  ok(dead.conns >= 2, `el server no contesta el ping: reconecta (${dead.conns} conexiones)`);
  console.log(`binance-watchdog: ${passed} ok`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
