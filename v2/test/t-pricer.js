'use strict';
// Valida el modelo contra Monte Carlo: si los precios siguen exactamente las hipótesis del modelo,
// la probabilidad calculada tiene que coincidir con la frecuencia simulada de A ≥ K.
const assert = require('./assert');
const base = require('../src/config');
const { Pricer } = require('../src/pricer');
const { ChainlinkSeries } = require('../src/feeds/chainlink');

const cfg = { ...base, NOWCAST_SD: 0, CL_LAG_MS: 500, VOL_MULT: 1 };
let seed = 42; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());

function scenario(secsLeft, offsetUsd) {
  const now = Math.floor(Date.now() / 1000) * 1000 + 300;            // mitad de un segundo
  const endMs = now + secsLeft * 1000, startMs = endMs - 300000;
  const sigRel = 0.00006, P0 = 84000, sigAbs = sigRel * P0, basis = -15;
  const clSpot = new ChainlinkSeries({ cfg, log: { info() {}, warn() {} }, topic: 't', name: 't' });
  const tCL = now - 1450;
  // historia de Chainlink hasta tCL: paseo aleatorio que termina en P0 − basis... (valor exacto no importa)
  let v = P0 + basis + offsetUsd;
  const pts = [];
  for (let t = tCL; t > tCL - 400000; t -= 1000) { pts.push([t, v]); v += sigAbs * gauss(); }
  for (const [t, val] of pts.reverse()) clSpot.add(t, val, now);
  const clTwap = { at: () => null };
  const X0 = P0 + basis + offsetUsd;              // proyección = Binance ahora + base
  const btc = { last: { price: X0 - basis, ts: now }, sigma: () => sigRel, priceAt: () => X0 - basis };
  const pr = new Pricer({ cfg, btc, clSpot, clTwap });
  pr.basis = basis; pr.basisN = 100;
  const K = P0 + basis;                           // precio a superar = nivel sin el offset
  const mk = { startMs, endMs, K, Ksrc: 'test' };
  const f = pr.fair(mk, now);

  // Monte Carlo con las mismas hipótesis: conocido hasta tCL, puente lineal hasta s0, browniano después
  const W = 60, end = endMs / 1000, s0 = (now + cfg.CL_LAG_MS) / 1000, cl = clSpot.last();
  let up = 0; const N = 20000;
  for (let k = 0; k < N; k++) {
    let sum = 0, x = X0, tPrev = s0;
    for (let i = 0; i < W; i++) {
      const s = end - W + i + 1;
      if (s <= tCL / 1000) sum += clSpot.valueAtOrBefore(s * 1000);
      else if (s <= s0) sum += cl.value + (s - tCL / 1000) / (s0 - tCL / 1000) * (X0 - cl.value);
      else { x += sigAbs * Math.sqrt(s - tPrev) * gauss(); tPrev = s; sum += x; }
    }
    // avanzar el browniano desde s0 hasta el inicio de la ventana si hace falta
    if (up < 0) break;
    up += sum / W >= K ? 1 : 0;
  }
  return { model: f.pUp, mc: up / N, f };
}

// Nota: en la MC el browniano arranca en s0 aunque la ventana empiece después; el primer paso
// cubre (s0, fin−60] de una vez porque tPrev = s0 → sqrt(s − s0). Coincide con el modelo.
for (const [secs, off] of [[250, 8], [250, -20], [120, 10], [90, 3], [45, 6], [45, -4], [20, 2], [8, 1]]) {
  const r = scenario(secs, off);
  assert.near(r.model, r.mc, 0.02, `P(UP) con ${secs}s restantes y +$${off}: modelo ${r.model.toFixed(3)} vs Monte Carlo ${r.mc.toFixed(3)}`);
}

// Casos límite
{
  const r = scenario(250, 0);
  assert.near(r.model, 0.5, 0.02, 'sin diferencia con el precio a superar → ~50%');
}
{
  const pr = new Pricer({ cfg, btc: { last: null, sigma: () => null, priceAt: () => null }, clSpot: new ChainlinkSeries({ cfg, log: { info() {}, warn() {} }, topic: 't', name: 't' }), clTwap: { at: () => null } });
  const f = pr.fair({ startMs: Date.now() - 1000, endMs: Date.now() + 299000 });
  assert.ok(f.reason === 'sin_precio_a_superar', `sin precio a superar no opera (${f.reason})`);
}
