/**
 * FairValue — probabilidad "justa" de que un mercado Bitcoin Up or Down cierre UP.
 *
 *   P(UP) = Φ( ln(S / K) / (σ · √T) )
 *     S = precio actual de BTC (Binance, el feed más rápido que tiene el bot)
 *     K = precio de BTC en el segundo exacto de apertura del mercado
 *     T = segundos que faltan para el cierre
 *     σ = volatilidad por √segundo, medida con retornos de 5s de los últimos minutos
 *
 * Supone movimiento aleatorio sin tendencia. No decide trades: lo usa el modo sombra.
 * S y K salen del mismo feed, así que la diferencia Binance vs Chainlink se cancela casi toda.
 */
'use strict';

// Φ(z) — CDF normal estándar. erf por Abramowitz-Stegun 7.1.26 (error < 1.5e-7)
function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// Probabilidad de cerrar ≥ K. Pura, sin estado — la usa también el reporte.
function probUp(S, K, T, sigma) {
  if (!(S > 0) || !(K > 0)) return null;
  if (!(T > 0)) return S >= K ? 1 : 0;
  if (!(sigma > 0)) return null;
  return normCdf(Math.log(S / K) / (sigma * Math.sqrt(T)));
}

class FairValue {
  constructor({
    volWindowSec = parseInt(process.env.FV_VOL_WINDOW_SEC || '900'), // 15 min
    retHorizonSec = parseInt(process.env.FV_RET_HORIZON_SEC || '5'),  // retornos de 5s (1s tiene ruido de bid/ask)
    keepSec = 45 * 60,
  } = {}) {
    this.volWindowSec = volWindowSec;
    this.h = retHorizonSec;
    this.keepSec = keepSec;
    this.secs = [];   // segundos unix, crecientes
    this.prices = []; // último precio de cada segundo
    this.lastPrice = null;
    this.lastTs = 0;
    this._sigma = null;
    this._sigmaAt = 0;
  }

  // Llamar con CADA tick de BTC (es barato: solo guarda el último precio de cada segundo)
  onTick(price, ts = Date.now()) {
    if (!(price > 0)) return;
    const sec = Math.floor(ts / 1000);
    const n = this.secs.length;
    if (n && this.secs[n - 1] === sec) this.prices[n - 1] = price;
    else if (!n || sec > this.secs[n - 1]) { this.secs.push(sec); this.prices.push(price); }
    this.lastPrice = price;
    this.lastTs = ts;
    // recortar historia vieja
    const cutoff = sec - this.keepSec;
    let drop = 0;
    while (drop < this.secs.length && this.secs[drop] < cutoff) drop++;
    if (drop > 0) { this.secs.splice(0, drop); this.prices.splice(0, drop); }
  }

  // Último precio en o antes de ts (null si no hay historia tan vieja)
  priceAt(ts) {
    const sec = Math.floor(ts / 1000);
    let lo = 0, hi = this.secs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.secs[mid] <= sec) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? this.prices[ans] : null;
  }

  // Volatilidad por √segundo. null si hay menos de 2 min de historia.
  sigma(now = Date.now()) {
    if (this._sigma !== null && now - this._sigmaAt < 5000) return this._sigma;
    const n = this.secs.length;
    if (n < 2) return null;
    const endSec = this.secs[n - 1];
    const startSec = Math.max(this.secs[0], endSec - this.volWindowSec);
    if (endSec - startSec < 120) return null;
    // serie por segundo con forward-fill
    const series = [];
    let j = 0, last = null;
    for (let s = startSec; s <= endSec; s++) {
      while (j < n && this.secs[j] <= s) { last = this.prices[j]; j++; }
      series.push(last);
    }
    let sum = 0, cnt = 0;
    for (let i = this.h; i < series.length; i++) {
      const a = series[i - this.h], b = series[i];
      if (a > 0 && b > 0) { const r = Math.log(b / a); sum += r * r; cnt++; }
    }
    if (cnt < 60) return null;
    const s = Math.sqrt(sum / cnt / this.h);
    this._sigma = s > 0 ? s : null;
    this._sigmaAt = now;
    return this._sigma;
  }

  // P(UP) para un mercado con apertura K y cierre endTs
  probUp(K, endTs, now = Date.now()) {
    const S = this.lastPrice;
    const T = (endTs - now) / 1000;
    return probUp(S, K, T, this.sigma(now));
  }
}

module.exports = { FairValue, probUp, normCdf };
