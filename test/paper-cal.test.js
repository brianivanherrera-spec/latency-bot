/**
 * Paper CAL (src/paper-cal.js): señal de calibración (anclado contra el mid, 120-10 s, ≥ 5 pts), fill con el libro
 * REST a +200 ms, resolución y estado persistente.
 * Uso: node test/paper-cal.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaperCal } = require('../src/paper-cal');

const FEE = 0.072;
let n = 0;
const ok = (c, msg) => { assert.ok(c, msg); n++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-cal-'));
const env = { PAPER_CHECK_MS: '5', TAKER_FEE_RATE: String(FEE) };
// API falsa: /book con el ask de cada token (100 acciones); /markets/ con el resultado de Gamma
const rest = { Y: 0.53, N: 0.48 };
let gammaUp = true;
const fakeFetch = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/book') {
    const a = rest[u.searchParams.get('token_id')];
    return { ok: true, json: async () => ({ timestamp: String(Date.now()), bids: [], asks: a == null ? [] : [{ price: String(a), size: '100' }] }) };
  }
  return { ok: true, json: async () => ({ closed: true, outcomePrices: gammaUp ? '["1", "0"]' : '["0", "1"]' }) };
};
const mkt = (id, endTs = Date.now() + 100_000) => ({ gammaId: id, yesTokenId: 'Y', noTokenId: 'N', endTs, question: `mercado ${id}` });
const smp = (T, p, yesBid = 0.50, yesAsk = 0.51, noAsk = 0.50) => ({ T, yesBid, yesAsk, noAsk, p });
const mk = (name, e = env) => new PaperCal({ stateFile: path.join(dir, `${name}.json`), attFile: path.join(dir, `${name}.jsonl`), env: e, fetchFn: fakeFetch });

(async () => {
  // 1) Ancla en p = 0.50 con mid 0.505; el modelo sube a 0.56 → pAdj 0.565, 6 pts arriba del mid en el momento 60 s → UP
  const pc = mk('a');
  const m1 = mkt('g1');
  pc.onSample(m1, smp(150, 0.50));            // fija el ancla (fuera de los momentos de control)
  pc.onSample(m1, smp(120, 0.53));            // momento 120 s: 3 pts, no alcanza
  eq(pc.state.attempts, 0, 'con 3 pts no entra');
  pc.onSample(m1, smp(90.4, 0.56));           // momento 90 s: 6 pts → UP
  await pc.markets.get('g1').exec;
  eq(pc.state.attempts, 1, 'entra en el primer momento con ≥ 5 pts');
  const p1 = pc.state.open[0];
  eq([p1.side, p1.point, p1.ask, p1.limit, p1.size, p1.ask200, p1.filled, p1.paid], ['UP', 90, 0.51, 0.53, 9, 0.53, true, 0.53], 'UP al ask, límite +2¢, fill con el REST a +200 ms');
  pc.onSample(m1, smp(60, 0.70));
  eq(pc.state.attempts, 1, 'un intento por mercado');
  // El intento queda registrado
  const att = JSON.parse(fs.readFileSync(path.join(dir, 'a.jsonl'), 'utf8').trim());
  eq([att.side, att.point, att.ask200, att.filled, att.start], ['UP', 90, 0.53, true, m1.endTs - 300000], 'registro del intento');

  // 2) Resolución: gana UP → +9·(1−0.53) − comisión
  pc.onResolved('g1', 'UP', 'gamma');
  const want = +(9 * (1 - 0.53) - FEE * 0.53 * 0.47 * 9).toFixed(4);
  eq([pc.state.w, pc.state.l, pc.state.open.length], [1, 0, 0], 'cerrada como ganada');
  ok(Math.abs(pc.state.pnl - want) < 1e-4, `P&L ${pc.state.pnl} ≈ ${want}`);
  ok(pc.z() != null && pc.z() > 0, 'z positiva con una ganada');
  pc.onResolved('g1', 'UP', 'gamma');
  eq(pc.state.w, 1, 'no se cierra dos veces');

  // 3) Modelo abajo del mid → DOWN al ask de No; el REST ya subió más que el límite → no llena
  rest.N = 0.55;
  const m2 = mkt('g2');
  pc.onSample(m2, smp(150, 0.50));
  pc.onSample(m2, smp(60, 0.43));             // pAdj 0.435, 7 pts abajo → DOWN a $0.50, límite $0.52
  await pc.markets.get('g2').exec;
  eq([pc.state.attempts, pc.state.noFill, pc.state.open.length], [2, 1, 0], 'DOWN sin fill: el REST a +200 ms está en $0.55');
  rest.N = 0.48;

  // 4) Spread > 10¢ en el momento de control: no se mira ese momento; tampoco entra fuera de los momentos
  const m3 = mkt('g3');
  pc.onSample(m3, smp(150, 0.50, 0.40, 0.52));
  pc.onSample(m3, smp(120, 0.60, 0.40, 0.52));   // spread 12¢
  pc.onSample(m3, smp(100, 0.60));               // fuera de los momentos
  eq(pc.state.attempts, 2, 'ni con spread ancho ni fuera de los momentos');
  pc.onSample(m3, smp(89.5, 0.60));              // momento 90 s: ancla reiniciada con el mid nuevo (0.505, p 0.60) → 0 pts
  eq(pc.state.attempts, 2, 'el ancla sigue al modelo cuando cambia el mid');

  // 5) Sin libro: el ancla se reinicia (como las filas vacías del backtest)
  const m4 = mkt('g4');
  pc.onSample(m4, smp(150, 0.50));
  pc.onSample(m4, { T: 125, yesBid: null, yesAsk: null, noAsk: null, p: 0.60 });
  pc.onSample(m4, smp(120, 0.60));               // ancla nueva en p 0.60 → 0 pts
  eq(pc.state.attempts, 2, 'ancla reiniciada sin libro');

  // 6) Estado persistente y resolución de respaldo con Gamma (reinicio con una abierta)
  const m5 = mkt('g5', Date.now() - 10 * 60000);
  pc.onSample(m5, smp(150, 0.50));
  pc.onSample(m5, smp(30, 0.58));
  await pc.markets.get('g5').exec;
  eq(pc.state.open.length, 1, 'abierta');
  const pc2 = mk('a');
  eq([pc2.state.attempts, pc2.state.w, pc2.state.open.length], [pc.state.attempts, 1, 1], 'el estado sobrevive al reinicio');
  gammaUp = false;
  await pc2._resolveStale();
  eq([pc2.state.w, pc2.state.l, pc2.state.open.length], [1, 1, 0], 'resuelta con Gamma (ganó DOWN)');
  ok(/Balance CAL: [+−]\$[\d.]+ \(1-1, z -?[\d.]+\), intentos 3, llenadas 2, sin fill 1, abiertas 0/.test(pc2.summary()), pc2.summary());

  // 7) Resultado que no es de Gamma: no cierra
  const pc3 = mk('b');
  const m6 = mkt('g6');
  pc3.onSample(m6, smp(150, 0.50)); pc3.onSample(m6, smp(10, 0.57));
  await pc3.markets.get('g6').exec;
  pc3.onResolved('g6', 'UP', 'btc_binance');
  eq(pc3.state.open.length, 1, 'solo resultados de Gamma');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`paper-cal: ${n} ok`);
})().catch(e => { console.error(e); process.exit(1); });
