'use strict';
// Probabilidad de que el mercado cierre UP, con la regla REAL de resolución:
//   UP  ⇔  A ≥ K
//   K = TWAP 60 s de Chainlink publicado en la apertura (== priceToBeat oficial)
//   A = TWAP 60 s de Chainlink al cierre ≈ promedio de los puntos de Chainlink en (fin − 60 s, fin]
//
// Qué sabemos en cada momento `now`:
//   - puntos de Chainlink ya publicados hasta tCL (llegan ~1.45 s tarde)
//   - Binance ahora, que va ~CL_LAG_MS por delante de Chainlink
//   - proyección de Chainlink: X0 = Binance(now) + base, con base = EWMA(Chainlink(t) − Binance(t − lag))
//     X0 estima el valor que Chainlink va a publicar para el instante s0 = now + lag
//
// Cada segundo de la ventana de 60 s es: conocido (Chainlink publicado), puente (interpolación
// lineal entre el último Chainlink y X0) o futuro (esperanza X0, incierto).
// Futuro como movimiento browniano X(s) = X0 + σ·B(s − s0), σ en USD/√s:
//   Var(∫_a^fin X ds) = σ² [ (a − s0)(fin − a)² + (fin − a)³/3 ],   a = max(s0, fin − 60)
// Más el error de la proyección (NOWCAST_SD) sobre la parte puente+futura.
const { normCdf, round } = require('./math');

class Pricer {
  constructor({ cfg, btc, clSpot, clTwap }) {
    Object.assign(this, { cfg, btc, clSpot, clTwap });
    this.basis = null; this.basisN = 0;
    clSpot.onPoint = (pt) => this._updateBasis(pt);
  }

  _updateBasis(pt) {
    const bn = this.btc.priceAt(pt.ts - this.cfg.CL_LAG_MS);
    if (!bn) return;
    const d = pt.value - bn;
    this.basis = this.basis == null ? d : this.basis + this.cfg.BASIS_ALPHA * (d - this.basis);
    this.basisN++;
  }

  // Precio a superar: el TWAP publicado en la apertura; si no llegó, promedio propio del minuto previo
  strike(mk) {
    if (mk.K != null) return mk.K;
    const pub = this.clTwap.at(mk.startMs, 1000);
    if (pub) { mk.K = pub.value; mk.Ksrc = 'twap_publicado'; return mk.K; }
    const lastCl = this.clSpot.last();
    if (lastCl && lastCl.ts >= mk.startMs && Date.now() > mk.startMs + 5000) {
      const own = this.clSpot.average(mk.startMs, 60000, 0.8);
      if (own) { mk.K = own; mk.Ksrc = 'promedio_propio'; return mk.K; }
    }
    return null;
  }

  // Estado de los datos: null si todo bien, o el motivo por el que no hay que operar
  staleReason(now = Date.now()) {
    const b = this.btc.last, c = this.clSpot.last();
    if (!b || now - b.ts > this.cfg.STALE_BINANCE_MS) return 'binance_viejo';
    if (!c || now - c.recv > this.cfg.STALE_CHAINLINK_MS) return 'chainlink_viejo';
    if (this.basis == null || this.basisN < 10) return 'base_sin_calibrar';
    if (this.btc.sigma(now) == null) return 'volatilidad_sin_historia';
    return null;
  }

  fair(mk, now = Date.now()) {
    const K = this.strike(mk);
    if (K == null) return { reason: 'sin_precio_a_superar' };
    const stale = this.staleReason(now);
    if (stale) return { reason: stale };

    const cfg = this.cfg, W = cfg.TWAP_WINDOW_S, end = mk.endMs / 1000;
    const sigmaAbs = this.btc.sigma(now) * cfg.VOL_MULT * this.btc.last.price;   // USD por √s
    const X0 = this.btc.last.price + this.basis;
    const s0 = (now + cfg.CL_LAG_MS) / 1000;
    const cl = this.clSpot.last(), tCL = cl.ts / 1000;

    // Media del TWAP de cierre, segundo a segundo
    let sum = 0, bridge = 0, future = 0;
    for (let i = 0; i < W; i++) {
      const s = end - W + i + 1; // cada segundo de (fin − 60, fin]
      if (s <= tCL) {
        const v = this.clSpot.valueAtOrBefore(s * 1000);
        sum += v != null ? v : cl.value;
      } else if (s <= s0) {
        const f = (s - tCL) / Math.max(1e-9, s0 - tCL);
        sum += cl.value + f * (X0 - cl.value); bridge++;
      } else { sum += X0; future++; }
    }
    const mean = sum / W;

    // Varianza: futuro browniano + error de la proyección
    const a = Math.max(s0, end - W);
    let varInt = 0;
    if (end > a) varInt = sigmaAbs ** 2 * ((a - s0) * (end - a) ** 2 + (end - a) ** 3 / 3);
    const varFuture = varInt / (W * W);
    const wProj = (bridge / 2 + future) / W;
    const sd = Math.sqrt(varFuture + (wProj * cfg.NOWCAST_SD) ** 2);

    const pUp = sd > 1e-9 ? normCdf((mean - K) / sd) : (mean >= K ? 1 : 0);
    return {
      pUp, K, Ksrc: mk.Ksrc, mean: round(mean, 2), sd: round(sd, 3), X0: round(X0, 2),
      basis: round(this.basis, 2), sigmaRel: this.btc.sigma(now), secsLeft: (mk.endMs - now) / 1000,
    };
  }
}

module.exports = { Pricer };
