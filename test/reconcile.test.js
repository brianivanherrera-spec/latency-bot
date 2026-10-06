/**
 * Reconciliación de compras reales contra trades del CLOB (scripts/reconcile-live.js).
 * Uso: node test/reconcile.test.js
 */
'use strict';
const assert = require('assert');
const { reconcile, lines } = require('../scripts/reconcile-live');

const W = '0xAbC0000000000000000000000000000000000001';
const T0 = 1_791_300_000_000;
const iso = ms => new Date(ms).toISOString();
const fill = (posId, token, t, shares, price) => ({ posId, fill_result: 'FILLED', size_filled: shares, order_price: String(price + 0.01),
  latencies: { t4_order_sent_ms: t }, exec: { mode: 'live', token_id: token, fill_price: price } });
const taker = (id, asset, t, size, price, side = 'BUY') => ({ id, trader_side: 'TAKER', asset_id: asset, side, size: String(size), price: String(price), match_time: iso(t), maker_orders: [] });

// A: una compra de 7 en dos trades (4 a 0.70 y 3 a 0.71) → coincide
// B: el bot dice 6 a 0.75 y Polymarket tiene 6 a 0.78 → diferencia de precio
// C: el bot registró una compra y no hay trade → solo bot
// D: compra como maker (GTD en el libro) 5 a 0.66, 3 min después del envío → coincide
// E: trade de compra sin registro del bot; y una venta (solo se cuenta)
const fills = [fill('A', 'tokA', T0, 7, 0.7043), fill('B', 'tokB', T0 + 400_000, 6, 0.75),
  fill('C', 'tokC', T0 + 800_000, 5, 0.6), fill('D', 'tokD', T0 + 1_200_000, 5, 0.66),
  { posId: 'X', fill_result: 'FILLED', size_filled: 8, exec: { mode: 'paper', token_id: 'tokA' } }];
const trades = [
  taker('t1', 'tokA', T0 + 300, 4, 0.70), taker('t2', 'tokA', T0 + 350, 3, 0.71),
  taker('t3', 'tokB', T0 + 400_200, 6, 0.78),
  { id: 't4', trader_side: 'MAKER', asset_id: 'tokZ', side: 'SELL', size: '5', price: '0.34', match_time: iso(T0 + 1_380_000),
    maker_orders: [{ order_id: 'o1', maker_address: W.toLowerCase(), matched_amount: '5', price: '0.66', asset_id: 'tokD', side: 'BUY' },
      { order_id: 'o2', maker_address: '0xotro', matched_amount: '9', price: '0.66', asset_id: 'tokD', side: 'BUY' }] },
  taker('t5', 'tokE', T0 + 2_000_000, 7, 0.62),
  taker('t6', 'tokA', T0 + 2_100_000, 7, 0.95, 'SELL'),
];

const r = reconcile({ fills, trades, wallet: W });
assert.strictEqual(r.botFills, 4, 'solo compras reales');
assert.strictEqual(r.polyBuys, 5); assert.strictEqual(r.polySells, 1);
assert.deepStrictEqual(r.matched.map(m => m.posId), ['A', 'D']);
assert.strictEqual(r.matched[0].polyShares, 7); assert.strictEqual(r.matched[0].polyPrice, 0.7043);
assert.strictEqual(r.matched[1].polyShares, 5, 'como maker cuenta solo nuestra orden');
assert.deepStrictEqual(r.mismatches.map(m => [m.posId, m.polyPrice]), [['B', 0.78]]);
assert.deepStrictEqual(r.botOnly.map(b => b.posId), ['C']);
assert.deepStrictEqual(r.polyOnly.map(p => p.id), ['t5']);
const L = lines(r);
assert.strictEqual(L.filter(l => l.includes('⚠️')).length, 3);
// Sin diferencias
const ok = reconcile({ fills: [fills[0]], trades: trades.slice(0, 2), wallet: W });
assert.ok(lines(ok).includes('[RECONCILIA] sin diferencias'));
// Fuera de la ventana de 10 min no empareja
assert.deepStrictEqual(reconcile({ fills: [fill('F', 'tokA', T0, 4, 0.7)], trades: [taker('t7', 'tokA', T0 + 11 * 60_000, 4, 0.7)], wallet: W }).botOnly.map(b => b.posId), ['F']);
console.log('reconcile: 14 ok');
