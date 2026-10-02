'use strict';
// Decisión del v2. Una sola regla, sin filtros sueltos:
//   comprar un lado solo si  P(lado) − precio − comisión(precio) ≥ EDGE_MIN   (por acción)
// Se recorre el libro nivel por nivel y se toma cada nivel que cumple la regla.
// Tamaño: fracción de Kelly sobre la banca, con topes por orden, por mercado y total.
// Salida: si el bid − comisión supera P(lado) + EXIT_EDGE, el mercado paga de más → vender.
const fs = require('fs');
const path = require('path');
const { takerFee, round } = require('./math');

class Strategy {
  constructor({ cfg, log, pricer, ledger, executor }) {
    Object.assign(this, { cfg, log, pricer, ledger, executor });
    this.busy = new Set();            // mercados con una orden en vuelo
    this.evalFile = path.join(cfg.DATA_DIR, 'v2-evals.jsonl');
    this.lastEvalLog = new Map();     // gammaId → último segundo registrado
    this.skips = {};                  // motivo → cantidad (para /status)
  }

  _skip(r) { this.skips[r] = (this.skips[r] || 0) + 1; return null; }

  // Recorre asks mientras cada nivel deje ventaja ≥ EDGE_MIN después de comisión
  plan(mk, side, q) {
    const levels = mk.book.levels(side, 'asks');
    let shares = 0, cost = 0, fee = 0, limit = null;
    for (const l of levels) {
      const ev = q - l.price - takerFee(l.price, mk.feeRate);
      if (ev < this.cfg.EDGE_MIN) break;
      shares += l.size; cost += l.price * l.size; fee += takerFee(l.price, mk.feeRate) * l.size; limit = l.price;
    }
    if (!shares) return null;
    const c = (cost + fee) / shares;                 // costo efectivo por acción
    return { side, q, shares, limit, c, ev: q - c, expProfit: (q - c) * shares };
  }

  evaluate(mk, now = Date.now()) {
    if (!mk.book || this.busy.has(mk.gammaId)) return;
    const secsLeft = (mk.endMs - now) / 1000;
    if (now < mk.startMs || secsLeft <= 0) return;
    if (!mk.book.healthy(now)) return this._skip('libro_no_listo');

    const f = this.pricer.fair(mk, now);
    if (f.reason) return this._skip(f.reason);
    const qUp = f.pUp, pos = this.ledger.positions[mk.gammaId];
    this._logEval(mk, f, now);

    // 1) Salida anticipada (paper): el mercado paga por lo que tenemos más de lo que vale
    if (this.cfg.EXIT_ENABLED && pos) {
      for (const side of ['UP', 'DOWN']) {
        const held = pos[side].shares;
        if (held <= 0) continue;
        const q = side === 'UP' ? qUp : 1 - qUp;
        const bids = mk.book.levels(side, 'bids');
        let sh = 0, limit = null;
        for (const l of bids) {
          if (l.price - takerFee(l.price, mk.feeRate) - q < this.cfg.EXIT_EDGE) break;
          sh += l.size; limit = l.price;
          if (sh >= held) break;
        }
        // Polymarket no acepta órdenes de menos de 5 acciones (mk.minShares)
        const sellSh = Math.min(sh, held);
        if (sellSh >= (mk.minShares || this.cfg.MIN_ORDER_SHARES_DEFAULT)) {
          this.busy.add(mk.gammaId);
          this.executor.sell(mk, side, sellSh, limit, {
            q: round(q, 4), secsLeft: Math.round(secsLeft), reason: 'mercado_paga_de_mas',
            onResult: () => this.busy.delete(mk.gammaId),
          });
          return;
        }
      }
    }

    // 2) Entrada
    if (secsLeft < this.cfg.MIN_SECS_LEFT || secsLeft > this.cfg.MAX_SECS_LEFT) return this._skip('fuera_de_ventana');
    if (this.ledger.dailyLossHit(now)) return this._skip('limite_perdida_diaria');
    if (pos && pos.entries >= this.cfg.MAX_ENTRIES_PER_MARKET) return this._skip('max_entradas_mercado');
    if (pos && now - pos.lastEntryAt < this.cfg.ENTRY_COOLDOWN_MS) return this._skip('cooldown');

    const plans = [this.plan(mk, 'UP', qUp), this.plan(mk, 'DOWN', 1 - qUp)].filter(Boolean);
    if (!plans.length) return this._skip('sin_ventaja');
    // No abrir el lado contrario de lo que ya tenemos (evita cubrirse a pérdida)
    const allowed = plans.filter(p => !pos || pos[p.side === 'UP' ? 'DOWN' : 'UP'].shares <= 0);
    if (!allowed.length) return this._skip('lado_contrario_abierto');
    const best = allowed.sort((a, b) => b.expProfit - a.expProfit)[0];

    // Tamaño: fracción de Kelly para una apuesta binaria que paga 1 y cuesta c
    const kelly = Math.max(0, (best.q - best.c) / (1 - best.c));
    const bank = this.ledger.equity();
    const roomMarket = this.cfg.MAX_MARKET_EXPOSURE_USD - this.ledger.exposure(mk.gammaId);
    const roomTotal = this.cfg.MAX_TOTAL_EXPOSURE_USD - this.ledger.exposure();
    const stake = Math.min(bank * this.cfg.KELLY_FRACTION * kelly, this.cfg.MAX_STAKE_USD, roomMarket, roomTotal, this.ledger.cash);
    let shares = Math.floor(Math.min(best.shares, stake / best.c) * 100) / 100;
    // Mínimo de Polymarket (orderMinSize, ~5 acciones): si Kelly pide al menos la mitad del
    // mínimo, se redondea al mínimo (si hay liquidez y margen); si pide menos, no se entra.
    const minCost = mk.minShares * best.c;
    if (shares < mk.minShares && stake >= 0.5 * minCost && best.shares >= mk.minShares
        && minCost <= Math.min(this.cfg.MAX_STAKE_USD, roomMarket, roomTotal, this.ledger.cash)) shares = mk.minShares;
    if (shares < mk.minShares) return this._skip(stake <= 0 ? 'sin_margen_de_riesgo' : 'tamano_menor_al_minimo');

    this.busy.add(mk.gammaId);
    this.executor.buy(mk, best.side, shares, best.limit, {
      q: round(best.q, 4), ev: round(best.ev, 4), kelly: round(kelly, 4), secsLeft: Math.round(secsLeft),
      K: f.K, Ksrc: f.Ksrc, mean: f.mean, sd: f.sd, basis: f.basis,
      onResult: () => this.busy.delete(mk.gammaId),
    });
  }

  // Una línea por segundo por mercado con lo que vio el modelo (para analizar después)
  _logEval(mk, f, now) {
    const sec = Math.floor(now / 1000);
    if (this.lastEvalLog.get(mk.gammaId) === sec) return;
    this.lastEvalLog.set(mk.gammaId, sec);
    const u = mk.book.best('UP'), d = mk.book.best('DOWN');
    const row = [sec, round(f.secsLeft, 1), round(f.pUp, 4), f.mean, f.sd, u.bid, u.ask, d.bid, d.ask];
    fs.promises.appendFile(this.evalFile, JSON.stringify({ m: mk.gammaId, r: row }) + '\n').catch(() => {});
  }
}

module.exports = { Strategy };
