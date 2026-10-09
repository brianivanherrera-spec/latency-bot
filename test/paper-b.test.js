/**
 * Paper B (src/paper-b.js): regla anclada, ejecución simulada, resolución y estado persistente.
 * Uso: node test/paper-b.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaperB } = require('../src/paper-b');

const FEE = 0.072;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-b-'));
const stateFile = path.join(dir, 'paper-b.json');
const env = { PAPER_B_DELAY_MS: '20', PAPER_CHECK_MS: '10', ORDER_LIMIT_BUFFER: '0.02', TAKER_FEE_RATE: String(FEE) };

// Libro falso: ask por token, con tamaño de sobra
const book = { Y: 0.45, N: 0.56 };
const polyWs = {
  getBestAskForToken: t => book[t] ?? null,
  getAskSizeUpTo: (t, lim) => (book[t] != null && book[t] <= lim + 1e-9 ? 100 : 0),
  getAskVwapUpTo: (t, lim, size) => (book[t] != null && book[t] <= lim + 1e-9 ? { vwap: book[t], filled: size } : { vwap: null, filled: 0 }),
};
// API falsa: /book devuelve el libro falso (100 acciones en el ask; `rest` lo pisa para simular un WS
// atrasado) y /markets/ el resultado de Gamma
const rest = {};
const fakeFetch = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/book') {
    const tok = u.searchParams.get('token_id');
    const a = rest[tok] ?? book[tok];
    return { ok: true, json: async () => ({ timestamp: String(Date.now() - 20), bids: [], asks: a == null ? [] : [{ price: String(a), size: '100' }] }) };
  }
  return { ok: true, json: async () => ({ closed: true, outcomePrices: '["0", "1"]' }) };
};
const mkt = (id, endTs = Date.now() + 100_000) => ({ gammaId: id, yesTokenId: 'Y', noTokenId: 'N', endTs, question: `mercado ${id}` });
const sample = (T, p, yesAsk = 0.45, yesBid = 0.44, noAsk = 0.56) => ({ T, yesBid, yesAsk, noAsk, p, src: 1 });

(async () => {
  const pb = new PaperB({ polyWs, stateFile, env, fetchFn: fakeFetch });
  assert.ok(fs.existsSync(stateFile), 'estado guardado desde el arranque ("desde" no se reinicia)');
  // 1) Fuera de ventana (150 s): fija el ancla (mid 0.445, p 0.50) y no entra
  const m1 = mkt('g1');
  pb.onSample(m1, sample(150, 0.50));
  assert.strictEqual(pb.state.attempts, 0, 'fuera de ventana no entra');
  // 2) En ventana, mismo mid, el modelo subió 15 pts → pAdj 0.595; UP: 0.595 − 0.45 − comisión ≥ 0.08
  pb.onSample(m1, sample(100, 0.65));
  await pb.markets.get('g1').done;
  assert.strictEqual(pb.state.attempts, 1);
  assert.strictEqual(pb.state.filled, 1);
  const pos = pb.state.open[0];
  assert.strictEqual(pos.side, 'UP');
  assert.strictEqual(pos.limit, 0.47, 'límite = ask + 2¢');
  assert.strictEqual(pos.size, 10, 'floor(5 / 0.47)');
  assert.strictEqual(pos.paid, 0.46, 'paga ask al decidir + tick (el libro está a 0.45)');
  assert.strictEqual(pos.fill200, true);
  assert.strictEqual(pos.restAsk0, 0.45, 'libro REST al decidir');
  assert.strictEqual(pos.restFill, true, 'con el REST también llenaba');
  assert.deepStrictEqual([pos.restAsk200, pos.restFill200, pos.restPaid200], [0.45, true, 0.46], 'libro REST a +200 ms');
  // 3) Un solo intento por mercado
  pb.onSample(m1, sample(90, 0.70));
  assert.strictEqual(pb.state.attempts, 1, 'no reintenta en el mismo mercado');
  // 4) Resolución oficial: gana UP
  pb.onResolved('g1', 'UP', 'btc_binance');
  assert.strictEqual(pb.state.open.length, 1, 'solo resuelve con Gamma');
  pb.onResolved('g1', 'UP', 'gamma');
  const expWin = 10 * (1 - 0.46) - FEE * 0.46 * 0.54 * 10;
  assert.strictEqual(pb.state.w, 1);
  assert.ok(Math.abs(pb.state.pnl - expWin) < 1e-3, `P&L ${pb.state.pnl} ≈ ${expWin}`);
  assert.strictEqual(pb.state.open.length, 0);
  assert.deepStrictEqual([pb.state.rest200.n, pb.state.rest200.w, pb.state.rest200.no], [1, 1, 0], 'cuenta con el REST a +200 ms');

  // 5) Sin fill: el ask se escapa antes de los 400 ms (pero a los 200 ms todavía llenaba)
  const m2 = mkt('g2');
  book.Y = 0.45;
  pb.onSample(m2, sample(150, 0.50));
  pb.onSample(m2, sample(100, 0.65));
  setTimeout(() => { book.Y = 0.60; }, 15); // entre el registro de 10 ms y el fill de 20 ms
  await pb.markets.get('g2').done;
  assert.strictEqual(pb.state.noFill, 1);
  assert.strictEqual(pb.state.fill200, 2, 'las dos llenaban a +200 ms');
  assert.strictEqual(pb.state.only200.length, 1, 'una llenaba solo a +200 ms');
  assert.strictEqual(pb.state.only200[0].restAsk400, 0.60, 'libro REST al momento del fill');
  assert.strictEqual(pb.state.only200[0].restFill, false, 'con el REST tampoco llenaba');
  assert.deepStrictEqual([pb.state.only200[0].restAsk200, pb.state.only200[0].restFill200], [0.45, true], 'el REST a +200 ms todavía llenaba');
  assert.strictEqual(pb.state.rest200Open.length, 1, 'cuenta solo en la del REST a +200 ms');
  pb.onResolved('g2', 'UP', 'gamma');
  assert.strictEqual(pb.state.only200[0].winner, 'UP', 'se guarda cómo salió la que solo llenaba a 200 ms');
  assert.deepStrictEqual([pb.state.rest200.n, pb.state.rest200.w, pb.state.rest200.only, pb.state.rest200Open.length], [2, 2, 1, 0]);
  assert.ok(Math.abs(pb.state.rest200.pnl - 2 * expWin) < 1e-3, 'al precio del REST a +200 ms');
  assert.strictEqual(pb.state.pnl, +expWin.toFixed(4), 'el P&L de B no cambia');

  // 6) DOWN: el modelo baja → pAdj baja; el ancla se reinicia si falta el libro
  book.Y = 0.45; book.N = 0.56;
  const m3 = mkt('g3');
  pb.onSample(m3, sample(150, 0.50));
  pb.onSample(m3, { ...sample(110, 0.30), yesBid: null }); // sin libro: ancla reiniciada, no entra
  assert.strictEqual(pb.state.attempts, 2);
  pb.onSample(m3, sample(105, 0.30));        // ancla nueva con p 0.30 → pAdj = mid → sin ventaja
  assert.strictEqual(pb.state.attempts, 2, 'ancla nueva: sin ventaja');
  pb.onSample(m3, sample(100, 0.15));        // p bajó 15 pts desde el ancla → DOWN pa = 0.705
  await pb.markets.get('g3').done;
  assert.strictEqual(pb.state.attempts, 3);
  assert.strictEqual(pb.state.open[0].side, 'DOWN');
  assert.strictEqual(pb.state.open[0].paid, 0.57);
  // ask fuera de rango ($0.30-0.70) no entra
  const m4 = mkt('g4');
  pb.onSample(m4, sample(150, 0.50, 0.75, 0.74, 0.26));
  pb.onSample(m4, sample(100, 0.95, 0.75, 0.74, 0.26));
  assert.strictEqual(pb.state.attempts, 3, 'ask 0.75 fuera del rango');
  assert.strictEqual(pb.markets.get('g4').best, null, 'sin asks en rango: sin mejor ventaja');
  // Mercado sin entrada: guarda la mejor ventaja vista en la ventana (para la línea "sin entrada")
  const m5 = mkt('g5');
  pb.onSample(m5, sample(150, 0.50));
  pb.onSample(m5, sample(100, 0.55)); // pAdj 0.495 → UP: 0.495 − 0.45 − comisión ≈ 2.7 pts
  pb.onSample(m5, sample(20, 0.70));  // 20 s restantes: fuera de la ventana, no cuenta
  const st5 = pb.markets.get('g5');
  assert.strictEqual(st5.inWin, 1);
  assert.strictEqual(st5.withData, 1);
  assert.strictEqual(st5.best.side, 'UP');
  assert.ok(Math.abs(st5.best.edge - (0.495 - 0.45 - FEE * 0.45 * 0.55)) < 1e-9);
  assert.strictEqual(pb.state.attempts, 3);

  // 7) Estado persistente: una instancia nueva lo recupera, y resuelve por Gamma lo que quedó abierto
  const pb2 = new PaperB({ polyWs, stateFile, env, fetchFn: fakeFetch });
  assert.strictEqual(pb2.state.w, 1);
  assert.strictEqual(pb2.state.open.length, 1);
  await pb2._resolveStale(pb2.state.open[0].endTs + 6 * 60000);
  const expDown = 8 * (1 - 0.57) - FEE * 0.57 * 0.43 * 8;
  assert.strictEqual(pb2.state.w, 2, 'DOWN ganó');
  assert.ok(Math.abs(pb2.state.pnl - (expWin + expDown)) < 1e-3);
  assert.ok(/Balance B: \+\$/.test(pb2.summary()));
  assert.ok(pb2.summary().includes('con el libro REST: +$8.52 (2-0); 0 llenadas que con REST no llenaban, 0 que solo llenaba el REST | límite buffer'), pb2.summary());

  // 8) El WS llena pero el libro REST a +400 ms ya no tenía el precio: cuenta aparte en el P&L con REST
  const m6 = mkt('g6');
  book.Y = 0.45;
  pb2.onSample(m6, sample(150, 0.50));
  pb2.onSample(m6, sample(100, 0.65));
  setTimeout(() => { rest.Y = 0.60; }, 15); // el REST al decidir todavía en 0.45; al fill, 0.60
  await pb2.markets.get('g6').done;
  delete rest.Y;
  const p6 = pb2.state.open.find(x => x.gammaId === 'g6');
  assert.strictEqual(p6.paid, 0.46, 'paper con el WS: llenó');
  assert.deepStrictEqual([p6.restAsk0, p6.restAsk400, p6.restFill], [0.45, 0.60, false]);
  assert.deepStrictEqual([p6.restAsk200, p6.restFill200], [0.45, true], 'a +200 ms el REST todavía estaba en 0.45');
  pb2.onResolved('g6', 'UP', 'gamma');
  assert.strictEqual(pb2.state.w, 3);
  assert.deepStrictEqual([pb2.state.restNo.n, pb2.state.restNo.w], [1, 1]);
  assert.ok(Math.abs(pb2.state.restNo.pnl - expWin) < 1e-3);
  assert.ok(pb2.summary().includes('con el libro REST: +$8.52 (2-0); 1 llenadas que con REST no llenaban'), pb2.summary());
  assert.ok(pb2.summary().includes('con el REST a +10ms: +$18.96 (4-0); 0 llenadas que con el REST a +10ms no llenaban, 1 que solo llenaba ese REST (desde '), pb2.summary());
  // 9) Estado guardado antes del contador: se arma con las cerradas
  const old = path.join(dir, 'viejo.json');
  fs.writeFileSync(old, JSON.stringify({ v: 1, startedAt: Date.now(), w: 1, l: 1, pnl: 1, recent: [{ restFill: false, win: true, pnl: 2 }, { restFill: true, win: false, pnl: -1 }] }));
  const pb3 = new PaperB({ polyWs, stateFile: old, env, fetchFn: fakeFetch });
  assert.deepStrictEqual(pb3.state.restNo, { n: 1, w: 1, pnl: 2 });
  assert.deepStrictEqual(pb3.state.rest, { n: 1, w: 0, pnl: -1, only: 0 });
  assert.ok(pb3.summary().includes('con el libro REST: −$1.00 (0-1); 1 llenadas'), pb3.summary());
  assert.deepStrictEqual([pb3.state.rest200.n, pb3.state.rest200.no, pb3.state.rest200Open], [0, 0, []], 'la cuenta del REST a +200 ms arranca en cero');

  // 10) Límite por precio justo (PAPER_B_LIMIT=fair, margen 2 pts): pAdj 0.595 → límite
  //     floor((0.575 − comisión(0.575))·100)/100 = 0.55; el ask sube a 0.52 en la demora y llena igual
  const pf = new PaperB({ polyWs, stateFile: path.join(dir, 'fair.json'), env: { ...env, PAPER_B_LIMIT: 'fair', PAPER_B_LIMIT_MARGIN: '0.02' }, fetchFn: fakeFetch });
  assert.ok(pf.describe().includes('límite = precio justo − comisión − 2 pts, tope $0.72'), pf.describe());
  book.Y = 0.45;
  const m7 = mkt('g7');
  pf.onSample(m7, sample(150, 0.50));
  pf.onSample(m7, sample(100, 0.65));
  setTimeout(() => { book.Y = 0.52; }, 15);
  await pf.markets.get('g7').done;
  const p7 = pf.state.open[0];
  assert.deepStrictEqual([p7.limit, p7.size, p7.paid, p7.restFill, p7.restPaid], [0.55, 9, 0.52, true, 0.52]);
  assert.deepStrictEqual([p7.restAsk200, p7.restPaid200], [0.45, 0.46], 'a +200 ms el REST estaba más barato');
  pf.onResolved('g7', 'UP', 'gamma');
  const exp7 = 9 * (1 - 0.52) - FEE * 0.52 * 0.48 * 9;
  assert.ok(Math.abs(pf.state.pnl - exp7) < 1e-3);
  assert.ok(Math.abs(pf.state.rest.pnl - exp7) < 1e-3, 'con el REST, al mismo precio');
  // 11) Solo el REST llenaba: el WS quedó arriba del límite (0.60) y el REST seguía en 0.45
  book.Y = 0.45;
  const m8 = mkt('g8');
  pf.onSample(m8, sample(150, 0.50));
  pf.onSample(m8, sample(100, 0.65));
  setTimeout(() => { book.Y = 0.60; rest.Y = 0.45; }, 15);
  await pf.markets.get('g8').done;
  delete rest.Y;
  assert.strictEqual(pf.state.noFill, 1, 'el WS no llenó');
  assert.strictEqual(pf.state.restOpen.length, 1, 'con el REST sí');
  assert.strictEqual(pf.state.restOpen[0].restPaid, 0.46, 'al menos ask al decidir + 1 tick');
  pf.onResolved('g8', 'UP', 'gamma');
  const exp8 = 9 * (1 - 0.46) - FEE * 0.46 * 0.54 * 9;
  assert.deepStrictEqual([pf.state.rest.n, pf.state.rest.w, pf.state.rest.only, pf.state.restOpen.length], [2, 2, 1, 0]);
  assert.ok(Math.abs(pf.state.rest.pnl - (exp7 + exp8)) < 1e-3);
  assert.ok(Math.abs(pf.state.pnl - exp7) < 1e-3, 'el P&L del paper no cambia');
  assert.ok(pf.summary().includes('0 llenadas que con REST no llenaban, 1 que solo llenaba el REST | límite fair'), pf.summary());
  assert.deepStrictEqual([pf.state.rest200.n, pf.state.rest200.w, pf.state.rest200.only, pf.state.rest200Open.length], [2, 2, 1, 0]);
  assert.ok(Math.abs(pf.state.rest200.pnl - 2 * exp8) < 1e-3, 'las dos a $0.46 con el REST a +200 ms');

  // 12) Precio viejo del WS con PAPER_B_REST_GUARD=on: el WS dice 0.45 pero el REST al decidir ya está
  //     en 0.60 → no entra; con el WS habría llenado a 0.46 y se anota aparte cómo habría salido
  assert.ok(pf.describe().includes('precio viejo del WS (REST al decidir más de 2¢ arriba): solo se mide'), pf.describe());
  const pg = new PaperB({ polyWs, stateFile: path.join(dir, 'guard.json'), env: { ...env, PAPER_B_LIMIT: 'fair', PAPER_B_REST_GUARD: 'on' }, fetchFn: fakeFetch });
  assert.ok(pg.describe().includes('no entra si el REST al decidir está más de 2¢ arriba del WS'), pg.describe());
  book.Y = 0.45; rest.Y = 0.60;
  const m9 = mkt('g9');
  pg.onSample(m9, sample(150, 0.50));
  pg.onSample(m9, sample(100, 0.65));
  await pg.markets.get('g9').done;
  delete rest.Y;
  assert.strictEqual(pg.state.attempts, 0, 'no cuenta como intento');
  assert.deepStrictEqual([pg.state.open.length, pg.state.restOpen.length, pg.state.phantomOpen.length], [0, 0, 1]);
  const p9 = pg.state.phantomOpen[0];
  assert.deepStrictEqual([p9.phantom, p9.restAsk0, p9.paid, p9.size], [true, 0.60, 0.46, 9]);
  assert.deepStrictEqual(pg.state.phantom, { n: 1, filled: 1, w: 0, l: 0, pnl: 0 });
  pg.onResolved('g9', 'DOWN', 'gamma');
  const exp9 = -9 * 0.46 - FEE * 0.46 * 0.54 * 9;
  assert.deepStrictEqual([pg.state.phantom.w, pg.state.phantom.l, pg.state.phantomOpen.length], [0, 1, 0]);
  assert.ok(Math.abs(pg.state.phantom.pnl - exp9) < 1e-3);
  assert.deepStrictEqual([pg.state.pnl, pg.state.rest.n], [0, 0], 'no toca el P&L del paper ni el del REST');
  assert.deepStrictEqual([pg.state.rest200.n, pg.state.rest200Open.length], [0, 0], 'ni el del REST a +200 ms');
  assert.ok(pg.summary().includes('precio viejo del WS al decidir (REST > WS + 2¢): 1, llenaban 1 (0-1 −$4.30), sin entrada'), pg.summary());
  // 13) Dentro de la tolerancia (REST 2¢ arriba del WS): entra normal
  book.Y = 0.45; rest.Y = 0.47;
  const m10 = mkt('g10');
  pg.onSample(m10, sample(150, 0.50));
  pg.onSample(m10, sample(100, 0.65));
  await pg.markets.get('g10').done;
  delete rest.Y;
  assert.strictEqual(pg.state.attempts, 1);
  assert.deepStrictEqual([pg.state.open[0].phantom, pg.state.open[0].restAsk0, pg.state.phantom.n], [false, 0.47, 1]);
  assert.deepStrictEqual([pg.state.open[0].restAsk200, pg.state.open[0].restPaid200], [0.47, 0.47]);
  pg.onResolved('g10', 'UP', 'gamma');
  assert.ok(Math.abs(pg.state.rest200.pnl - (9 * (1 - 0.47) - FEE * 0.47 * 0.53 * 9)) < 1e-3, 'paga lo que tenía el REST a +200 ms');
  // 14) Por defecto (sin PAPER_B_REST_GUARD) entra igual y se cuenta aparte
  const po = new PaperB({ polyWs, stateFile: path.join(dir, 'off.json'), env: { ...env, PAPER_B_LIMIT: 'fair' }, fetchFn: fakeFetch });
  book.Y = 0.45; rest.Y = 0.60;
  const m11 = mkt('g11');
  po.onSample(m11, sample(150, 0.50));
  po.onSample(m11, sample(100, 0.65));
  await po.markets.get('g11').done;
  delete rest.Y;
  assert.deepStrictEqual([po.state.attempts, po.state.filled, po.state.open[0].phantom, po.state.phantomOpen.length], [1, 1, true, 0]);
  po.onResolved('g11', 'UP', 'gamma');
  const exp11 = 9 * (1 - 0.46) - FEE * 0.46 * 0.54 * 9;
  assert.ok(Math.abs(po.state.pnl - exp11) < 1e-3, 'cuenta en el P&L del paper');
  assert.deepStrictEqual([po.state.phantom.n, po.state.phantom.filled, po.state.phantom.w], [1, 1, 1]);
  assert.ok(Math.abs(po.state.phantom.pnl - exp11) < 1e-3);
  assert.ok(po.summary().includes('llenaban 1 (1-0 +$4.70), entran igual'), po.summary());
  assert.deepStrictEqual([po.state.rest200.n, po.state.rest200.no], [0, 1], 'el WS llenó y el REST a +200 ms (0.60) no');
  assert.ok(po.summary().includes('con el REST a +10ms: +$0.00 (0-0); 1 llenadas que con el REST a +10ms no llenaban, 0 que solo llenaba ese REST'), po.summary());
  // Estado guardado antes del contador de precio viejo: arranca en cero
  assert.deepStrictEqual([pb3.state.phantom, pb3.state.phantomOpen], [{ n: 0, filled: 0, w: 0, l: 0, pnl: 0 }, []]);
  // 15) Posición abierta de antes de la cuenta del REST a +200 ms: no cuenta en esa cuenta
  const old2 = path.join(dir, 'viejo2.json');
  fs.writeFileSync(old2, JSON.stringify({ v: 1, startedAt: Date.now(), open: [{ id: 'PB_viejo', gammaId: 'gv', side: 'UP', size: 10, paid: 0.46, endTs: Date.now(), market: 'viejo', restFill: true, restPaid: 0.46 }] }));
  const pb4 = new PaperB({ polyWs, stateFile: old2, env, fetchFn: fakeFetch });
  pb4.onResolved('gv', 'UP', 'gamma');
  assert.deepStrictEqual([pb4.state.w, pb4.state.rest.n, pb4.state.rest200.n, pb4.state.rest200.no], [1, 1, 0, 0]);
  // 16) Sin respuesta del REST: las dos cuentas con REST usan el precio del WS
  const failFetch = async (url) => { if (new URL(url).pathname === '/book') throw new Error('fetch failed'); return fakeFetch(url); };
  const pn = new PaperB({ polyWs, stateFile: path.join(dir, 'norest.json'), env, fetchFn: failFetch });
  book.Y = 0.45;
  const m12 = mkt('g12');
  pn.onSample(m12, sample(150, 0.50));
  pn.onSample(m12, sample(100, 0.65));
  await pn.markets.get('g12').done;
  const p12 = pn.state.open[0];
  assert.deepStrictEqual([p12.restAsk0, p12.restFill, p12.restFill200, p12.paid], [null, null, null, 0.46]);
  pn.onResolved('g12', 'UP', 'gamma');
  assert.deepStrictEqual([pn.state.rest.n, pn.state.rest200.n, pn.state.rest200.no], [1, 1, 0]);
  assert.ok(Math.abs(pn.state.rest200.pnl - expWin) < 1e-3, 'al precio del WS');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('paper-b: 100 ok');
})().catch(e => { console.error(e); process.exit(1); });
