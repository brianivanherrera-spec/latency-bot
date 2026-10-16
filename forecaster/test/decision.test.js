'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers');
const { decide, feePerShare, fillAsks } = require('../src/decision');
const { parseBook } = require('../src/clob');
const { book } = require('./helpers');

const mk = (o = {}) => ({ event_id: 'E1', token_yes: 'y', token_no: 'n', fees_enabled: false, fee_schedule: null, ...o });
const port = () => ({ openUsd: 0, openByEvent: new Map() });
const books = (yAsk, nAsk, size = 1000) => ({ yes: parseBook(book([[yAsk - 0.02, size]], [[yAsk, size]])), no: parseBook(book([[nAsk - 0.02, size]], [[nAsk, size]])) });

test('compra Si con edge suficiente y sin comision', () => {
  setup();
  const d = decide({ forecast: { p_yes: 0.70 }, market: mk(), books: books(0.50, 0.52), portfolio: port() });
  assert.strictEqual(d.action, 'comprar'); assert.strictEqual(d.side, 'SI');
  assert.ok(Math.abs(d.edge - 0.20) < 1e-9); assert.ok(Math.abs(d.stake_usd - 10) < 1e-9);
});

test('compra No cuando el pronostico es bajo', () => {
  setup();
  const d = decide({ forecast: { p_yes: 0.20 }, market: mk(), books: books(0.55, 0.50), portfolio: port() });
  assert.strictEqual(d.side, 'NO');
});

test('la comision puede voltear la decision', () => {
  setup();
  const m = mk({ fees_enabled: true, fee_schedule: { rate: 0.25 } });
  // fee(0.5)=0.25*0.25=0.0625: edge = 0.58-0.5-0.0625 = 0.0175 < 0.08
  const d = decide({ forecast: { p_yes: 0.58 }, market: m, books: books(0.5, 0.5), portfolio: port() });
  assert.strictEqual(d.action, 'omitir'); assert.strictEqual(d.reason, 'edge_insuficiente');
  const sin = decide({ forecast: { p_yes: 0.58 }, market: mk(), books: books(0.5, 0.5), portfolio: port() });
  assert.strictEqual(sin.action, 'comprar'); // sin comision el edge es 0.08
  assert.ok(Math.abs(feePerShare(0.5, m) - 0.0625) < 1e-12);
  assert.strictEqual(feePerShare(0.5, mk({ fees_enabled: false, fee_schedule: { rate: 0.25 } })), 0);
});

test('profundidad: respeta el ask, no compra caro ni sin liquidez', () => {
  setup();
  // solo $3 al ask 0.50; el siguiente nivel (0.70) ya no cumple el edge
  const b = { yes: parseBook(book([[0.48, 100]], [[0.50, 6], [0.70, 1000]])), no: parseBook(book([[0.4, 10]], [[0.55, 10]])) };
  const d = decide({ forecast: { p_yes: 0.70 }, market: mk(), books: b, portfolio: port() });
  assert.strictEqual(d.action, 'comprar'); assert.ok(Math.abs(d.stake_usd - 3) < 1e-9);
  const fino = { yes: parseBook(book([[0.48, 1]], [[0.50, 2]])), no: b.no }; // $1 disponible < minimo
  assert.strictEqual(decide({ forecast: { p_yes: 0.70 }, market: mk(), books: fino, portfolio: port() }).reason, 'profundidad_insuficiente');
  assert.ok(Math.abs(fillAsks([{ price: 0.5, size: 10 }, { price: 0.6, size: 100 }], 0.6, 10).usd - 10) < 1e-9);
});

test('topes por evento y total abierto', () => {
  setup();
  const p = { openUsd: 0, openByEvent: new Map([['E1', 2]]) };
  assert.strictEqual(decide({ forecast: { p_yes: 0.7 }, market: mk(), books: books(0.5, 0.5), portfolio: p }).reason, 'tope_por_evento');
  assert.strictEqual(decide({ forecast: { p_yes: 0.7 }, market: mk(), books: books(0.5, 0.5), portfolio: { openUsd: 99, openByEvent: new Map() } }).reason, 'tope_total_abierto');
  const parcial = decide({ forecast: { p_yes: 0.7 }, market: mk(), books: books(0.5, 0.5), portfolio: { openUsd: 95, openByEvent: new Map() } });
  assert.ok(Math.abs(parcial.stake_usd - 5) < 1e-9);
});

test('sin edge: omite con motivo', () => {
  setup();
  assert.strictEqual(decide({ forecast: { p_yes: 0.52 }, market: mk(), books: books(0.5, 0.5), portfolio: port() }).reason, 'edge_insuficiente');
});
