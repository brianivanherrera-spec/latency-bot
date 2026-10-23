/**
 * Velas de Binance por la API REST pública (sin clave), para los mercados horarios "Bitcoin Up or Down" de Polymarket:
 * resuelven con la vela de 1 h de Binance BTC/USDT que empieza a la hora del título (UP si cierre ≥ apertura), así que
 * el strike es la apertura de esa vela (plan del 23/10: el bot de valor en plazos más largos).
 *
 *   - open(startMs): sincrónico, para el strikeFn de la sombra (src/series-shadow.js): la apertura si ya la tiene; si
 *     no, pide la vela en segundo plano (como mucho un pedido cada retryMs) y devuelve null hasta que llegue.
 *   - winner(startMs): 'UP' / 'DOWN' con la vela ya cerrada (respaldo si Gamma no publica el ganador); null si todavía
 *     no cerró o no hubo respuesta.
 * Prueba los hosts en orden (api.binance.com y el espejo público de datos de mercado).
 */
'use strict';

class BinanceKlines {
  constructor({ symbol = 'BTCUSDT', interval = '1h', fetchFn = globalThis.fetch, now = Date.now, retryMs = 5000, keep = 6,
    hosts = ['https://api.binance.com', 'https://data-api.binance.vision'] } = {}) {
    Object.assign(this, { symbol, interval, fetch: fetchFn, now, retryMs, keep, hosts });
    this.opens = new Map();   // startMs → apertura
    this.tries = new Map();   // startMs → { at, inFlight }
  }

  // Vela que empieza en startMs → { open, close, closeTime } | null
  async kline(startMs) {
    for (const host of this.hosts) {
      try {
        const res = await this.fetch(`${host}/api/v3/klines?symbol=${this.symbol}&interval=${this.interval}&startTime=${startMs}&limit=1`,
          { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const k = (await res.json())?.[0];
        if (!Array.isArray(k) || Number(k[0]) !== startMs) continue;
        const open = parseFloat(k[1]), close = parseFloat(k[4]), closeTime = Number(k[6]);
        if (open > 0 && close > 0) return { open, close, closeTime };
      } catch (_) {}
    }
    return null;
  }

  open(startMs) {
    if (this.opens.has(startMs)) return this.opens.get(startMs);
    const t = this.tries.get(startMs) || { at: 0, inFlight: false };
    if (!t.inFlight && this.now() - t.at >= this.retryMs && this.now() >= startMs) {
      t.at = this.now(); t.inFlight = true;
      this.tries.set(startMs, t);
      t.done = this.kline(startMs).then(k => {
        if (k) {
          this.opens.set(startMs, k.open);
          while (this.opens.size > this.keep) this.opens.delete(this.opens.keys().next().value);
          this.tries.delete(startMs);
        }
      }).finally(() => { t.inFlight = false; });
    }
    return null;
  }

  async winner(startMs) {
    const k = await this.kline(startMs);
    if (!k || this.now() <= k.closeTime) return null;
    return k.close >= k.open ? 'UP' : 'DOWN';
  }
}

module.exports = { BinanceKlines };
