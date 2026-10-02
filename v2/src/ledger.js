'use strict';
// Banca y posiciones del paper. Todo en USDC. Persiste estado y cada fill/mercado en DATA_DIR.
const fs = require('fs');
const path = require('path');
const { round } = require('./math');

class Ledger {
  constructor({ cfg, log }) {
    this.cfg = cfg; this.log = log;
    this.dir = cfg.DATA_DIR;
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
    this.stateFile = path.join(this.dir, 'v2-state.json');
    this.fillsFile = path.join(this.dir, 'v2-fills.jsonl');
    this.marketsFile = path.join(this.dir, 'v2-markets.jsonl');
    this.cash = cfg.PAPER_BANKROLL;
    this.positions = {};           // gammaId → { label, UP:{shares,cost,fees}, DOWN:{...}, entries, lastEntryAt, realized }
    this.day = { date: null, pnl: 0 };
    this.totals = { fills: 0, fees: 0, realized: 0, markets: 0 };
    this._load();
  }

  // Sin archivo = primer arranque. Archivo ilegible = NO es primer arranque: antes el catch
  // lo trataba igual y reseteaba la banca a $100 sin aviso. Ahora se guarda una copia
  // .corrupt, se loguea y se aborta para revisarlo a mano.
  _load() {
    let raw;
    try { raw = fs.readFileSync(this.stateFile, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return; // primer arranque
      throw e;
    }
    let s;
    try { s = JSON.parse(raw); if (!s || typeof s.cash !== 'number') throw new Error('sin campo cash'); }
    catch (e) {
      const bad = `${this.stateFile}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.stateFile, bad); } catch (_) {}
      this.log.error(`Estado corrupto en ${this.stateFile} (${e.message}) — copia en ${bad}. Se aborta para no resetear la banca.`);
      throw new Error(`estado corrupto: ${e.message}`);
    }
    Object.assign(this, { cash: s.cash, positions: s.positions || {}, day: s.day || this.day, totals: s.totals || this.totals });
    this.log.info(`Estado recuperado: banca $${this.cash.toFixed(2)}, ${Object.keys(this.positions).length} posiciones abiertas`);
  }

  // Sincrónico (writeFileSync + renameSync): dos save() asíncronos en vuelo escribían el
  // mismo .tmp a la vez y podían dejar el archivo corrupto
  save() {
    const tmp = this.stateFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ cash: this.cash, positions: this.positions, day: this.day, totals: this.totals }));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { this.log.error(`save: ${e.message}`); }
  }

  append(file, obj) { fs.promises.appendFile(file, JSON.stringify(obj) + '\n').catch(e => this.log.warn(`append: ${e.message}`)); }

  _rollDay(now = Date.now()) {
    const d = new Date(now).toISOString().slice(0, 10);
    if (this.day.date !== d) this.day = { date: d, pnl: 0 };
  }

  pos(mk) {
    if (!this.positions[mk.gammaId]) {
      this.positions[mk.gammaId] = { label: mk.label, startMs: mk.startMs, UP: { shares: 0, cost: 0, fees: 0 }, DOWN: { shares: 0, cost: 0, fees: 0 }, entries: 0, lastEntryAt: 0, realized: 0, sells: 0 };
    }
    return this.positions[mk.gammaId];
  }

  exposure(gammaId) {
    const list = gammaId ? [this.positions[gammaId]].filter(Boolean) : Object.values(this.positions);
    return list.reduce((s, p) => s + p.UP.cost + p.UP.fees + p.DOWN.cost + p.DOWN.fees, 0);
  }

  equity() { return this.cash + this.exposure(); } // posiciones a costo

  dailyLossHit(now = Date.now()) { this._rollDay(now); return this.day.pnl <= -this.cfg.DAILY_LOSS_LIMIT_USD; }

  recordBuy(mk, side, fill, meta) {
    const p = this.pos(mk), s = p[side];
    s.shares += fill.shares; s.cost += fill.cost; s.fees += fill.fee;
    this.cash -= fill.cost + fill.fee;
    p.entries++; p.lastEntryAt = Date.now();
    this.totals.fills++; this.totals.fees += fill.fee;
    this.append(this.fillsFile, { ts: Date.now(), market: mk.label, gammaId: mk.gammaId, action: 'BUY', side, ...fill, ...meta });
    this.save();
  }

  recordSell(mk, side, fill, meta) {
    const p = this.pos(mk), s = p[side];
    const frac = fill.shares / s.shares;
    const basis = (s.cost + s.fees) * frac;
    const pnl = fill.proceeds - fill.fee - basis;
    s.cost *= (1 - frac); s.fees *= (1 - frac); s.shares -= fill.shares;
    // Polvo de redondeo (p. ej. 1e-12 acciones) contaba como posición y bloqueaba entradas
    if (s.shares < 1e-6) { s.shares = 0; s.cost = 0; s.fees = 0; }
    this.cash += fill.proceeds - fill.fee;
    p.realized += pnl; p.sells++;
    this._rollDay(); this.day.pnl += pnl;
    this.totals.fills++; this.totals.fees += fill.fee; this.totals.realized += pnl;
    this.append(this.fillsFile, { ts: Date.now(), market: mk.label, gammaId: mk.gammaId, action: 'SELL', side, ...fill, pnl: round(pnl, 4), ...meta });
    this.save();
    return pnl;
  }

  // Liquidación al resolverse el mercado. Devuelve el resumen de PnL del mercado.
  settle(mk, winner) {
    const p = this.positions[mk.gammaId];
    if (!p) return null;
    let pnl = p.realized;
    for (const side of ['UP', 'DOWN']) {
      const s = p[side];
      if (s.shares <= 0) continue;
      const payout = side === winner ? s.shares : 0;
      this.cash += payout;
      const r = payout - s.cost - s.fees;
      pnl += r;
      this._rollDay(); this.day.pnl += r; this.totals.realized += r;
    }
    this.totals.markets++;
    delete this.positions[mk.gammaId];
    this.save();
    return { pnl: round(pnl, 4), pos: p };
  }
}

module.exports = { Ledger };
