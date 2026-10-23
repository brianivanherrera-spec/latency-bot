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
const { SeriesShadow, COLS, gammaPriceToBeat, hourlySlugs } = require('../src/series-shadow');
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
  const s = new SeriesShadow({ fetchFn, dataDir: dir, now: () => clock, resolveDelayMs: 0, resolveEveryMs: 0, resolveTries: 3, ptbTries: 0,
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
  // 3) Sombra de ETH 5 min: slug y período propios; al resolver guarda el priceToBeat de Gamma (si todavía no está,
  //    espera unos intentos más solo por él) y lo muestra con la diferencia contra el strike
  assert.deepStrictEqual([gammaPriceToBeat({ eventMetadata: '{"priceToBeat":3999.37,"x":1}' }), gammaPriceToBeat({ eventMetadata: { priceToBeat: '83497.33' } }),
    gammaPriceToBeat({ eventMetadata: null }), gammaPriceToBeat({}), gammaPriceToBeat(null), gammaPriceToBeat({ eventMetadata: '{"priceToBeat":0}' })],
    [3999.37, 83497.33, null, null, null, null]);
  const E = 300000, E0 = Math.floor(S0 / E) * E;
  const gammaE = new Map();
  const fetchE = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/events') {
      const g = gammaE.get(u.searchParams.get('slug'));
      const ev = g ? [{ title: 'Ethereum Up or Down - October 12, 11:00AM-11:05AM ET', eventMetadata: g.meta,
        markets: [{ clobTokenIds: '["EU", "ED"]', outcomes: '["Up", "Down"]', closed: g.closed, outcomePrices: g.prices }] }] : [];
      return { ok: true, json: async () => ev };
    }
    if (u.pathname === '/book') return { ok: true, json: async () => ({ bids: [{ price: '0.49', size: '10' }], asks: [{ price: '0.51', size: '10' }] }) };
    throw new Error(`url inesperada ${url}`);
  };
  let ce = E0 + 1000;
  const se = new SeriesShadow({ id: 'eth5m', slugPrefix: 'eth-updown-5m', periodS: 300, fetchFn: fetchE, dataDir: dir, now: () => ce,
    resolveDelayMs: 0, resolveEveryMs: 0, resolveTries: 3, ptbTries: 2, strikeFn: () => 3999.5, fairFn: () => ({ p: 0.5, sigma: 1e-4 }),
    spotFn: () => 4000 });
  gammaE.set(`eth-updown-5m-${E0 / 1000}`, { closed: false, prices: '["0.5", "0.5"]', meta: null });
  se._tick(); await se.cur.done;          // busca el mercado
  for (let t = 2; t < 10; t++) { ce = E0 + t * 1000; se._tick(); await se.cur.done; }
  const me = se.cur;
  assert.deepStrictEqual([me.slug, me.endTs - me.startTs, me.rows.length, me.tokens], [`eth-updown-5m-${E0 / 1000}`, E, 8, { yes: 'EU', no: 'ED' }]);
  ce = E0 + E + 100;
  se._tick();                             // cierra; el siguiente no está en Gamma
  const g0 = gammaE.get(me.slug);
  g0.closed = true; g0.prices = '["0", "1"]';
  await tick(); await me.done;            // ganador sin priceToBeat todavía: espera
  assert.ok(se.pending.has(me), 'espera el priceToBeat');
  g0.meta = '{"priceToBeat":3999.37}';
  await tick(); await me.done;
  assert.ok(!se.pending.has(me));
  assert.strictEqual(me.ptb, 3999.37);
  const sumE = se.summary(me, 'DOWN');
  assert.ok(sumE.includes('ganó DOWN | strike $3999.50 (priceToBeat $3999.37, Δ +$0.13) | 8 muestras (8 con modelo;'), sumE);
  await new Promise(r => setTimeout(r, 30)); // escritura en segundo plano
  const recE = JSON.parse(fs.readFileSync(path.join(dir, 'shadow-ticks-eth5m.jsonl'), 'utf8').trim());
  assert.deepStrictEqual([recE.series, recE.winner, recE.strike, recE.price_to_beat, recE.samples], ['eth5m', 'DOWN', 3999.5, 3999.37, 8]);
  // Si Gamma no lo publica en los intentos extra se escribe igual, sin el dato
  const me2 = se.cur;
  gammaE.set(me2.slug, { closed: false, prices: '["0.5", "0.5"]', meta: null });
  for (let t = 1; t < 10; t++) { ce = E0 + E + t * 1000; se._tick(); await se.cur.done; } // lo vuelve a buscar a los 5 s
  ce = E0 + 2 * E + 100;
  se._tick();
  const g1 = gammaE.get(me2.slug);
  g1.closed = true; g1.prices = '["1", "0"]';
  for (let i = 0; i < 3; i++) { await tick(); await me2.done; }
  assert.ok(!se.pending.has(me2));
  assert.deepStrictEqual([me2.ptb, me2.rows.length, se.stats.written], [undefined, 3, 2]);
  assert.ok(se.summary(me2, 'UP').includes('ganó UP | strike $3999.50 |'), se.summary(me2, 'UP'));
  // 4) Cuenta B15 (paper): la regla de B en vivo (una entrada por mercado), orden al límite justo y fill con el REST
  //    a +checkMs; WIN/LOSS con el ganador oficial; estado en disco y posiciones abiertas que se resuelven al arrancar
  const dirP = fs.mkdtempSync(path.join(os.tmpdir(), 'b15-'));
  const Q0 = S0 + 10 * P;
  let cq = Q0 + 1000, pq = 0.5;
  const gq = new Map(), bq = { QU: [0.49, 0.50], QD: [0.50, 0.51] };
  const fetchQ = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/events') {
      const g = gq.get(u.searchParams.get('slug'));
      const ev = g ? [{ title: 'Bitcoin Up or Down - October 12, 1:30PM-1:45PM ET',
        markets: [{ clobTokenIds: '["QU", "QD"]', outcomes: '["Up", "Down"]', closed: g.closed, outcomePrices: g.prices }] }] : [];
      return { ok: true, json: async () => ev };
    }
    if (u.pathname === '/book') {
      const [bid, ask] = bq[u.searchParams.get('token_id')];
      return { ok: true, json: async () => ({ bids: [{ price: String(bid), size: '100' }], asks: [{ price: String(ask), size: '100' }] }) };
    }
    throw new Error(`url inesperada ${url}`);
  };
  const mkQ = d => new SeriesShadow({ fetchFn: fetchQ, dataDir: d, now: () => cq, resolveDelayMs: 0, resolveEveryMs: 0, resolveTries: 3,
    ptbTries: 0, env: { PAPER_CHECK_MS: '0' }, paper: true, strikeFn: () => 100000, fairFn: () => ({ p: pq, sigma: 70e-6 }) });
  const sq = mkQ(dirP);
  const stepQ = async () => { sq._tick(); await sq.cur.done; };
  // Un mercado entero: el modelo sube a 0.65 a 100 s del cierre; onFire(m) corre antes del chequeo a +checkMs
  const runQ = async (start, onFire) => {
    gq.set(slug(start), { closed: false, prices: '["0.5", "0.5"]' });
    pq = 0.5;
    for (let t = 1; t < 900; t++) {
      cq = start + t * 1000;
      if (t === 800) pq = 0.65;
      await stepQ();
      if (t === 800) { onFire?.(sq.cur); await tick(); await sq.cur.b15.done; }
    }
    return sq.cur;
  };
  const q1 = await runQ(Q0);
  assert.deepStrictEqual([q1.b15.side, q1.b15.ask, q1.b15.limit, q1.b15.size, q1.b15.ask200, q1.b15.filled, q1.b15.paid, q1.b15.sl],
    ['UP', 0.50, 0.60, 8, 0.50, true, 0.5, 100], 'entra UP a $0.50, límite justo $0.60 (0.645 − 2 pts − comisión), 8 acciones, llena a +0 ms');
  assert.deepStrictEqual([sq.paper.st.attempts, sq.paper.st.filled, sq.paper.st.open.length], [1, 1, 1], 'una sola entrada por mercado');
  // Cierra con Up en 1: WIN de 8 × (1 − 0.50) − comisión 0.072·0.5·0.5·8
  gq.set(slug(Q0 + P), { closed: false, prices: '["0.5", "0.5"]' });
  cq = Q0 + P + 500;
  await stepQ();
  gq.get(slug(Q0)).closed = true; gq.get(slug(Q0)).prices = '["1", "0"]';
  await tick(); await q1.done;
  await sq.paper.chain;
  near(sq.paper.st.pnl, 8 * 0.5 - 0.072 * 0.25 * 8, 1e-9);
  assert.deepStrictEqual([sq.paper.st.w, sq.paper.st.l, sq.paper.st.open.length], [1, 0, 0]);
  assert.ok(sq._paperBalance().startsWith('Balance B15: +$3.86 (1-0), intentos 1, llenadas 1, sin fill 0, abiertas 0'), sq._paperBalance());
  const saved = JSON.parse(fs.readFileSync(path.join(dirP, 'paper-b15-btc15m.json'), 'utf8'));
  assert.deepStrictEqual([saved.w, saved.filled, saved.open.length], [1, 1, 0], 'estado en disco');
  // Segundo mercado: a +checkMs el ask ya subió a $0.65 (arriba del límite $0.60) → no llena
  const q2 = await runQ(Q0 + P, () => { bq.QU = [0.64, 0.65]; });
  bq.QU = [0.49, 0.50];
  assert.deepStrictEqual([q2.b15.filled, q2.b15.ask200, sq.paper.st.attempts, sq.paper.st.noFill, sq.paper.st.open.length], [false, 0.65, 2, 1, 0]);
  // Reinicio con una posición abierta (DOWN a $0.40 × 12 en el primer mercado, que ganó Up): se resuelve sola → LOSS
  const dirR = fs.mkdtempSync(path.join(os.tmpdir(), 'b15r-'));
  fs.writeFileSync(path.join(dirR, 'paper-b15-btc15m.json'), JSON.stringify({ pnl: 0, w: 0, l: 0, attempts: 1, filled: 1, noFill: 0, unresolved: 0,
    open: [{ slug: slug(Q0), label: 'x', side: 'DOWN', paid: 0.4, size: 12, upIdx: 0, end: Q0 + P }], startedAt: Q0 }));
  const sr = mkQ(dirR), o = sr.paper.st.open[0];
  sr._paperResume();
  await tick(); await o.done;
  near(sr.paper.st.pnl, -12 * 0.4 - 0.072 * 0.4 * 0.6 * 12, 1e-4); // el balance se guarda con 4 decimales
  assert.deepStrictEqual([sr.paper.st.l, sr.paper.st.open.length], [1, 0]);
  // Sin el ganador después de los intentos: queda afuera del balance
  const dirU = fs.mkdtempSync(path.join(os.tmpdir(), 'b15u-'));
  fs.writeFileSync(path.join(dirU, 'paper-b15-btc15m.json'), JSON.stringify({ pnl: 1, w: 1, l: 0, attempts: 2, filled: 2, noFill: 0, unresolved: 0,
    open: [{ slug: 'btc-updown-15m-no-existe', label: 'y', side: 'UP', paid: 0.5, size: 10, upIdx: 0, end: Q0 }], startedAt: Q0 }));
  const su = mkQ(dirU), ou = su.paper.st.open[0];
  su._paperResume();
  for (let i = 0; i < 4; i++) { await tick(); await ou.done; }
  assert.deepStrictEqual([su.paper.st.unresolved, su.paper.st.pnl, su.paper.st.open.length], [1, 1, 0]);
  // Sin paper (por defecto) no hay cuenta B15
  assert.strictEqual(s.paper, null);
  // ETH 15 min (pedido del 19/10): su propia cuenta B15, con su archivo de estado y su slug
  const dirE15 = fs.mkdtempSync(path.join(os.tmpdir(), 'b15e-'));
  const se15 = new SeriesShadow({ id: 'eth15m', slugPrefix: 'eth-updown-15m', periodS: 900, fetchFn: fetchQ, dataDir: dirE15, now: () => Q0 + 1000,
    env: {}, paper: true, strikeFn: () => 4000, fairFn: () => null });
  se15._tick();
  assert.deepStrictEqual([path.basename(se15.paper.file), se15.cur.slug, se15.paper.st.attempts],
    ['paper-b15-eth15m.json', `eth-updown-15m-${Q0 / 1000}`, 0], 'cuenta B15 de ETH 15 min aparte de la de BTC');
  fs.rmSync(dirE15, { recursive: true, force: true });
  // 5) BTC horario (plan del 23/10): nombre del evento con la hora de Nueva York, el segundo candidato si el primero no
  //    está en Gamma, cuenta B1H aparte y ganador de respaldo con la vela de Binance si Gamma no lo publica
  assert.deepStrictEqual(hourlySlugs(Date.parse('2026-10-23T14:00:00Z')), ['bitcoin-up-or-down-october-23-10am-et', 'btc-updown-1h-1792764000']);
  assert.deepStrictEqual(hourlySlugs(Date.parse('2026-10-23T04:00:00Z'))[0], 'bitcoin-up-or-down-october-23-12am-et');
  assert.deepStrictEqual(hourlySlugs(Date.parse('2026-11-02T17:00:00Z'))[0], 'bitcoin-up-or-down-november-2-12pm-et', 'después del cambio de hora');
  const H = 3600000, H0 = Date.parse('2026-10-23T14:00:00Z'), dirH = fs.mkdtempSync(path.join(os.tmpdir(), 'b1h-'));
  const gh = new Map([[`btc-updown-1h-${H0 / 1000}`, { closed: false, prices: '["0.5", "0.5"]' }]]);
  const asked = [];
  const fetchH = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/events') {
      asked.push(u.searchParams.get('slug'));
      const g = gh.get(u.searchParams.get('slug'));
      return { ok: true, json: async () => (g ? [{ title: 'Bitcoin Up or Down - October 23, 10AM ET',
        markets: [{ clobTokenIds: '["HU", "HD"]', outcomes: '["Up", "Down"]', closed: g.closed, outcomePrices: g.prices, makerBaseFee: 0 }] }] : []) };
    }
    if (u.pathname === '/book') return { ok: true, json: async () => ({ bids: [{ price: '0.49', size: '100' }], asks: [{ price: '0.50', size: '100' }] }) };
    throw new Error(`url inesperada ${url}`);
  };
  let ch = H0 + 1000, fallbackCalls = 0;
  const sh = new SeriesShadow({ id: 'btc1h', periodS: 3600, slugFn: hourlySlugs, strikeSource: 'binance_1h_open', paperName: 'B1H', paper: true,
    fetchFn: fetchH, dataDir: dirH, now: () => ch, env: { PAPER_CHECK_MS: '0' }, resolveDelayMs: 0, resolveEveryMs: 0, resolveTries: 2, ptbTries: 0,
    strikeFn: () => 100000, fairFn: () => ({ p: 0.5, sigma: 70e-6 }), spotFn: () => 100010,
    winnerFn: async ({ startTs, endTs }) => { fallbackCalls++; assert.deepStrictEqual([startTs, endTs], [H0, H0 + H]); return 'DOWN'; } });
  sh._tick(); await sh.cur.done;
  const mh = sh.cur;
  assert.deepStrictEqual([mh.slug, mh.tokens, asked], [`btc-updown-1h-${H0 / 1000}`, { yes: 'HU', no: 'HD' },
    ['bitcoin-up-or-down-october-23-10am-et', `btc-updown-1h-${H0 / 1000}`]], 'se queda con el candidato que está en Gamma');
  assert.deepStrictEqual([path.basename(sh.paper.file), sh.ptag, sh._paperBalance().startsWith('Balance B1H: +$0.00 (0-0)')],
    ['paper-b1h-btc1h.json', '[PAPER-B1H]', true]);
  for (let t = 2; t < 6; t++) { ch = H0 + t * 1000; sh._tick(); await sh.cur.done; }
  // Cierra; Gamma nunca publica el ganador: después de los intentos, el de la vela de Binance
  ch = H0 + H + 100;
  sh._tick();
  for (let i = 0; i < 4; i++) { await tick(); await mh.done; }
  assert.strictEqual(fallbackCalls, 1);
  await new Promise(r => setTimeout(r, 30));
  const recH = JSON.parse(fs.readFileSync(path.join(dirH, 'shadow-ticks-btc1h.jsonl'), 'utf8').trim());
  assert.deepStrictEqual([recH.series, recH.slug, recH.winner, recH.winner_source, recH.strike_source, recH.end_ts - recH.start_ts, recH.samples],
    ['btc1h', `btc-updown-1h-${H0 / 1000}`, 'DOWN', 'binance_kline', 'binance_1h_open', H, 4]); // el primer segundo busca el mercado
  // Posición abierta de B1H al reiniciar, sin ganador en Gamma: también se resuelve con la vela
  const dirH2 = fs.mkdtempSync(path.join(os.tmpdir(), 'b1hr-'));
  fs.writeFileSync(path.join(dirH2, 'paper-b1h-btc1h.json'), JSON.stringify({ pnl: 0, w: 0, l: 0, attempts: 1, filled: 1, noFill: 0, unresolved: 0,
    open: [{ slug: 'bitcoin-up-or-down-october-23-10am-et', label: 'z', side: 'DOWN', paid: 0.45, size: 11, upIdx: 0, start: H0, end: H0 + H }], startedAt: H0 }));
  const shr = new SeriesShadow({ id: 'btc1h', periodS: 3600, slugFn: hourlySlugs, paperName: 'B1H', paper: true, fetchFn: fetchH, dataDir: dirH2,
    now: () => H0 + H + 1000, env: {}, resolveDelayMs: 0, resolveEveryMs: 0, resolveTries: 2, strikeFn: () => null, fairFn: () => null,
    winnerFn: async () => 'DOWN' });
  const oh = shr.paper.st.open[0];
  shr._paperResume();
  for (let i = 0; i < 4; i++) { await tick(); await oh.done; }
  near(shr.paper.st.pnl, 11 * 0.55 - 0.072 * 0.45 * 0.55 * 11, 1e-4);
  assert.deepStrictEqual([shr.paper.st.w, shr.paper.st.open.length], [1, 0]);
  for (const d of [dirH, dirH2]) fs.rmSync(d, { recursive: true, force: true });
  for (const d of [dirP, dirR, dirU]) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('series-shadow: 70 ok');
})().catch(e => { console.error(e); process.exit(1); });
