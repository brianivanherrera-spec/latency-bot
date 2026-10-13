/**
 * Sombra de otra serie (src/series-shadow.js, BTC 15 min) y el modelo TWAP puro (twapFairUp, src/fair-value.js):
 * descubrimiento en Gamma, libro REST cada segundo, strike que llega tarde, ganador oficial, archivo que lee el
 * backtest y resumen con la regla de B.
 * Uso: node test/series-shadow.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { twapFairUp, normCdf } = require('../src/fair-value');
const { SeriesShadow, COLS } = require('../src/series-shadow');
const { load, firstFire } = require('../scripts/backtest');

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
  // 1) Modelo TWAP: con T ≥ W la media es P y Var = σp²·(T − 2W/3); con T < W se mezcla lo ya promediado
  const sp = 50e-6 * 100000;
  near(twapFairUp(100000, 100000, 300, 60, 50e-6).p, 0.5);
  const a = twapFairUp(100050, 100000, 300, 60, 50e-6);
  near(a.mean, 100050);
  near(a.sd, 50e-6 * 100050 * Math.sqrt(300 - 40));
  near(a.p, normCdf(50 / a.sd));
  const b = twapFairUp(100000, 99990, 30, 60, 50e-6, 99980);
  near(b.mean, (30 * 99980 + 30 * 100000) / 60);
  near(b.sd, sp * Math.sqrt(30 ** 3 / (3 * 3600)));
  near(twapFairUp(100000, 99990, 30, 60, 50e-6).mean, 100000, 1e-9);
  assert.deepStrictEqual([twapFairUp(100000, 99999, 0, 60, 50e-6, 100000).p, twapFairUp(100000, 100001, 0, 60, 50e-6, 100000).p], [1, 0], 'sin tiempo: según la media');

  // 2) Sombra de BTC 15 min con reloj y API falsos
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serie-'));
  const P = 900000, S0 = Math.floor(Date.UTC(2026, 9, 12, 15, 0, 0) / P) * P; // apertura de un mercado de 15 min
  let clock = S0 + 1000;
  const gamma = new Map(); // slug → { outcomes, closed, prices }
  const slug = ts => `btc-updown-15m-${ts / 1000}`;
  gamma.set(slug(S0), { outcomes: '["Up", "Down"]', ids: '["U1", "D1"]', closed: false, prices: '["0.5", "0.5"]' });
  const book = { U1: [0.49, 0.50], D1: [0.50, 0.51], U2: [0.30, 0.31], D2: [0.69, 0.70] };
  let bookCalls = 0;
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/events') {
      const g = gamma.get(u.searchParams.get('slug'));
      const ev = g ? [{ title: 'Bitcoin Up or Down - October 12, 11:00AM-11:15AM ET',
        markets: [{ clobTokenIds: g.ids, outcomes: g.outcomes, closed: g.closed, outcomePrices: g.prices }] }] : [];
      return { ok: true, json: async () => ev };
    }
    if (u.pathname === '/book') {
      bookCalls++;
      const [bid, ask] = book[u.searchParams.get('token_id')];
      return { ok: true, json: async () => ({ timestamp: String(Date.now()), bids: [{ price: String(bid), size: '100' }], asks: [{ price: String(ask), size: '100' }] }) };
    }
    throw new Error(`url inesperada ${url}`);
  };
  let strike = null, pNow = 0.5;
  const s = new SeriesShadow({ fetchFn, dataDir: dir, now: () => clock, resolveDelayMs: 0, resolveEveryMs: 0, resolveTries: 3,
    strikeFn: ms => (ms === S0 ? strike : null), fairFn: (K, endMs, now) => ({ p: pNow, sigma: 70e-6, sigmaShort: 50e-6, sigmaLong: 50e-6 }),
    spotFn: () => 100090 });
  const step = async () => { s._tick(); await s.cur.done; };
  // Primer segundo: busca el mercado en Gamma (todavía sin muestra)
  await step();
  assert.deepStrictEqual(s.cur.tokens, { yes: 'U1', no: 'D1' });
  assert.strictEqual(s.cur.rows.length, 0);
  assert.strictEqual(s.cur.partial, false);
  // Segundos 2-899: el strike llega en el segundo 3; a 100 s del cierre el modelo sube a 0.65 con el libro quieto
  for (let t = 2; t < 900; t++) {
    clock = S0 + t * 1000;
    if (t === 3) strike = 100000;
    if (t === 800) pNow = 0.65;
    await step();
  }
  const m = s.cur;
  assert.strictEqual(m.rows.length, 898, 'una muestra por segundo');
  assert.strictEqual(bookCalls, 898 * 2, 'libro de Sí y de No por REST');
  assert.strictEqual(m.strike, 100000);
  const r0 = m.rows[0], r1 = m.rows[1];
  assert.deepStrictEqual([r0[0], r0[1], r0[2], r0[3], r0[10]], [2, 898, 100090, null, null], 'sin strike todavía: sin modelo');
  assert.deepStrictEqual([r1[0], r1[3], r1[4], r1[5], r1[6], r1[7], r1[8], r1[10], r1[11], r1[12]], [3, 0.5, 0.49, 0.50, 0.50, 0.51, 70, 1, 50, 50]);
  // Siguiente mercado: el anterior queda esperando a Gamma; cuando cierra con Up en 1 se escribe
  gamma.set(slug(S0 + P), { outcomes: '["Down", "Up"]', ids: '["D2", "U2"]', closed: false, prices: '["0.5", "0.5"]' });
  clock = S0 + P + 500;
  await step();
  assert.ok(m.closed && s.pending.has(m));
  assert.deepStrictEqual(s.cur.tokens, { yes: 'U2', no: 'D2' }, 'con "Down" primero el Sí es el segundo token');
  await tick(); await m.done;           // 1er intento: Gamma todavía sin cerrar
  gamma.get(slug(S0)).closed = true;
  gamma.get(slug(S0)).prices = '["1", "0"]';
  await tick(); await m.done;
  assert.ok(!s.pending.has(m));
  assert.deepStrictEqual([s.stats.written, s.stats.unresolved], [1, 0]);
  await new Promise(r => setTimeout(r, 30)); // escritura en segundo plano
  const file = path.join(dir, 'shadow-ticks-btc15m.jsonl');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepStrictEqual([rec.series, rec.winner, rec.winner_source, rec.strike, rec.start_ts, rec.end_ts, rec.samples],
    ['btc15m', 'UP', 'gamma', 100000, S0, S0 + P, 898]);
  assert.deepStrictEqual(rec.cols, COLS);
  // El backtest lo lee igual que shadow-ticks.jsonl: la regla de B entra a 100 s comprando UP a $0.50
  const M = await load(file);
  assert.strictEqual(M.length, 1);
  const f = firstFire(M[0], { kind: 'anchored', e: 0.08, lo: 0.30, hi: 0.70, tMax: 120, tMin: 30 });
  assert.deepStrictEqual([f.side, f.ask, M[0].rows[f.i].sl], ['UP', 0.50, 100]);
  const b1 = s.bRule(m, 'UP');
  assert.deepStrictEqual([b1.fire, b1.side, b1.ask, b1.sl, b1.win], [true, 'UP', 0.50, 100, true]);
  near(b1.edge, 0.495 + 0.15 - 0.50 - 0.072 * 0.25, 1e-9);
  const sum = s.summary(m, 'UP');
  assert.ok(sum.includes('Oct 12, 11:00AM-11:15AM ET | ganó UP | strike $100000.00 | 898 muestras (897 con modelo; REST p50 0 ms, sin respuesta 0 de 1796)'), sum);
  assert.ok(sum.includes('spread medio de Sí 1.0¢ | regla de B: UP a $0.50 con 12.7 pts a 100 s → gana'), sum);
  // Sin ganador oficial después de los reintentos: no se escribe
  const m2 = s.cur;
  for (let t = 1; t < 5; t++) { clock = S0 + P + t * 1000; await step(); }
  clock = S0 + 2 * P + 100;
  await step();                          // abre el tercero (no está en Gamma) y cierra el segundo
  for (let i = 0; i < 3; i++) { await tick(); await m2.done; }
  assert.deepStrictEqual([s.stats.written, s.stats.unresolved, s.pending.size], [1, 1, 0]);
  assert.strictEqual(s.bRule(m2, null).fire, false);
  assert.ok(s.summary(m2, null).includes('ganó sin dato de Gamma'));
  assert.strictEqual(s.cur.discoverErr, 'no está en Gamma');
  // Arranque a mitad de un mercado: queda marcado como parcial
  const s2 = new SeriesShadow({ fetchFn, dataDir: dir, now: () => S0 + 60000, strikeFn: () => null, fairFn: () => null });
  s2._tick();
  await s2.cur.done;
  assert.strictEqual(s2.cur.partial, true);
  // Mientras el pedido REST anterior no volvió, el segundo se saltea
  s2._tick();
  const pend = s2.cur.done;
  s2._tick();
  await pend;
  assert.deepStrictEqual([s2.cur.skipped, s2.cur.rows.length], [1, 1]);
  // Pedidos REST con error: se cuentan por código en la línea del mercado (429 = demasiados pedidos)
  const fetch429 = async (url) => (new URL(url).pathname === '/book' ? { ok: false, status: 429 } : fetchFn(url));
  const s3 = new SeriesShadow({ fetchFn: fetch429, dataDir: dir, now: () => S0 + 2000, strikeFn: () => null, fairFn: () => null });
  s3._tick(); await s3.cur.done;        // busca el mercado
  s3._tick(); await s3.cur.done;        // una muestra: los dos libros dan 429
  assert.deepStrictEqual([s3.cur.restReq, s3.cur.restFail, s3.cur.restCodes['429']], [2, 2, 2]);
  assert.ok(s3.summary(s3.cur, null).includes('1 muestras (0 con modelo; REST p50 0 ms, sin respuesta 2 de 2 [429: 2])'), s3.summary(s3.cur, null));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('series-shadow: 36 ok');
})().catch(e => { console.error(e); process.exit(1); });
