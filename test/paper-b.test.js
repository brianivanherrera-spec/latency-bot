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
  pb.onResolved('g2', 'UP', 'gamma');
  assert.strictEqual(pb.state.only200[0].winner, 'UP', 'se guarda cómo salió la que solo llenaba a 200 ms');

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
  assert.ok(pb2.summary().includes('con el libro REST: +$8.52 (2-0), 0 llenadas que con REST no llenaban'), pb2.summary());

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
  pb2.onResolved('g6', 'UP', 'gamma');
  assert.strictEqual(pb2.state.w, 3);
  assert.deepStrictEqual([pb2.state.restNo.n, pb2.state.restNo.w], [1, 1]);
  assert.ok(Math.abs(pb2.state.restNo.pnl - expWin) < 1e-3);
  assert.ok(pb2.summary().includes('con el libro REST: +$8.52 (2-0), 1 llenadas que con REST no llenaban'), pb2.summary());
  // 9) Estado guardado antes del contador: se arma con las cerradas
  const old = path.join(dir, 'viejo.json');
  fs.writeFileSync(old, JSON.stringify({ v: 1, startedAt: Date.now(), w: 1, l: 1, pnl: 1, recent: [{ restFill: false, win: true, pnl: 2 }, { restFill: true, win: false, pnl: -1 }] }));
  const pb3 = new PaperB({ polyWs, stateFile: old, env, fetchFn: fakeFetch });
  assert.deepStrictEqual(pb3.state.restNo, { n: 1, w: 1, pnl: 2 });
  assert.ok(pb3.summary().includes('con el libro REST: −$1.00 (0-1), 1 llenadas'), pb3.summary());
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('paper-b: 47 ok');
})().catch(e => { console.error(e); process.exit(1); });
