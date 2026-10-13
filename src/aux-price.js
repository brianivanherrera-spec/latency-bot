/**
 * Precio de Chainlink de otro activo (ETH) que llega por PolyBolt, solo para la sombra de otra serie
 * (src/series-shadow.js, mercados eth-updown-5m). No toca nada de BTC ni de las cuentas A y B.
 *
 * Guarda el spot y el TWAP 60 s publicados y da:
 *   - strike(apertura): el TWAP 60 s publicado en el segundo de apertura (como el priceToBeat de los mercados de BTC),
 *     recién cuando ya llegó un punto posterior (antes puede faltar el del segundo exacto);
 *   - fair(K, cierre, ahora): P(UP) con la misma fórmula TWAP del bot (twapFairUp, src/fair-value.js) con P = último
 *     spot de Chainlink y σ = σ de 15 min con retornos de 5 s del propio Chainlink (FairValue; no hay Binance de este
 *     activo), con el piso FAIR_SIGMA_FLOOR y el ×FAIR_VOL_MULT del bot.
 */
'use strict';
const { FairValue, twapFairUp } = require('./fair-value');

const W = 60; // segundos del TWAP con el que resuelven los mercados

class AuxPrice {
  constructor({ symbol, fairValue = new FairValue(), historyMs = 20 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { symbol, fv: fairValue, historyMs, now });
    this.hist = { spot: [], twap: [] }; // [{ ts (fuente, ms), value, received }], ordenado por ts
  }

  // pt = { ts (ms de la fuente), value, received }
  onPoint(kind, pt) {
    const h = this.hist[kind];
    if (!h || !(pt?.value > 0) || !Number.isFinite(pt?.ts)) return;
    const x = { ts: pt.ts, value: pt.value, received: pt.received ?? this.now() };
    if (h.length && x.ts <= h[h.length - 1].ts) {
      if (h.some(y => y.ts === x.ts)) return; // duplicado (snapshot al reconectar)
      const i = h.findIndex(y => y.ts > x.ts);
      h.splice(i === -1 ? h.length : i, 0, x);
    } else {
      h.push(x);
    }
    if (kind === 'spot') this.fv.onTick(x.value, x.ts);
    const cut = this.now() - this.historyMs;
    while (h.length && h[0].ts < cut) h.shift();
  }

  last(kind) {
    const h = this.hist[kind];
    return h.length ? h[h.length - 1] : null;
  }

  // TWAP 60 s publicado en el segundo de apertura (o el último hasta maxGapMs antes); null hasta que llega uno posterior
  strike(startMs, maxGapMs = 1000) {
    const h = this.hist.twap;
    if (!h.length || h[h.length - 1].ts <= startMs) return null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].ts <= startMs) return startMs - h[i].ts <= maxGapMs ? h[i].value : null;
    }
    return null;
  }

  // Promedio del spot con timestamp de fuente en [desde, hasta]
  spotMean(fromMs, toMs) {
    let sum = 0, n = 0;
    for (const x of this.hist.spot) if (x.ts >= fromMs && x.ts <= toMs) { sum += x.value; n++; }
    return n ? sum / n : null;
  }

  // P(UP): TWAP 60 s al cierre contra el strike K. null sin spot reciente o sin σ (FairValue pide 2 min de historia).
  fair(K, endMs, nowMs = this.now(), { volMult = 1.4, floor = 3e-5, maxAgeMs = 10000 } = {}) {
    const last = this.last('spot');
    if (K == null || !last || nowMs - last.received > maxAgeMs) return null;
    const sL = this.fv.sigma(nowMs);
    if (!sL) return null;
    const sigma = Math.max(sL, floor) * volMult;
    const T = (endMs - nowMs) / 1000;
    if (T <= 0) return null;
    const realized = T < W ? this.spotMean(last.ts - (W - T) * 1000, last.ts) : null;
    return { p: twapFairUp(last.value, K, T, W, sigma, realized).p, sigma, sigmaShort: null, sigmaLong: sL };
  }
}

module.exports = { AuxPrice };
