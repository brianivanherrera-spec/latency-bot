'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mkMarket, mkEvent, setup, iso } = require('./helpers');
const gamma = require('../src/gamma');

test('seleccion: filtros de liquidez, precio, plazo, deportes y cripto', () => {
  setup();
  const ev = [
    mkEvent(1, ['politics'], [mkMarket(1), mkMarket(2, { liq: 100 }), mkMarket(3, { price: 0.01 }), mkMarket(4, { endDate: iso(1) }), mkMarket(5, { endDate: iso(90) })]),
    mkEvent(2, ['sports'], [mkMarket(6)]),
    mkEvent(3, ['crypto'], [mkMarket(7)]),
    mkEvent(4, ['economy'], [mkMarket(8, { question: 'Bitcoin Up or Down - 5 min?' }), mkMarket(9)]),
    mkEvent(5, ['otracosa'], [mkMarket(10)]),
  ];
  const ids = gamma.selectMarkets(ev).map((m) => m.market_id).sort();
  assert.deepStrictEqual(ids, ['1', '9']);
});

test('seleccion: reparto por categoria, tope por evento y MARKETS_PER_DAY', () => {
  setup({ MARKETS_PER_DAY: '4' });
  const mk = (n, tag) => mkEvent(n, [tag], [mkMarket(n * 10 + 1), mkMarket(n * 10 + 2), mkMarket(n * 10 + 3)]);
  const sel = gamma.selectMarkets([mk(1, 'politics'), mk(2, 'economy'), mk(3, 'tech'), mk(4, 'world')]);
  assert.strictEqual(sel.length, 4);
  assert.strictEqual(new Set(sel.map((m) => m.category)).size, 4);
  setup({ MARKETS_PER_DAY: '10' });
  const sel2 = gamma.selectMarkets([mk(1, 'politics')]);
  assert.strictEqual(sel2.length, 2); // max 2 por evento al seleccionar
});

test('seleccion: re-pronostico solo si el precio se movio >= 10 pts', () => {
  setup();
  const ev = [mkEvent(1, ['politics'], [mkMarket(1, { price: 0.5 }), mkMarket(2, { price: 0.5 })])];
  const prev = new Map([['1', 0.45], ['2', 0.35]]);
  assert.deepStrictEqual(gamma.selectMarkets(ev, prev).map((m) => m.market_id), ['2']);
});

test('lista publicada sin precios, liquidez ni libro', () => {
  setup();
  const m = gamma.selectMarkets([mkEvent(1, ['politics'], [mkMarket(1, { price: 0.37 })])])[0];
  const pub = gamma.publicCandidate(m);
  assert.deepStrictEqual(Object.keys(pub).sort(), ['category', 'description', 'end_date', 'event_id', 'event_title', 'market_id', 'question', 'resolution_source']);
  assert.ok(!/0\.37|price|liquid|bid|ask/i.test(JSON.stringify(pub)));
});
