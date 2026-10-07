/**
 * Informe de ejecución (scripts/exec-report.js) con datos armados a mano.
 * Uso: node test/exec-report.test.js
 */
'use strict';
const assert = require('assert');
const { buildReport, lines, FEE } = require('../scripts/exec-report');

const END = 1_791_300_000_000; // fin de un mercado
const mk = (endMs, winner) => ({ start_ts: endMs - 300_000, end_ts: endMs, winner });
const markets = [mk(END, 'UP'), mk(END + 300_000, 'DOWN'), mk(END + 600_000, 'UP')];
const lat = (t3, extra = {}) => ({ t3_price_decision_ms: t3, t4_order_sent_ms: t3 + 5, t3_to_t4_ms: 5, t4_to_t5_ms: 120, ...extra });

const fills = [
  // real: llenada a 0.71 con ask 0.70, ganó (UP en mercado UP); paper también habría llenado
  { posId: 'A', fill_result: 'FILLED', order_price: '0.7200', order_size: 7, size_filled: 7, signal_direction: 'UP',
    latencies: lat(END - 100_000, { t3_to_t7_ms: 300 }),
    exec: { mode: 'live', decision_ask: 0.70, fill_price: 0.71, market_end_ms: END, paper_would_fill: true } },
  // real: sin fill (el precio se fue), paper habría llenado; el mercado lo ganó DOWN = habría ganado
  { posId: 'B', fill_result: 'NO_FILL', order_price: '0.6500', order_size: 7, size_filled: 0, signal_direction: 'DOWN',
    rejection_reason: 'FAK sin liquidez', latencies: lat(END + 200_000),
    exec: { mode: 'live', decision_ask: 0.63, market_end_ms: END + 300_000, paper_would_fill: true } },
  // real: parcial, perdió (DOWN en mercado UP)
  { posId: 'C', fill_result: 'FILLED', order_price: '0.7600', order_size: 6, size_filled: 3, signal_direction: 'DOWN',
    latencies: lat(END + 500_000, { t3_to_t7_ms: 500 }),
    exec: { mode: 'live', decision_ask: 0.74, fill_price: 0.75, market_end_ms: END + 600_000, paper_would_fill: false } },
  // paper: sin fill porque el ask subió
  { posId: 'P1', fill_result: 'NO_FILL', order_price: '0.6200', order_size: 8, size_filled: 0, signal_direction: 'UP',
    rejection_reason: 'Paper mode simulation (fill_rate=100%)', timestamp: END - 50_000,
    exec: { mode: 'paper', decision_ask: 0.60, fill_ask_delay: 0.65, size_delay: 0, market_end_ms: END } },
  // paper sin exec (registro viejo): el modo sale de signals.jsonl
  { posId: 'P2', fill_result: 'FILLED', order_price: '0.6600', order_size: 7, size_filled: 7, signal_direction: 'UP',
    order_status: 'simulated_filled', timestamp: END - 40_000 },
];
const signals = [
  { posId: 'A', mode: 'live', direction: 'UP', result: 'WIN', pnl: 1.9 },
  { posId: 'B', mode: 'live', direction: 'DOWN', result: 'NO_FILL', pnl: 0 },
  { posId: 'C', mode: 'live', direction: 'DOWN', result: 'LOSS', pnl: -2.3 },
  { posId: 'P2', mode: 'paper', direction: 'UP', result: 'WIN', pnl: 2.2 },
];

const rep = buildReport({ fills, signals, markets });
const L = rep.modes.live, P = rep.modes.paper;
assert.strictEqual(L.attempts, 3); assert.strictEqual(L.filled, 2); assert.strictEqual(L.partial, 1);
assert.strictEqual(L.fillRate, 0.6667);
assert.deepStrictEqual(L.noFillReasons, [['FAK sin liquidez', 1]]);
assert.strictEqual(L.slippage.mean, 0.01, 'sobreprecio 1¢ en las dos llenadas');
assert.strictEqual(L.adverse.filled.wr, 0.5, 'llenadas: 1 de 2');
assert.strictEqual(L.adverse.notFilled.wr, 1, 'la no llenada habría ganado');
assert.strictEqual(L.adverse.missedEvPerShare, +((1 - 0.63) - FEE * 0.63 * 0.37).toFixed(4));
assert.deepStrictEqual([L.pnl.closed, L.pnl.wins, L.pnl.total], [2, 1, -0.4]);
assert.strictEqual(L.latencyMs.sendToResponse.p50, 120);
assert.deepStrictEqual([L.paperVsReal.both, L.paperVsReal.paperOnly, L.paperVsReal.realOnly], [1, 1, 1]);
assert.strictEqual(L.paperVsReal.paperFillRate, 0.6667);
assert.strictEqual(P.attempts, 2); assert.strictEqual(P.filled, 1);
assert.deepStrictEqual(P.noFillReasons, [['ask subió por encima del límite', 1]]);
assert.strictEqual(P.latencyMs, null);
assert.ok(lines(rep).some(l => l.startsWith('[EJECUCION] REAL vs lo que habría dicho paper')));
// Corte por fecha
assert.strictEqual(buildReport({ fills, signals, markets, since: END + 400_000 }).modes.live.attempts, 1);
console.log('exec-report: 16 ok');
