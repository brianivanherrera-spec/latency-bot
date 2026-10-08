/**
 * Modo dual de Chainlink (RTDS y PolyBolt alimentan los mismos historiales): entra el
 * primero que llega, el repetido o fuera de orden se descarta, se cuenta por fuente, y si
 * una fuente se apaga el historial sigue con la otra.
 * Uso: node test/chainlink-dual.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const { ChainlinkRTDS } = require('../src/chainlink-rtds');
const { ChainlinkSpot } = require('../src/chainlink-spot');

const T = Math.floor(Date.now() / 1000) * 1000 - 60000; // reciente: spot recorta lo de > 15 min
const tw = (src, ts, value) => ({ ...(src ? { src } : {}), topic: 'crypto_prices_twap_sixty',
  payload: { symbol: 'btc/usd', timestamp: ts, value, full_accuracy_value: String(value) } });
const sp = (src, ts, value) => ({ ...(src ? { src } : {}), topic: 'crypto_prices_chainlink',
  payload: { symbol: 'btc/usd', timestamp: ts, value } });

// TWAP 60 s
const c = new ChainlinkRTDS();
c._handle(tw(null, T, 82000.12), T + 1400);               // RTDS primero (sin src = rtds)
c._handle(tw('polybolt', T, 82000.12), T + 1500);         // repetido
c._handle(tw('polybolt', T + 1000, 82001.5), T + 2300);   // PolyBolt primero
c._handle(tw(null, T + 1000, 82001.5), T + 2400);         // repetido
c._handle(tw(null, T + 500, 82000.9), T + 2500);          // fuera de orden: no entra
assert.deepStrictEqual(c._hist[60].map(p => p.ts), [T, T + 1000], 'historial sin repetidos');
assert.strictEqual(c.getTwapAt(60, T + 1000), 82001.5);
assert.strictEqual(c.getLatestTWAP(60).value_num, 82001.5, 'el último no retrocede');
assert.strictEqual(c.bySrc.rtds.first, 1); assert.strictEqual(c.bySrc.rtds.dup, 2);
assert.strictEqual(c.bySrc.polybolt.first, 1); assert.strictEqual(c.bySrc.polybolt.dup, 1);
// Se apaga RTDS: PolyBolt sola sigue llenando el historial
for (let k = 2; k <= 5; k++) c._handle(tw('polybolt', T + k * 1000, 82001 + k), T + k * 1000 + 900);
assert.strictEqual(c.getTwapAt(60, T + 5000), 82006, 'sigue con PolyBolt');
assert.strictEqual(c.bySrc.polybolt.first, 5);
// Solo RTDS (modo rtds de siempre): puntos seguidos entran, el mismo segundo repetido no
const r = new ChainlinkRTDS();
r._handle(tw(null, T, 82000), T + 1000);
r._handle(tw(null, T, 82000), T + 1100);
r._handle(tw(null, T + 1000, 82001), T + 2000);
assert.deepStrictEqual(r._hist[60].map(p => p.ts), [T, T + 1000]);
assert.strictEqual(r.diag.duplicates, 1);

// Spot
const s = new ChainlinkSpot();
s._handle(sp(null, T, 82050));
s._handle(sp('polybolt', T + 2000, 82052));
s._handle(sp(null, T, 82050));                 // repetido (no es el último)
s._handle(sp(null, T + 1000, 82051));          // fuera de orden nuevo: entra ordenado
s._handle(sp('polybolt', T + 1000, 82051));    // repetido en el medio
s._handle(sp(null, T + 2000, 82052));          // repetido (el último)
assert.deepStrictEqual(s._history.map(p => p.ts), [T, T + 1000, T + 2000], 'spot sin repetidos');
assert.strictEqual(s.bySrc.rtds.first, 2); assert.strictEqual(s.bySrc.rtds.dup, 2);
assert.strictEqual(s.bySrc.polybolt.first, 1); assert.strictEqual(s.bySrc.polybolt.dup, 1);

// Watchdog de cada socket del RTDS: solo cuentan sus propios datos (PolyBolt no lo tapa)
const w = new ChainlinkRTDS();
w._openedAt = T;
w._handle(tw('polybolt', T + 9000, 82010), T + 60000);
assert.strictEqual(w._rtdsSilenceMs(T + 60000), 60000, 'PolyBolt no tapa al RTDS callado');
w._staleStreak = 3;
assert.strictEqual(w._staleLimitMs(), 240000, 'el umbral se duplica con cada reconexión seguida');
w._staleStreak = 9;
assert.strictEqual(w._staleLimitMs(), 480000, 'tope 16 veces');
w._handle(tw(null, T + 10000, 82011), T + 61000);
assert.strictEqual(w._rtdsSilenceMs(T + 61000), 0, 'llegó TWAP del RTDS');
assert.strictEqual(w._staleStreak, 0, 'y reinicia la racha');
assert.strictEqual(w._staleLimitMs(), 30000);
const sw = new ChainlinkSpot();
sw._openedAt = Date.now();
sw._handle(sp('polybolt', T + 3000, 82053));
assert.strictEqual(sw._rtdsSilenceMs(sw._openedAt + 60000), 60000, 'spot: PolyBolt no tapa al RTDS callado');
sw._staleStreak = 2;
sw._handle(sp(null, T + 4000, 82054));
assert.ok(sw._rtdsSilenceMs(sw.bySrc.rtds.last + 5) === 5 && sw._staleStreak === 0, 'spot: llegó del RTDS');
console.log('chainlink-dual: 26 ok');
