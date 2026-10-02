'use strict';
// Ejecución simulada con realismo:
//  - la orden llega al libro SIM_LATENCY_MS después de la decisión (el libro puede haber cambiado)
//  - se llena contra los niveles reales del libro hasta el precio límite (FAK: lo que no llena, se cancela)
//  - la liquidez que "tomamos" no se vuelve a usar hasta que ese nivel cambie en el WebSocket
//  - se cobra la comisión de taker de Polymarket en cada fill
const { takerFee, round } = require('./math');

class PaperExecutor {
  constructor({ cfg, log, ledger, setTimeoutFn = setTimeout }) {
    Object.assign(this, { cfg, log, ledger, setTimeoutFn });
    this.pending = 0;
  }

  // Walk del libro: compra hasta `shares` a precio ≤ limit (asks) o vende a ≥ limit (bids)
  static walk(levels, shares, limit, isBuy) {
    const fills = []; let left = shares;
    for (const l of levels) {
      if (left <= 1e-9) break;
      if (isBuy ? l.price > limit + 1e-9 : l.price < limit - 1e-9) break;
      const q = Math.min(left, l.size);
      fills.push({ price: l.price, shares: q });
      left -= q;
    }
    return fills;
  }

  buy(mk, side, shares, limit, meta = {}) {
    this.pending++;
    this.setTimeoutFn(() => {
      this.pending--;
      if (!mk.book) { meta.onResult?.(null); return; }
      const fills = PaperExecutor.walk(mk.book.levels(side, 'asks'), shares, limit, true);
      const got = fills.reduce((s, f) => s + f.shares, 0);
      if (got < mk.minShares - 1e-9) { this.log.info(`[NO-FILL] BUY ${side} ${mk.label}: ${got.toFixed(2)}/${shares} acciones ≤ $${limit} (el libro se movió)`); meta.onResult?.(null); return; }
      let cost = 0, fee = 0;
      for (const f of fills) { mk.book.consume(side, 'asks', f.price, f.shares); cost += f.price * f.shares; fee += takerFee(f.price, mk.feeRate) * f.shares; }
      const fill = { shares: round(got, 4), avgPrice: round(cost / got, 4), cost: round(cost, 4), fee: round(fee, 4), limit, requested: shares };
      const { onResult, ...rest } = meta;
      this.ledger.recordBuy(mk, side, fill, rest);
      this.log.info(`[FILL] BUY ${side} ${mk.label} ${fill.shares} @ $${fill.avgPrice} (comisión $${fill.fee}) | P=${rest.q} EV/acc=${rest.ev} | faltan ${rest.secsLeft}s`);
      onResult?.(fill);
    }, this.cfg.SIM_LATENCY_MS);
  }

  sell(mk, side, shares, limit, meta = {}) {
    this.pending++;
    this.setTimeoutFn(() => {
      this.pending--;
      if (!mk.book) { meta.onResult?.(null); return; }
      const held = this.ledger.positions[mk.gammaId]?.[side]?.shares || 0;
      const fills = PaperExecutor.walk(mk.book.levels(side, 'bids'), Math.min(shares, held), limit, false);
      const got = fills.reduce((s, f) => s + f.shares, 0);
      const minSh = mk.minShares || this.cfg.MIN_ORDER_SHARES_DEFAULT;
      if (got < minSh - 1e-9) { // menos del mínimo de Polymarket: en real la orden se rechaza
        if (got > 1e-9) this.log.info(`[NO-FILL] SELL ${side} ${mk.label}: ${got.toFixed(2)} acciones < mínimo ${minSh}`);
        meta.onResult?.(null); return;
      }
      let proceeds = 0, fee = 0;
      for (const f of fills) { mk.book.consume(side, 'bids', f.price, f.shares); proceeds += f.price * f.shares; fee += takerFee(f.price, mk.feeRate) * f.shares; }
      const fill = { shares: round(got, 4), avgPrice: round(proceeds / got, 4), proceeds: round(proceeds, 4), fee: round(fee, 4), limit };
      const { onResult, ...rest } = meta;
      const pnl = this.ledger.recordSell(mk, side, fill, rest);
      this.log.info(`[FILL] SELL ${side} ${mk.label} ${fill.shares} @ $${fill.avgPrice} → PnL $${pnl.toFixed(3)} | P=${rest.q}`);
      onResult?.(fill);
    }, this.cfg.SIM_LATENCY_MS);
  }
}

module.exports = { PaperExecutor };
