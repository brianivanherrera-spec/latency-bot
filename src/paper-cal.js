/**
 * Paper CAL — cuenta de paper de la señal de calibración de BTC 5 min (bitácora 16/11, OK del usuario).
 * Solo paper: no cambia nada de lo que hace el bot ni de las cuentas A y B.
 *
 * Señal (la misma que mide scripts/backtest.js en [BACKTEST-CALIBRACION] anclado, tramo 120-10 s, gap 5 pts):
 *   - precio justo anclado: pAdj = mid de YES + (p del modelo − p cuando el mid tomó su valor actual); el ancla se
 *     reinicia si falta el libro de YES (como las filas vacías del backtest)
 *   - en los momentos 120, 90, 60, 30 y 10 s restantes (la primera muestra a ≤ 1 s de cada uno), con el libro de
 *     YES sano (ask ≥ bid, spread ≤ PAPER_CAL_MAX_SPREAD = 10¢): si |pAdj − mid| ≥ PAPER_CAL_GAP (5 pts),
 *     compra el lado que prefiere el modelo (pAdj > mid → UP) a su ask
 *   - un intento por mercado: el primer momento que cumple
 * Ejecución realista (como B15): orden límite = ask + PAPER_CAL_BUFFER (2¢), floor(PAPER_CAL_STAKE / límite)
 * acciones (~$5); llena con el libro REST a +PAPER_CHECK_MS (200 ms) si alcanza el tamaño hasta el límite, y paga
 * el promedio de esos niveles. Comisión taker TAKER_FEE_RATE·p·(1−p). Ganador oficial de Gamma.
 * Estado en DATA_DIR/paper-cal.json; cada intento en DATA_DIR/paper-cal-attempts.jsonl.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');
const { marketLabel } = require('./market-label');
const { fetchRestBook, restSizeUpTo, restVwapUpTo } = require('./book-check');
const logger = new Logger('PAPER-CAL');

const GAMMA = 'https://gamma-api.polymarket.com';
const POINTS = [120, 90, 60, 30, 10];
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const round2 = v => Math.round(v * 100) / 100;
const usd = v => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const px = v => (v == null ? 'n/a' : `$${v.toFixed(2)}`);

class PaperCal {
  constructor({ stateFile, attFile, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
    const dir = env.DATA_DIR || '/data';
    this.stateFile = stateFile || path.join(dir, 'paper-cal.json');
    this.attFile = attFile || path.join(dir, 'paper-cal-attempts.jsonl');
    this.fetch = fetchFn;
    this.now = now;
    this.cfg = {
      gap: num(env.PAPER_CAL_GAP, 0.05), maxSpread: num(env.PAPER_CAL_MAX_SPREAD, 0.10), stake: num(env.PAPER_CAL_STAKE, 5),
      buffer: num(env.PAPER_CAL_BUFFER, 0.02), checkMs: Math.max(0, num(env.PAPER_CHECK_MS, 200)), feeRate: num(env.TAKER_FEE_RATE, 0.072),
    };
    this.state = this._load();
    if (!fs.existsSync(this.stateFile)) this._save(); // que "desde" no se reinicie con cada arranque
    this.markets = new Map(); // gammaId → { anchor, done: Set de momentos ya mirados, tried }
    this._timers = [];
  }

  fee(p) { return this.cfg.feeRate * p * (1 - p); }

  describe() {
    const c = this.cfg;
    return `señal de calibración BTC 5 min: en ${POINTS.join('/')} s restantes, si el precio justo anclado difiere ≥ ${Math.round(c.gap * 100)} pts del mid de Sí (spread ≤ ${Math.round(c.maxSpread * 100)}¢), compra ese lado; límite ask + ${Math.round(c.buffer * 100)}¢, ~$${c.stake}, fill con el libro REST a +${c.checkMs} ms`;
  }

  start() {
    const a = setInterval(() => this._resolveStale().catch(e => logger.warn(`[PAPER-CAL] resolución: ${e.message}`)), 60000);
    const b = setInterval(() => logger.info(this.summary()), 60 * 60000);
    for (const t of [a, b]) { if (t.unref) t.unref(); this._timers.push(t); }
  }

  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }

  // Una muestra por segundo del shadow de 5 min: s = { T (s restantes), yesBid, yesAsk, noAsk, p }
  onSample(m, s) {
    let st = this.markets.get(m.gammaId);
    if (!st) {
      st = { anchor: null, done: new Set(), tried: false };
      this.markets.set(m.gammaId, st);
      if (this.markets.size > 20) this.markets.delete(this.markets.keys().next().value);
    }
    if (s.yesBid == null || s.yesAsk == null || s.p == null) { st.anchor = null; return; }
    const mid = (s.yesBid + s.yesAsk) / 2;
    if (!st.anchor || Math.abs(mid - st.anchor.mid) > 1e-9) st.anchor = { mid, p: s.p };
    if (st.tried) return;
    // Momento de control: el primero de POINTS que la muestra alcanza (≤ 1 s después), una sola vez cada uno
    const c = POINTS.find(x => !st.done.has(x) && s.T <= x + 0.5 && s.T >= x - 1);
    if (c == null) return;
    st.done.add(c);
    if (s.yesAsk < s.yesBid || s.yesAsk - s.yesBid > this.cfg.maxSpread + 1e-9) return;
    const pAdj = Math.min(0.999, Math.max(0.001, mid + (s.p - st.anchor.p)));
    const q = Math.min(0.999, Math.max(0.001, mid));
    if (Math.abs(pAdj - q) < this.cfg.gap - 1e-9) return;
    const side = pAdj > q ? 'UP' : 'DOWN';
    const ask = side === 'UP' ? s.yesAsk : s.noAsk;
    if (ask == null || ask <= 0.01 || ask >= 0.99) return;
    st.tried = true;
    st.exec = this._execute(m, side, ask, side === 'UP' ? pAdj : 1 - pAdj, side === 'UP' ? q : 1 - q, s.T, c)
      .catch(e => logger.warn(`[PAPER-CAL] ejecución: ${e.message}`));
  }

  async _execute(m, side, ask, pModel, pMkt, T, point) {
    const c = this.cfg, S = this.state;
    const tokenId = side === 'UP' ? m.yesTokenId : m.noTokenId;
    const limit = Math.min(0.99, round2(ask + c.buffer));
    const size = Math.floor(c.stake / limit);
    const t = this.now();
    await new Promise(r => setTimeout(r, c.checkMs));
    let b = null;
    try { b = await fetchRestBook(this.fetch, tokenId); } catch (_) { b = null; }
    const sz = restSizeUpTo(b, limit);
    const filled = !!b && size > 0 && b.ask != null && b.ask <= limit + 1e-9 && sz >= size;
    let paid = null;
    if (filled) {
      const v = restVwapUpTo(b, limit, size);
      paid = v.vwap != null ? Math.min(limit, +v.vwap.toFixed(4)) : limit;
    }
    const pos = { id: `PC_${t}`, gammaId: m.gammaId, market: marketLabel(m.question), start: m.endTs - 300000, endTs: m.endTs,
      side, t, point, secsLeft: Math.round(T), ask, pModel: +pModel.toFixed(4), pMkt: +pMkt.toFixed(4), limit, size,
      ask200: b?.ask ?? null, restOk: !!b, filled, paid };
    S.attempts++;
    if (filled) { S.filled++; S.open.push(pos); } else S.noFill++;
    this._save();
    try { fs.appendFileSync(this.attFile, JSON.stringify(pos) + '\n'); } catch (e) { logger.warn(`[PAPER-CAL] no se pudo registrar el intento: ${e.message}`); }
    logger.info(`[PAPER-CAL] ${side} ${pos.market} | ${pos.secsLeft} s restantes (momento ${point} s) | precio justo anclado ${(pModel * 100).toFixed(1)}% vs mercado ${(pMkt * 100).toFixed(1)}% (${((pModel - pMkt) * 100).toFixed(1)} pts) | ask ${px(ask)} | orden ${size} a ${px(limit)} | ask REST a +${c.checkMs}ms ${b ? px(b.ask) : 'sin respuesta'} → ${filled ? `lleno a ${px(paid)}` : 'no llena'} | ${this._balance()}`);
    return pos;
  }

  // Ganador oficial del mercado (lo llama el shadow al resolverlo). Solo resultados de Gamma.
  onResolved(gammaId, winner, source) {
    if ((winner !== 'UP' && winner !== 'DOWN') || !String(source || '').startsWith('gamma')) return;
    for (const p of this.state.open.filter(x => x.gammaId === gammaId)) this._close(p, winner);
  }

  _close(p, winner) {
    const S = this.state;
    if (!S.open.some(x => x.id === p.id)) return;
    const win = p.side === winner, fee = this.fee(p.paid) * p.size;
    const pnl = (win ? p.size * (1 - p.paid) : -p.size * p.paid) - fee;
    S.open = S.open.filter(x => x.id !== p.id);
    if (win) S.w++; else S.l++;
    S.pnl = +(S.pnl + pnl).toFixed(4);
    S.fees = +(S.fees + fee).toFixed(4);
    // z contra el empate: lo que hacía falta acertar para salir hechos con ese precio y comisión
    const be = Math.min(0.999, p.paid + this.fee(p.paid));
    S.exp = +(S.exp + be).toFixed(6); S.var = +(S.var + be * (1 - be)).toFixed(6);
    this._save();
    logger.info(`[PAPER-CAL] ${win ? 'WIN' : 'LOSS'} ${p.side} ${p.market} @ ${px(p.paid)} ×${p.size} → ${usd(pnl)} (comisión $${fee.toFixed(2)}) | ${this._balance()}`);
  }

  // Posiciones abiertas cuyo mercado cerró hace > 5 min y el shadow no resolvió (reinicio): se consulta Gamma
  async _resolveStale(now = this.now()) {
    const stale = this.state.open.filter(x => now - x.endTs > 5 * 60000);
    for (const gammaId of new Set(stale.map(x => x.gammaId))) {
      try {
        const res = await this.fetch(`${GAMMA}/markets/${gammaId}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const d = await res.json();
        const prices = typeof d.outcomePrices === 'string' ? JSON.parse(d.outcomePrices) : d.outcomePrices;
        const up = parseFloat(prices?.[0]), dn = parseFloat(prices?.[1]);
        if (d.closed === true && up >= 0.99) this.onResolved(gammaId, 'UP', 'gamma');
        else if (d.closed === true && dn >= 0.99) this.onResolved(gammaId, 'DOWN', 'gamma');
      } catch (_) { /* se reintenta en el próximo minuto */ }
    }
  }

  z() { const S = this.state; return S.var > 0 ? +((S.w - S.exp) / Math.sqrt(S.var)).toFixed(2) : null; }

  _balance() {
    const S = this.state;
    return `Balance CAL: ${usd(S.pnl)} (${S.w}-${S.l}${this.z() != null ? `, z ${this.z()}` : ''}), intentos ${S.attempts}, llenadas ${S.filled}, sin fill ${S.noFill}, abiertas ${S.open.length} | desde ${new Date(S.startedAt).toISOString().slice(0, 16)} UTC`;
  }

  summary() { return `[PAPER-CAL] ${this._balance()}`; }

  _load() {
    const fresh = { v: 1, startedAt: this.now(), attempts: 0, filled: 0, noFill: 0, w: 0, l: 0, pnl: 0, fees: 0, exp: 0, var: 0, open: [] };
    try {
      if (fs.existsSync(this.stateFile)) return { ...fresh, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) };
    } catch (e) { logger.warn(`[PAPER-CAL] estado ilegible (${e.message}) — empieza de cero`); }
    return fresh;
  }

  _save() {
    try {
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { logger.warn(`[PAPER-CAL] no se pudo guardar el estado: ${e.message}`); }
  }
}

module.exports = { PaperCal, POINTS };
