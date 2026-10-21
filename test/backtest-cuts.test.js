/**
 * Backtest: regla de B por partes (ventaja, σ, modelo saturado, movimiento previo del ask), con el modelo en modo
 * blend (σ con piso) y como maker (scripts/backtest.js) sobre mercados armados a mano.
 * Uso: node test/backtest-cuts.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, firstFire, fairLimitOf, normInv, blendP, fireRecords, cutStats, cutStats2, makerExec } = require('../scripts/backtest');
const { normCdf } = require('../src/fair-value');

const FEE = 0.072, fee = p => FEE * p * (1 - p);
const near = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);
const S0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const MIN = 60000;
const cols = ['t', 'secs_left', 'p_up', 'src', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'sigma_e6', 'sigma_short_e6', 'sigma_long_e6', 'btc'];
const book = (yb, ya) => [yb, ya, +(1 - ya).toFixed(2), +(1 - yb).toFixed(2)];

// Libro quieto en YES 0.49/0.50; a 100 s del cierre el modelo salta de 0.5 a pJump. σ corta sS y larga sL (×1e-6).
function satMarket(start, winner, pJump, sS, sL) {
  const rows = [];
  for (let t = 0; t < 300; t++) rows.push([t, 300 - t, t >= 200 ? pJump : 0.5, 1, ...book(0.49, 0.50), sS * 1.4, sS, sL, 100000]);
  return { start_ts: start, winner, strike: 100000, cols, rows };
}
// El ask de YES baja de 0.56 a 0.50 en t=199 y en t=200 el modelo sube a 0.65 (ventaja UP 12.7 pts, el ask había
// bajado 6¢ en los 3 s previos). Opcional: en dropAt el libro baja a 0.47/0.48, en drop2At a 0.46/0.47 y en pFallAt
// el modelo cae a 0.30. σ corta y larga 50e-6 (sobre el piso: con blend el modelo no cambia).
function trendMarket(start, winner, { dropAt = null, drop2At = null, pFallAt = null } = {}) {
  const rows = [];
  for (let t = 0; t < 300; t++) {
    const b = drop2At != null && t >= drop2At ? book(0.46, 0.47) : dropAt != null && t >= dropAt ? book(0.47, 0.48)
      : t >= 199 ? book(0.49, 0.50) : book(0.55, 0.56);
    const p = pFallAt != null && t >= pFallAt ? 0.30 : t >= 200 ? 0.65 : 0.5;
    rows.push([t, 300 - t, p, 1, ...b, 70, 50, 50, 100000]);
  }
  return { start_ts: start, winner, strike: 100000, cols, rows };
}
// El ask de YES sube de 0.45 a 0.50 en t=199 (el mercado ya se mueve a favor) y en t=200 el modelo sube a 0.65
function riseMarket(start, winner) {
  const rows = [];
  for (let t = 0; t < 300; t++) rows.push([t, 300 - t, t >= 200 ? 0.65 : 0.5, 1, ...(t >= 199 ? book(0.49, 0.50) : book(0.44, 0.45)), 70, 50, 50, 100000]);
  return { start_ts: start, winner, strike: 100000, cols, rows };
}
// Formato viejo, sin las columnas de σ corta y larga
function oldMarket(start) {
  const c = ['t', 'secs_left', 'p_up', 'src', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'sigma_e6', 'btc'];
  const rows = [];
  for (let t = 0; t < 300; t++) rows.push([t, 300 - t, t >= 200 ? 0.65 : 0.5, 1, ...book(0.49, 0.50), 70, 100000]);
  return { start_ts: start, winner: 'UP', strike: 100000, cols: c, rows };
}

(async () => {
  // Φ⁻¹ y el modelo en modo blend
  near(normInv(0.5), 0, 1e-9);
  near(normInv(0.975), 1.959964, 1e-5);
  for (const p of [0.001, 0.2, 0.7, 0.999]) near(normCdf(normInv(p)), p, 1e-6);
  near(blendP(0.5, 15, 60), 0.5, 1e-7);
  near(blendP(0.999, 15, 60), normCdf(normInv(0.999) * 15 / 52.5), 1e-9); // σblend = √(0.25·225 + 0.75·3600) = 52.5
  near(blendP(0.99, 10, 10), normCdf(normInv(0.99) * 10 / 30), 1e-9);     // con mercado quieto manda el piso de 30e-6
  near(blendP(0.65, 50, 50), 0.65, 1e-6);                                  // σ sobre el piso: el modelo no cambia
  assert.strictEqual(blendP(0.7, null, 50), null);
  assert.strictEqual(blendP(null, 50, 50), null);

  const mks = [
    trendMarket(S0, 'UP'),                                         // 8-15 pts, el ask venía bajando, gana
    satMarket(S0 + 5 * MIN, 'DOWN', 0.999, 10, 10),                // modelo saturado: 47.6 pts, pierde
    satMarket(S0 + 10 * MIN, 'UP', 0.75, 10, 10),                  // 22.7 pts con el modelo actual; con blend no dispara
    trendMarket(S0 + 15 * MIN, 'DOWN', { dropAt: 230 }),           // maker: llena en t=230 y pierde
    trendMarket(S0 + 20 * MIN, 'UP', { pFallAt: 220 }),            // maker: se cancela en t=220
    trendMarket(S0 + 25 * MIN, 'UP', { dropAt: 230, drop2At: 240 }), // maker 3¢ abajo: llena en t=240 y gana
    oldMarket(S0 + 30 * MIN),
    riseMarket(S0 + 35 * MIN, 'UP'),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-'));
  const file = path.join(dir, 'shadow-ticks.jsonl');
  fs.writeFileSync(file, mks.map(m => JSON.stringify(m)).join('\n') + '\n');
  const M = await load(file);
  assert.strictEqual(M.length, 8);
  const [mTrend, mSat, mOff, mFill, mCanc, mDeep, mOld, mRise] = M;
  assert.strictEqual(mTrend.rows[250].sigS, 50);
  assert.strictEqual(mTrend.rows[250].sigL, 50);
  assert.strictEqual(mOld.rows[250].sigS, null, 'formato viejo: sin σ corta');
  assert.strictEqual(mOld.rows[250].pB, null);
  assert.strictEqual(mOld.rows[250].pAdjB, undefined, 'sin modelo blend no hay ancla');

  const bCfg = { kind: 'anchored', e: 0.08, lo: 0.30, hi: 0.70, tMax: 120, tMin: 30 };
  const blendCfg = { ...bCfg, blend: true };
  // Modelo actual: las tres disparan en t=200 (100 s antes del cierre) comprando UP a $0.50
  for (const m of [mTrend, mSat, mOff]) {
    const f = firstFire(m, bCfg);
    assert.deepStrictEqual([f.side, f.ask, m.rows[f.i].sl], ['UP', 0.50, 100]);
  }
  // Con blend: la del modelo saturado sigue disparando (0.999 → 0.8485), la de 0.75 ya no y la de σ alta igual
  const pSatB = normCdf(normInv(0.999) / 3);
  near(mSat.rows[250].pAdjB, 0.495 + pSatB - 0.5, 1e-9);
  assert.ok(firstFire(mSat, blendCfg));
  const pOffB = normCdf(normInv(0.75) / 3);
  near(mOff.rows[250].pAdjB, 0.495 + pOffB - 0.5, 1e-9);
  assert.ok(0.495 + pOffB - 0.5 - 0.50 - fee(0.50) < 0.08, 'con blend la ventaja queda debajo de 8 pts');
  assert.strictEqual(firstFire(mOff, blendCfg), null);
  assert.strictEqual(firstFire(mTrend, blendCfg).i, firstFire(mTrend, bCfg).i);
  assert.strictEqual(firstFire(mOld, blendCfg), null, 'sin las dos σ no hay modelo blend');
  // Límite justo con blend: precio justo 0.8435 − 2 pts − comisión → $0.81, recortado al tope de $0.72
  assert.strictEqual(fairLimitOf(firstFire(mSat, blendCfg), mSat, blendCfg, 0.02), 0.72);

  // Rasgos de cada disparo y llenada con el límite justo (margen 2)
  const recs = fireRecords([mTrend, mSat, mOff], bCfg, 0.02);
  assert.strictEqual(recs.length, 3);
  const [rt, rs, ro] = recs;
  near(rt.edge, 0.645 - 0.50 - fee(0.50));
  assert.deepStrictEqual([rt.filled, rt.win, rt.price, rt.trend, rt.pModel, rt.sigS], [true, true, 0.50, -0.06, 0.65, 50]);
  near(rt.pnl, Math.floor(5 / 0.60) * (0.50 - fee(0.50)), 1e-9); // límite justo: floor((0.625 − comisión)·100)/100 = $0.60
  near(rs.edge, 0.994 - 0.50 - fee(0.50));
  assert.deepStrictEqual([rs.filled, rs.win, rs.trend, rs.pModel, rs.sigS], [true, false, 0, 0.999, 10]);
  near(rs.pnl, Math.floor(5 / 0.72) * (-0.50 - fee(0.50)), 1e-9);
  near(ro.edge, 0.745 - 0.50 - fee(0.50));
  const c = cutStats(recs);
  assert.deepStrictEqual([c.fires, c.n], [3, 3]);
  assert.deepStrictEqual(c.edge.map(x => x.n), [1, 1, 1], 'una por tramo: 8-15, 15-25 y ≥ 25 pts');
  assert.deepStrictEqual(c.edge.map(x => x.wr), [1, 1, 0]);
  assert.deepStrictEqual(c.sigma.map(x => x.n), [2, 1, 0], 'σ corta 10e-6 debajo del piso de 30e-6, 50e-6 encima');
  assert.deepStrictEqual(c.sat.map(x => x.n), [1, 2]);
  assert.deepStrictEqual(c.trend.map(x => x.n), [1, 2, 0, 0], 'el ask bajó 6¢ en una; en las otras quieto');
  near(c.edge[2].pnl, +rs.pnl.toFixed(2), 1e-9);
  // Variables del 21/10: los tres a 100 s, ask $0.50, UP, 10 UTC, spread 1¢; el anterior de mSat (mTrend) ganó UP
  // (a favor), el de mOff (mSat) ganó DOWN (en contra) y mTrend no tiene anterior
  assert.deepStrictEqual([rt.sl, rt.ask, rt.side, rt.hour, rt.spread, rt.prevSame, rs.prevSame, ro.prevSame], [100, 0.5, 'UP', 10, 0.01, null, true, false]);
  const c2 = cutStats2(recs);
  assert.deepStrictEqual([c2.secs, c2.ask, c2.side, c2.hour, c2.spread, c2.prev].map(a => a.map(x => x.n)),
    [[0, 0, 3], [0, 3, 0], [3, 0], [0, 3, 0, 0], [3, 0], [1, 1, 1]]);
  assert.deepStrictEqual(c2.prev.map(x => x.wr), [0, 1, 1], 'a favor perdió (mSat), en contra ganó (mOff)');
  // Sin llenar no cuenta: un disparo cuyo ask salta 1 s después por encima del límite queda fuera de los cortes
  const jumpRec = { ...rt, filled: false };
  assert.deepStrictEqual([cutStats([jumpRec, rs]).fires, cutStats([jumpRec, rs]).n], [2, 1]);

  // Maker 1¢ debajo del ask: con 1¢ de spread se suma al bid ($0.49) y necesita que el ask baje a menos de $0.49
  const q = makerExec([mTrend], bCfg, 'near');
  assert.deepStrictEqual([q.fires, q.n, q.canc], [1, 0, 0], 'el libro no se movió: no llena');
  const fl = makerExec([mFill], bCfg, 'near');
  assert.deepStrictEqual([fl.n, fl.wr, fl.evPerShare], [1, 0, -0.49], 'llena justo cuando el mercado baja, y pierde');
  near(fl.pnl, Math.floor(5 / 0.49) * -0.49, 1e-9);
  const cn = makerExec([mCanc], bCfg, 'near');
  assert.deepStrictEqual([cn.n, cn.canc], [0, 1], 'el precio justo anclado cae a 0.295: se cancela');
  // 3¢ debajo del ask ($0.47): en t=230 el ask llega a $0.48 (no alcanza), en t=240 a $0.47 → llena y gana
  const dp = makerExec([mDeep], bCfg, 'deep');
  assert.deepStrictEqual([dp.n, dp.wr, dp.evPerShare], [1, 1, 0.53]);
  near(dp.pnl, Math.floor(5 / 0.47) * 0.53, 1e-9);
  const dn = makerExec([mDeep], bCfg, 'near');
  assert.deepStrictEqual([dn.n, dn.wr], [1, 1], 'el de 1¢ llena antes, en t=230');
  // Hipótesis (ii): solo con el ask del lado comprado subiendo ≥ 2¢ en los 3 s previos
  const upCfg = { ...bCfg, minTrend: 0.02 };
  assert.strictEqual(firstFire(mTrend, upCfg), null, 'el ask venía bajando 6¢: no entra');
  assert.strictEqual(firstFire(mSat, upCfg), null, 'el ask estaba quieto: no entra');
  const fr = firstFire(mRise, upCfg);
  assert.deepStrictEqual([fr.side, fr.ask, mRise.rows[fr.i].sl], ['UP', 0.50, 100], 'el ask subió 5¢: entra igual que sin filtro');
  assert.strictEqual(firstFire(mRise, bCfg).i, fr.i);
  assert.strictEqual(firstFire(mRise, { ...upCfg, blend: true }).i, fr.i, 'σ sobre el piso: con blend también entra');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('backtest-cuts: 56 ok');
})().catch(err => { console.error(err); process.exit(1); });
