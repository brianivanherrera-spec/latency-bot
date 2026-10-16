/**
 * Precio de Chainlink de otro activo para la sombra de ETH 5 min (src/aux-price.js) y los símbolos extra de PolyBolt
 * (src/chainlink-polybolt.js): el ETH va a un historial y callback aparte, sin tocar lo de BTC.
 * Uso: node test/aux-price.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const { AuxPrice } = require('../src/aux-price');
const { twapFairUp } = require('../src/fair-value');
const { PolyBoltClient } = require('../src/chainlink-polybolt');

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
let ok = 0;
const check = (cond, msg) => { assert.ok(cond, msg); ok++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); ok++; };

// 1) AuxPrice: strike, σ, P(UP)
{
  const T0 = Date.UTC(2026, 9, 13, 10, 0, 0); // apertura de un mercado de 5 min
  let clock = T0 - 20 * 60 * 1000;
  const fv = { ticks: [], onTick(v, ts) { this.ticks.push([v, ts]); }, s: 40e-6, sigma() { return this.s; } };
  const a = new AuxPrice({ symbol: 'ethusd', fairValue: fv, now: () => clock });
  // Spot cada segundo durante 20 min (precio fijo 4000) y TWAP publicado cada segundo
  for (let t = T0 - 20 * 60 * 1000; t <= T0 - 2000; t += 1000) {
    clock = t;
    a.onPoint('spot', { ts: t, value: 4000, received: t + 300 });
    a.onPoint('twap', { ts: t, value: 3999, received: t + 300 });
  }
  eq(fv.ticks.length, 1199, 'cada spot alimenta la σ de 15 min');
  check(a.hist.spot.length <= 1200, 'historial acotado');
  // Duplicado (snapshot al reconectar) y punto fuera de orden
  const n = a.hist.spot.length;
  a.onPoint('spot', { ts: T0 - 3000, value: 4000, received: clock });
  eq(a.hist.spot.length, n, 'duplicado ignorado');
  a.onPoint('spot', { ts: T0 - 2500, value: 4000.5, received: clock });
  eq([a.hist.spot.length, a.hist.spot[a.hist.spot.length - 2].ts], [n + 1, T0 - 2500], 'fuera de orden: se inserta en su lugar');
  a.onPoint('spot', { ts: T0 - 1000, value: NaN, received: clock });
  eq(a.hist.spot.length, n + 1, 'valor inválido ignorado');
  // Strike: el TWAP del segundo de apertura, recién cuando llegó uno posterior
  eq(a.strike(T0), null, 'sin puntos posteriores todavía');
  clock = T0;
  a.onPoint('twap', { ts: T0, value: 4001.25, received: T0 + 400 });
  eq(a.strike(T0), null, 'el del segundo exacto llegó pero falta uno posterior');
  clock = T0 + 1000;
  a.onPoint('twap', { ts: T0 + 1000, value: 4001.5, received: T0 + 1400 });
  eq(a.strike(T0), 4001.25, 'strike = TWAP 60 s publicado en la apertura');
  // Si faltó el punto del segundo exacto vale el de hasta 1 s antes; si el hueco es mayor, no hay strike
  const b = new AuxPrice({ symbol: 'ethusd', fairValue: fv, now: () => T0 });
  b.onPoint('twap', { ts: T0 - 800, value: 10, received: T0 });
  b.onPoint('twap', { ts: T0 + 500, value: 11, received: T0 });
  eq(b.strike(T0), 10, 'hueco < 1 s');
  const c = new AuxPrice({ symbol: 'ethusd', fairValue: fv, now: () => T0 });
  c.onPoint('twap', { ts: T0 - 3000, value: 10, received: T0 });
  c.onPoint('twap', { ts: T0 + 500, value: 11, received: T0 });
  eq(c.strike(T0), null, 'hueco de 3 s: sin strike');

  // P(UP) con 240 s por delante: la fórmula del bot con P = último spot y σ = máx(σ, piso) × multiplicador
  clock = T0 + 60 * 1000;
  a.onPoint('spot', { ts: clock, value: 4003, received: clock + 200 });
  const endMs = T0 + 300 * 1000;
  const f = a.fair(4001.25, endMs, clock + 200, { volMult: 1.4, floor: 3e-5 });
  near(f.sigma, 40e-6 * 1.4);
  near(f.p, twapFairUp(4003, 4001.25, (endMs - clock - 200) / 1000, 60, 40e-6 * 1.4, null).p);
  check(f.p > 0.5 && f.sigmaLong === 40e-6 && f.sigmaShort === null, 'arriba del strike: P > 0.5');
  fv.s = 1e-6;
  near(a.fair(4001.25, endMs, clock + 200, { volMult: 1.4, floor: 3e-5 }).sigma, 3e-5 * 1.4, 1e-15);
  fv.s = 40e-6;
  // En el último minuto entra lo ya promediado (spot de los últimos W − T segundos)
  for (let t = clock + 1000; t <= endMs - 20000; t += 1000) a.onPoint('spot', { ts: t, value: 3990, received: t + 200 });
  const now2 = endMs - 20000 + 200;
  const real = a.spotMean(endMs - 20000 - 40000, endMs - 20000);
  near(real, 3990);
  const f2 = a.fair(4001.25, endMs, now2, { volMult: 1.4, floor: 3e-5 });
  near(f2.p, twapFairUp(3990, 4001.25, (endMs - now2) / 1000, 60, 40e-6 * 1.4, 3990).p);
  check(f2.p < 0.01, 'abajo del strike a 20 s: P ≈ 0');
  // Sin spot reciente, sin σ, sin strike o con el mercado cerrado: sin modelo
  eq(a.fair(4001.25, endMs, now2 + 15000), null, 'spot de hace más de 10 s');
  fv.s = null;
  eq(a.fair(4001.25, endMs, now2), null, 'sin σ todavía');
  fv.s = 40e-6;
  eq([a.fair(null, endMs, now2), a.fair(4001.25, now2 - 1, now2)], [null, null], 'sin strike o cerrado');
}

// 2) PolyBolt con símbolos extra: frame aparte, historial y callback propios, sin tocar lo de BTC
{
  const pb = new PolyBoltClient({ getCreds: async () => null, extraSymbols: ['ETHUSD', 'btcusd', 'ethusd'] });
  eq(pb.extraSymbols, ['ethusd'], 'sin repetidos y sin BTC');
  const frames = [];
  pb._send = (frame) => { frames.push(frame); return String(frames.length); };
  pb._handle({ op: 'authed' });
  eq(frames.length, 2, 'BTC y ETH en frames separados');
  eq(frames[0].subscriptions.map(x => x.filter.symbol), ['btcusd', 'btcusd']);
  eq(frames[1].subscriptions.map(x => [x.channel, x.filter.symbol, x.filter.window_seconds]),
    [['price.crypto', 'ethusd', undefined], ['price.crypto.twap', 'ethusd', 60]]);
  eq(pb._extraRid, '2');
  pb._handle({ op: 'subscribed', channel: 'price.crypto', rid: '1' });
  pb._handle({ op: 'subscribed', channel: 'price.crypto', rid: '2' });
  eq(pb.diag.subscribed, ['price.crypto'], 'el ack de ETH no se cuenta como de BTC');
  // Error del server con el rid de ETH: aviso, sin contar como error de BTC; sin rid: error (con la aclaración)
  pb._handle({ op: 'error', code: 'unknown_symbol', channel: 'price.crypto', rid: '2' });
  eq([pb.diag.errors, pb.diag.last_error], [0, null], 'rechazo de ETH no toca el diag de BTC');
  pb._handle({ op: 'error', code: 'x', channel: 'price.crypto.twap' });
  eq([pb.diag.errors, pb.diag.last_error], [1, 'x (price.crypto.twap)']);
  const got = [];
  pb.onExtra((sym, kind, pt) => got.push([sym, kind, pt.ts, pt.value, pt.snapshot]));
  const spots = [];
  pb.onSpot(pt => spots.push(pt.value));
  const now = Date.now();
  pb._lastDataAt = 0;
  pb._handle({ v: 1, channel: 'price.crypto', payload: { symbol: 'ethusd', timestamp: now, value: 3987.5 } });
  pb._handle({ v: 1, channel: 'price.crypto.twap', snapshot: true, dropped: 3,
    payload: { symbol: 'ethusd', window_seconds: 60, data: [{ timestamp: now - 2000, value: '3980.1' }, { timestamp: now - 1000, value: 3981 }] } });
  pb._handle({ v: 1, channel: 'price.crypto', payload: { symbol: 'ethusd', timestamp: now, value: 3987.5 } }); // duplicado
  pb._handle({ v: 1, channel: 'price.crypto', payload: { symbol: 'solusd', timestamp: now, value: 150 } });   // no pedido
  eq(got, [['ethusd', 'spot', now, 3987.5, false], ['ethusd', 'twap', now - 2000, 3980.1, true], ['ethusd', 'twap', now - 1000, 3981, true]]);
  eq([pb.extraHist.ethusd.spot.length, pb.extraHist.ethusd.twap.length, pb.diag.extra.ethusd.spot, pb.diag.extra.ethusd.twap], [1, 2, 1, 2]);
  eq([pb.hist.spot.length, pb.hist.twap.length, pb.diag.spot, pb.diag.twap, pb.diag.dropped, pb._lastDataAt, spots.length], [0, 0, 0, 0, 0, 0, 0],
    'el ETH no entra al historial de BTC ni al "sin datos" que reconecta por silencio de BTC');
  // BTC igual que antes (con y sin símbolo en el payload)
  pb._handle({ v: 1, channel: 'price.crypto', payload: { symbol: 'btcusd', timestamp: now, value: 83500.12 } });
  pb._handle({ v: 1, channel: 'price.crypto', payload: { timestamp: now + 1000, value: 83501 } });
  pb._handle({ v: 1, channel: 'price.crypto', payload: { symbol: 'btcusd', timestamp: now + 2000, value: 500 } }); // fuera de rango para BTC
  eq([pb.hist.spot.length, pb.diag.spot, spots], [2, 2, [83500.12, 83501]]);
  check(pb._lastDataAt > 0, 'BTC sí actualiza el "sin datos"');
  eq(pb.extraHist.ethusd.spot.length, 1, 'el BTC no entra al historial de ETH');
  // Sin símbolos extra: un solo frame y el ETH se descarta como antes
  const pb2 = new PolyBoltClient({ getCreds: async () => null });
  const f2 = [];
  pb2._send = (frame) => { f2.push(frame); return String(f2.length); };
  pb2._handle({ op: 'authed' });
  pb2._handle({ v: 1, channel: 'price.crypto', payload: { symbol: 'ethusd', timestamp: now, value: 3987.5 } });
  eq([f2.length, pb2.hist.spot.length, Object.keys(pb2.extraHist).length, pb2._extraRid], [1, 0, 0, undefined]);
  // Dos cortes a poco de suscribir ETH: se deja de pedir (BTC sigue); un corte lejos de la suscripción no cuenta
  const pb3 = new PolyBoltClient({ getCreds: async () => null, extraSymbols: ['ethusd'] });
  const f3 = [];
  pb3._send = (frame) => { f3.push(frame); return String(f3.length); };
  pb3._handle({ op: 'authed' });
  pb3._extraGuard(4000);
  eq(pb3.extraSymbols, ['ethusd'], 'un corte: sigue');
  pb3._extraSentAt = Date.now() - 60000;
  pb3._extraGuard(1006);
  eq(pb3._extraCloses, 1, 'corte lejos de la suscripción: no cuenta');
  pb3._handle({ op: 'authed' });
  pb3._extraGuard(4000);
  eq(pb3.extraSymbols, [], 'segundo corte: deja de pedir ETH');
  f3.length = 0;
  pb3._handle({ op: 'authed' });
  eq(f3.map(x => x.subscriptions.map(y => y.filter.symbol)), [['btcusd', 'btcusd']], 'al reconectar solo BTC');
  // Los cortes nuestros por "Sin datos" no cuentan (15/10 22:25 ARG: dos reconexiones por silencio de BTC apagaron ETH)
  const pb5 = new PolyBoltClient({ getCreds: async () => null, extraSymbols: ['ethusd'] });
  pb5._send = () => '1';
  pb5._handle({ op: 'authed' });
  pb5._extraGuard(1006, true);
  pb5._handle({ op: 'authed' });
  pb5._extraGuard(1006, true);
  eq([pb5.extraSymbols, pb5._extraCloses || 0], [['ethusd'], 0], 'dos cortes nuestros por silencio: ETH sigue');
  pb5._extraGuard(1006);
  pb5._handle({ op: 'authed' });
  pb5._extraGuard(1006);
  eq(pb5.extraSymbols, [], 'dos cortes del server: deja de pedir ETH como antes');

  // "Sin datos" de PolyBolt (bitácora 14/10 ~23:40 ARG): 10 s sin BTC desde el último dato o la autenticación
  const pb4 = new PolyBoltClient({ getCreds: async () => null });
  pb4._send = () => '1';
  const t0 = Date.now();
  pb4._lastMsgAt = t0;
  eq(pb4._staleReason(t0 + 60000 - 1), null, 'sin autenticar no mira los datos');
  check(/^msg hace 90000 ms$/.test(pb4._staleReason(t0 + 90000) || ''), 'sin ningún mensaje en 90 s: reconecta');
  pb4._handle({ op: 'authed' });
  const ta = pb4._authedAt;
  pb4._lastMsgAt = ta;
  eq(pb4._staleReason(ta + 10000), null, 'recién autenticado: espera 10 s aunque el último dato sea viejo');
  check(/último dato de BTC hace 10001 ms/.test(pb4._staleReason(ta + 10001) || ''), 'autenticado y 10 s sin datos: reconecta');
  pb4._lastDataAt = ta + 5000;
  eq(pb4._staleReason(ta + 15000), null, 'con un dato hace 10 s todavía no');
  check(pb4._staleReason(ta + 15001) != null, 'con el último dato hace más de 10 s: reconecta');
  eq(pb4._staleReason(ta + 15001, 30000), null, 'con POLYBOLT_STALE_MS=30000 espera 30 s');
  pb4._handle({ v: 1, channel: 'price.crypto', payload: { symbol: 'ethusd', timestamp: ta + 20000, value: 3987.5 } });
  check(pb4._staleReason(ta + 20000) != null, 'el ETH no cuenta como dato de BTC');
}

console.log(`aux-price: ${ok} ok`);
