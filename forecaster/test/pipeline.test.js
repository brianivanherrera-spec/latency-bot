'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { mkMarket, mkEvent, book, setup, mockFetch } = require('./helpers');
const pipeline = require('../src/pipeline');
const { computeReport, bootstrapByEvent } = require('../src/metrics');
const server = require('../src/server');
const { readJsonl, appendJsonl, utcDate } = require('../src/util');

const FDIR = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'fc-forecasts-'));
process.env.FORECASTS_DIR = FDIR;

test('flujo completo: seleccion, pronostico, decision, resolucion y endpoints', async () => {
  const dir = setup({ MARKETS_PER_DAY: '3', DOWNLOAD_SECRET: 'sec' });
  const events = [mkEvent(1, ['politics'], [mkMarket(11, { price: 0.5, fees: true, feeSchedule: { rate: 0.0 } })]), mkEvent(2, ['economy'], [mkMarket(21)]), mkEvent(3, ['tech'], [mkMarket(31)])];
  let resolved = false;
  mockFetch([
    ['/events', events],
    ['/book?token_id=y', book([[0.48, 500]], [[0.50, 500]])],
    ['/book?token_id=n', book([[0.48, 500]], [[0.50, 500]])],
    ['/markets/11', () => ({ ...mkMarket(11), closed: resolved, outcomePrices: '["1","0"]' })],
    ['/markets/', () => ({ ...mkMarket(0), closed: false })],
  ]);
  const date = utcDate();
  const picked = await pipeline.runSelection(date);
  assert.strictEqual(picked.length, 3);
  assert.strictEqual((await pipeline.runSelection(date)).length, 0); // idempotente
  assert.strictEqual(readJsonl('books.jsonl').length, 3);

  const file = path.join(FDIR, `${date}.json`);
  fs.writeFileSync(file, JSON.stringify([
    { market_id: '11', p_yes: 0.8, confidence: 'high', reasoning: 'x', key_uncertainties: [], sources: [], prompt_version: 'v1' },
    { market_id: '21', p_yes: 0.51, confidence: 'low', reasoning: 'y', prompt_version: 'v1' },
    { market_id: '999', p_yes: 0.9 },
  ]));
  try {
    assert.strictEqual(await pipeline.ingestForecasts(), 2);
    assert.strictEqual(await pipeline.ingestForecasts(), 0);
    const dec = readJsonl('decisions.jsonl');
    assert.strictEqual(dec.find((d) => d.market_id === '11').action, 'comprar');
    assert.strictEqual(dec.find((d) => d.market_id === '21').reason, 'edge_insuficiente');

    const res = { headers: {}, writeHead(c) { this.code = c; }, end(b) { this.body = JSON.parse(b); } };
    const call = (u) => { server.handler({ url: u }, res); return res; };
    assert.strictEqual(call('/health').code, 200);
    assert.strictEqual(call('/report').code, 401);
    assert.strictEqual(call('/candidates?key=mal').code, 401);
    const c = call('/candidates?key=sec');
    assert.strictEqual(c.body.markets.length, 3);
    assert.ok(!/outcomePrices|price|liquid/i.test(JSON.stringify(c.body)));
    assert.strictEqual(call('/forecasts?key=sec').body.forecasts.length, 2);
    assert.strictEqual(call('/report?key=sec').body.conclusion.startsWith('sin muestra suficiente'), true);

    // resoluciones: no cierra hasta closed=true
    assert.strictEqual(await pipeline.checkResolutions(), 0);
    resolved = true;
    assert.strictEqual(await pipeline.checkResolutions(), 1);
    assert.strictEqual(readJsonl('resolutions.jsonl')[0].outcome_yes, 1);
    const rep = computeReport(pipeline.loadState());
    assert.strictEqual(rep.resueltos, 1);
    assert.ok(rep.pnl_hipotetico.total.pnl > 0); // compro Si a 0.5, gano
    assert.ok(Math.abs(rep.pnl_hipotetico.total.pnl - 10) < 1e-6);

    // snapshots a 24h
    const n = await pipeline.takeSnapshots(Date.now() + 25 * 36e5);
    assert.ok(n >= 1);
  } finally { fs.rmSync(file, { force: true }); }
});

test('subir MARKETS_PER_DAY completa la seleccion del dia sin repetir', async () => {
  setup({ MARKETS_PER_DAY: '1' });
  const mk = (n, tag) => mkEvent(n, [tag], [mkMarket(n * 10 + 1)]);
  mockFetch([['/events', [mk(1, 'politics'), mk(2, 'economy'), mk(3, 'tech')]], ['/book', book([[0.48, 5]], [[0.5, 5]])]]);
  const date = utcDate();
  assert.strictEqual((await pipeline.runSelection(date)).length, 1);
  process.env.MARKETS_PER_DAY = '3';
  const more = await pipeline.runSelection(date);
  assert.strictEqual(more.length, 2);
  assert.strictEqual(new Set(readJsonl('candidates.jsonl').map((r) => r.market.market_id)).size, 3);
  assert.strictEqual((await pipeline.runSelection(date)).length, 0);
});

test('disputados/anulados no se registran como resolucion', async () => {
  setup();
  mockFetch([['/markets/5', () => ({ ...mkMarket(5), closed: true, outcomePrices: '["0.5","0.5"]' })]]);
  appendJsonl('forecasts.jsonl', { ts: new Date().toISOString(), key: 'd:5', market_id: '5', event_id: 'e', p_yes: 0.5, mid_yes: 0.5 });
  assert.strictEqual(await pipeline.checkResolutions(), 0);
});

test('estado se reconstruye desde los jsonl (tope abierto)', () => {
  setup();
  appendJsonl('decisions.jsonl', { action: 'comprar', market_id: 'a', event_id: 'E', stake_usd: 10 });
  appendJsonl('decisions.jsonl', { action: 'comprar', market_id: 'b', event_id: 'E', stake_usd: 10 });
  appendJsonl('decisions.jsonl', { action: 'omitir', market_id: 'c', event_id: 'E' });
  appendJsonl('resolutions.jsonl', { market_id: 'b', outcome_yes: 1 });
  const st = pipeline.loadState();
  assert.strictEqual(st.portfolio.openUsd, 10);
  assert.strictEqual(st.portfolio.openByEvent.get('E'), 1);
});

test('metricas: Brier, bootstrap por evento y conclusion con >= 50', () => {
  setup();
  const forecasts = [], resolutions = [];
  for (let i = 0; i < 60; i++) {
    const y = i % 2;
    forecasts.push({ ts: '2026-01-01T00:00:00Z', key: 'k' + i, market_id: 'm' + i, event_id: 'e' + (i % 30), p_yes: y ? 0.8 : 0.2, mid_yes: 0.5, category: 'politica', end_date: '2026-02-01', confidence: 'high' });
    resolutions.push({ market_id: 'm' + i, outcome_yes: y });
  }
  const rep = computeReport({ forecasts, resolutions, decisions: [], snapshots: [] });
  assert.ok(Math.abs(rep.scores.pronostico.brier - 0.04) < 1e-9);
  assert.ok(Math.abs(rep.scores.mercado.brier - 0.25) < 1e-9);
  assert.ok(rep.brier_dif_vs_mercado.hi < 0);
  assert.ok(!rep.conclusion.startsWith('sin muestra'));
  assert.strictEqual(rep.criterio_dinero_real.resueltos_100, false);
  const bs = bootstrapByEvent([{ event: 'a', d: 1 }, { event: 'a', d: 1 }, { event: 'b', d: -1 }]);
  assert.strictEqual(bs.events, 2);
});

test('resolucionLines: resultado y pago de cada posicion', () => {
  const { resolucionLines } = require('../src/pipeline');
  const decs = [
    { action: 'comprar', market_id: 'a', side: 'NO', stake_usd: 10, shares: 20, fee_usd: 0.25 },
    { action: 'comprar', market_id: 'a', side: 'SI', stake_usd: 10, shares: 40, fee_usd: 0 },
    { action: 'omitir', market_id: 'a' },
    { action: 'comprar', market_id: 'b', side: 'SI', stake_usd: 10, shares: 40, fee_usd: 0 },
  ];
  const l = resolucionLines('a', 'Pregunta?', 0, decs);
  assert.equal(l.length, 3);
  assert.match(l[0], /resultado=NO Pregunta\?/);
  assert.match(l[1], /NO GANO gastado=\$10.00 pnl=\+\$9.75/);
  assert.match(l[2], /SI PERDIO gastado=\$10.00 pnl=-\$10.00/);
});
