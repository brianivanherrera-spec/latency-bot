'use strict';
// Φ(z): CDF normal estándar (erf de Abramowitz-Stegun 7.1.26, error < 1.5e-7)
function normCdf(z) {
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// Comisión de Polymarket por acción para el que toma liquidez: rate × p × (1 − p)
function takerFee(price, rate) { return rate > 0 ? rate * price * (1 - price) : 0; }

const round = (v, d = 4) => (v == null || !Number.isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

module.exports = { normCdf, takerFee, round, clamp };
