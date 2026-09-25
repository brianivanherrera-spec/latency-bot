'use strict';
// Calendario de mercados BTC Up/Down 5m. El slug es determinístico: btc-updown-5m-<inicio en segundos>.
// Se busca cada mercado en Gamma PREFETCH_MS antes de que abra y se abre su libro unos segundos antes,
// así el bot tiene precios desde el segundo 0 (sin depender de que Gamma diga que el anterior terminó).
const { MarketBook } = require('./feeds/book');

const parseArr = v => { if (Array.isArray(v)) return v; try { return JSON.parse(v); } catch (_) { return []; } };

function parseGammaMarket(event, startMs, cfg) {
  const m = event?.markets?.[0];
  if (!m) return null;
  const tokens = parseArr(m.clobTokenIds), outcomes = parseArr(m.outcomes).map(o => String(o).toLowerCase());
  if (tokens.length < 2) return null;
  let up = tokens[0], down = tokens[1];
  const iUp = outcomes.findIndex(o => o === 'up' || o === 'yes');
  const iDn = outcomes.findIndex(o => o === 'down' || o === 'no');
  if (iUp >= 0 && iDn >= 0) { up = tokens[iUp]; down = tokens[iDn]; }
  const feesEnabled = m.feesEnabled !== false; // si Gamma no lo dice, asumir que cobra (conservador)
  return {
    startMs, endMs: startMs + cfg.WINDOW_MS,
    label: new Date(startMs).toISOString().slice(11, 16) + 'UTC',
    gammaId: String(m.id), conditionId: m.conditionId, question: event.title || m.question,
    upToken: up, downToken: down,
    tickSize: parseFloat(m.orderPriceMinTickSize) || 0.01,
    minShares: parseFloat(m.orderMinSize) || cfg.MIN_ORDER_SHARES_DEFAULT,
    feeRate: feesEnabled ? cfg.FEE_RATE_DEFAULT : 0,
    feeInfo: { feesEnabled: m.feesEnabled ?? null, feeType: m.feeType ?? null, takerBaseFee: m.takerBaseFee ?? null, feeSchedule: m.feeSchedule ?? null },
  };
}

class MarketScheduler {
  constructor({ cfg, log, fetchJson, onOpen, onClose }) {
    Object.assign(this, { cfg, log, fetchJson, onOpen, onClose });
    this.markets = new Map(); // startMs → market
    this._fetching = new Set();
    this._feeLogged = false;
  }

  start() { this._tick(); this.timer = setInterval(() => this._tick(), 1000); return this; }
  stop() { clearInterval(this.timer); for (const m of this.markets.values()) m.book?.stop(); }

  current(now = Date.now()) { return this.markets.get(now - (now % this.cfg.WINDOW_MS)) || null; }

  async _fetch(startMs) {
    if (this._fetching.has(startMs) || this.markets.has(startMs)) return;
    this._fetching.add(startMs);
    try {
      const slug = `${this.cfg.SLUG_PREFIX}${Math.floor(startMs / 1000)}`;
      const data = await this.fetchJson(`${this.cfg.GAMMA}/events?slug=${slug}`);
      const event = Array.isArray(data) ? data[0] : null;
      const mk = parseGammaMarket(event, startMs, this.cfg);
      if (!mk) { this.log.warn(`Gamma sin mercado para ${slug} (reintenta)`); return; }
      mk.state = 'scheduled';
      this.markets.set(startMs, mk);
      if (!this._feeLogged) { this._feeLogged = true; this.log.info(`Comisiones según Gamma: ${JSON.stringify(mk.feeInfo)} → rate usado ${mk.feeRate}`); }
      this.log.info(`Mercado ${mk.label} listo (${mk.question})`);
    } catch (e) {
      this.log.warn(`Gamma error ${startMs}: ${e.message}`);
    } finally { this._fetching.delete(startMs); }
  }

  _tick(now = Date.now()) {
    const W = this.cfg.WINDOW_MS, cur = now - (now % W), next = cur + W;
    this._fetch(cur);
    if (next - now <= this.cfg.PREFETCH_MS) this._fetch(next);
    for (const [start, mk] of this.markets) {
      if (mk.state === 'scheduled' && now >= start - this.cfg.BOOK_CONNECT_BEFORE_MS) {
        mk.book = new MarketBook({ cfg: this.cfg, log: this.log, market: mk }).start();
        mk.state = 'live';
        this.onOpen?.(mk);
      }
      if (mk.state === 'live' && now >= mk.endMs + 5000) {
        mk.book.stop();
        mk.state = 'closed';
        this.onClose?.(mk);
      }
      if (mk.state === 'closed' && now > mk.endMs + 30 * 60000) this.markets.delete(start); // limpieza
    }
  }
}

module.exports = { MarketScheduler, parseGammaMarket };
