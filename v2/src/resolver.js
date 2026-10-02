'use strict';
// Resolución de cada mercado:
//  - provisoria al instante: TWAP 60 s publicado al cierre vs precio a superar (misma regla que Polymarket)
//  - oficial: Gamma con closed=true y un precio ≥ 0.99; con eso se liquida el paper
//  - si Gamma no confirma en RESOLVE_TIMEOUT_MS, se liquida con la provisoria (marcado)
const { round } = require('./math');

class Resolver {
  constructor({ cfg, log, ledger, pricer, clTwap, fetchJson, setTimeoutFn = setTimeout }) {
    Object.assign(this, { cfg, log, ledger, pricer, clTwap, fetchJson, setTimeoutFn });
    this.stats = { resolved: 0, official: 0, fallback: 0, provisionalAgree: 0, provisionalChecked: 0 };
    this._seen = new Set(); // gammaIds en resolución o resueltos (un reinicio a mitad de mercado lo cerraba dos veces)
  }

  onClose(mk) {
    if (this._seen.has(mk.gammaId)) return false;
    this._seen.add(mk.gammaId);
    if (this._seen.size > 500) this._seen.delete(this._seen.values().next().value);
    this.setTimeoutFn(() => this._poll(mk, Date.now()), 20000);
    return true;
  }

  provisional(mk) {
    const K = mk.K ?? this.pricer.strike(mk);
    const end = this.clTwap.at(mk.endMs, 1000);
    if (K == null || !end) return null;
    return end.value >= K ? 'UP' : 'DOWN';
  }

  async _poll(mk, firstAt, delay = this.cfg.RESOLVE_POLL_MS) {
    let winner = null;
    try {
      const m = await this.fetchJson(`${this.cfg.GAMMA}/markets/${mk.gammaId}`);
      const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      const outcomes = (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes || []).map(o => String(o).toLowerCase());
      if (m.closed === true && prices) {
        const i = prices.findIndex(x => parseFloat(x) >= 0.99);
        if (i >= 0) { const o = outcomes[i] || (i === 0 ? 'up' : 'down'); winner = (o === 'up' || o === 'yes') ? 'UP' : 'DOWN'; }
      }
    } catch (e) { this.log.debug(`gamma ${mk.gammaId}: ${e.message}`); }

    if (winner) return this._finish(mk, winner, 'gamma');
    if (Date.now() - firstAt < this.cfg.RESOLVE_TIMEOUT_MS) {
      this.setTimeoutFn(() => this._poll(mk, firstAt), this.cfg.RESOLVE_POLL_MS);
      return;
    }
    const prov = this.provisional(mk) || mk.book?.resolvedHint || null;
    if (prov) return this._finish(mk, prov, 'twap_publicado_sin_gamma');
    // Sin Gamma ni TWAP: antes se cerraba como "desconocido" y la posición quedaba abierta
    // para siempre. Ahora se sigue consultando Gamma con backoff (hasta RESOLVE_MAX_POLL_MS).
    const next = Math.min((delay || 1000) * 2, this.cfg.RESOLVE_MAX_POLL_MS ?? 600000);
    if (!mk._unknownLogged) { mk._unknownLogged = true; this.log.warn(`${mk.label}: sin resultado de Gamma ni TWAP — se sigue consultando (backoff hasta ${Math.round(next / 1000)} s)`); }
    this.setTimeoutFn(() => this._poll(mk, firstAt, next), next);
  }

  _finish(mk, winner, source) {
    const prov = this.provisional(mk);
    if (prov && source === 'gamma') { this.stats.provisionalChecked++; if (prov === winner) this.stats.provisionalAgree++; }
    this.stats.resolved++; source === 'gamma' ? this.stats.official++ : this.stats.fallback++;
    const res = winner ? this.ledger.settle(mk, winner) : null;
    const p = res?.pos;
    const sideTxt = s => p && p[s].shares > 0 ? `${s} ${round(p[s].shares, 2)} acc a $${round(p[s].cost / p[s].shares, 3)}` : null;
    const traded = p ? [sideTxt('UP'), sideTxt('DOWN')].filter(Boolean).join(' + ') || (p.sells ? 'cerrado antes' : '—') : 'sin trade';
    const summary = {
      ts: Date.now(), market: mk.label, gammaId: mk.gammaId, question: mk.question, winner, source,
      provisional: prov, K: mk.K ?? null, Ksrc: mk.Ksrc ?? null, feeRate: mk.feeRate,
      // Para calibrar: TWAP de cierre publicado y el promedio propio de los puntos de Chainlink
      twapClose: this.clTwap.at?.(mk.endMs, 1000)?.value ?? null,
      ownAvgClose: this.pricer.clSpot?.average?.(mk.endMs, 60000, 0.8) ?? null,
      entries: p?.entries || 0, sells: p?.sells || 0, pnl: res ? res.pnl : 0,
      cash: round(this.ledger.cash, 2), equity: round(this.ledger.equity(), 2), dayPnl: round(this.ledger.day.pnl, 2),
    };
    this.ledger.append(this.ledger.marketsFile, summary);
    this.log.info(`[MERCADO] ${mk.label} ganó ${winner || '?'} (${source}) | v2: ${traded} | PnL ${summary.pnl >= 0 ? '+' : ''}$${summary.pnl.toFixed(2)} | banca $${summary.cash} | día ${summary.dayPnl >= 0 ? '+' : ''}$${summary.dayPnl}`);
  }
}

module.exports = { Resolver };
