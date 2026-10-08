/**
 * Chequeo del libro: cada BOOK_CHECK_MS (30 s) compara el mejor bid/ask que el bot tiene por el
 * WebSocket de Polymarket con el libro que devuelve en ese momento la API REST del CLOB, para los
 * dos tokens (Sí/No) del mercado en curso. Solo registro: no cambia ninguna decisión.
 * El libro cambia en milisegundos: se lee el WS antes y después de la consulta REST (los dos tokens
 * a la vez) y cuenta como igual si alguna de las dos lecturas coincide con el REST. Si difiere más
 * de 1¢ se separa en: libro moviéndose (el WS cambió durante la consulta: es el tiempo, no un
 * error) y libro quieto (el WS no cambió y el REST dice otra cosa: diferencia real).
 * También registra el retraso de entrega del WS en ese momento (hora local − timestamp del servidor
 * del último mensaje): si el WS llega atrasado, la diferencia es del WS y no del REST.
 * Logs: [BOOK-CHECK] con detalle cuando difiere más de 1¢, y un resumen cada BOOK_CHECK_SUMMARY_MIN (15).
 */
'use strict';
const { Logger } = require('./logger');
const logger = new Logger('BOOK-CHECK');

const HOST = process.env.CLOB_API_BASE || 'https://clob.polymarket.com';
const px = v => (v == null ? '—' : `$${Number(v).toFixed(v < 0.01 || v > 0.99 ? 3 : 2)}`);

class BookCheck {
  constructor({ polyWs, fetchFn = globalThis.fetch, intervalMs = parseInt(process.env.BOOK_CHECK_MS || '30000'),
    summaryMin = parseFloat(process.env.BOOK_CHECK_SUMMARY_MIN || '15') } = {}) {
    this.poly = polyWs;
    this.fetch = fetchFn;
    this.intervalMs = intervalMs;
    this.summaryMin = summaryMin;
    this._reset();
    this._timers = [];
  }

  _reset() { this.s = { n: 0, same: 0, oneCent: 0, more: 0, moreMoving: 0, moreStill: 0, restErr: 0, wsMissing: 0, restMs: [], restAge: [], wsLag: [], since: Date.now() }; }

  start() {
    if (!(this.intervalMs > 0)) return;
    const a = setInterval(() => this.checkOnce().catch(e => logger.warn(`[BOOK-CHECK] ${e.message}`)), this.intervalMs);
    const b = setInterval(() => { logger.info(this.summary()); this._reset(); }, this.summaryMin * 60000);
    for (const t of [a, b]) { if (t.unref) t.unref(); this._timers.push(t); }
  }

  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }

  _ws(tokenId) {
    const r = this.poly?._topOfBook?.get(tokenId);
    if (!r) return null;
    return { bid: r.bestBid ?? null, ask: r.bestAsk ?? null, age: Date.now() - r.updatedAt };
  }

  async _rest(tokenId) {
    const t0 = Date.now();
    const res = await this.fetch(`${HOST}/book?token_id=${tokenId}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.json();
    const nums = arr => (arr || []).map(x => parseFloat(x.price)).filter(Number.isFinite);
    const bids = nums(b.bids), asks = nums(b.asks);
    const ts = Number(b.timestamp); // hora del snapshot según Polymarket (ms)
    return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null, ms: Date.now() - t0,
      age: Number.isFinite(ts) && ts > 1e12 ? Date.now() - ts : null };
  }

  // Mayor diferencia entre bid y ask; un lado vacío en uno y con precio en el otro cuenta como 1.
  // Un ask a $1.00 o un bid a $0 no son ofertas operables (en mercados decididos el WS puede
  // mostrar el ask a $1.00 y el REST ninguno): cuentan como lado vacío.
  static diff(w, r) {
    const ask = v => (v != null && v >= 0.9995 ? null : v), bid = v => (v != null && v <= 0.0005 ? null : v);
    const d = (a, b) => (a == null && b == null ? 0 : a == null || b == null ? 1 : Math.abs(a - b));
    return Math.max(d(bid(w.bid), bid(r.bid)), d(ask(w.ask), ask(r.ask)));
  }

  async checkOnce() {
    const P = this.poly;
    if (!P?._connected || !P._yesTokenId || !P._noTokenId) return;
    const toks = [['Sí', P._yesTokenId], ['No', P._noTokenId]];
    // Retraso del WS: el del último mensaje, si llegó hace menos de 5 s
    const lag = Number.isFinite(P._lastLagMs) && Date.now() - (P._lastLagAt || 0) < 5000 ? P._lastLagMs : null;
    if (lag != null) this.s.wsLag.push(lag);
    const before = toks.map(([, t]) => this._ws(t));
    const rest = await Promise.all(toks.map(([, t]) => this._rest(t).catch(() => null)));
    const after = toks.map(([, t]) => this._ws(t));
    toks.forEach(([side], i) => {
      const r = rest[i];
      if (!r) { this.s.restErr++; return; }
      this.s.restMs.push(r.ms);
      if (r.age != null) this.s.restAge.push(r.age);
      const ws = [before[i], after[i]].filter(Boolean);
      if (!ws.length) { this.s.wsMissing++; return; }
      const best = ws.reduce((a, w) => (BookCheck.diff(w, r) < BookCheck.diff(a, r) ? w : a));
      const d = BookCheck.diff(best, r);
      this.s.n++;
      if (d < 0.0005) { this.s.same++; return; }
      if (d <= 0.0105) { this.s.oneCent++; return; }
      this.s.more++;
      const moving = !before[i] || !after[i] || BookCheck.diff(before[i], after[i]) >= 0.0005;
      if (moving) this.s.moreMoving++; else this.s.moreStill++;
      logger.warn(`[BOOK-CHECK] ⚠️ ${side} ${moving ? '(libro moviéndose)' : '(libro QUIETO)'}: WS antes ${px(before[i]?.bid)}/${px(before[i]?.ask)} después ${px(after[i]?.bid)}/${px(after[i]?.ask)} vs REST ${px(r.bid)}/${px(r.ask)} (respuesta ${r.ms} ms${r.age != null ? `, snapshot de hace ${r.age} ms` : ''}${lag != null ? `, retraso del WS ${lag} ms` : ''})`);
    });
  }

  summary() {
    const s = this.s, ms = [...s.restMs].sort((a, b) => a - b);
    const pct = v => (s.n ? `${(v / s.n * 100).toFixed(1)}%` : 'n/a');
    const mins = Math.round((Date.now() - s.since) / 60000);
    const ages = [...s.restAge].sort((a, b) => a - b);
    const lags = [...s.wsLag].sort((a, b) => a - b);
    return `[BOOK-CHECK] últimos ${mins} min, libro del WS vs API REST de Polymarket (Sí y No, cada ${Math.round(this.intervalMs / 1000)} s): n=${s.n} | iguales ${s.same} (${pct(s.same)}) | 1¢ de diferencia ${s.oneCent} (${pct(s.oneCent)}) | más de 1¢ ${s.more} (con el libro moviéndose ${s.moreMoving}, con el libro quieto ${s.moreStill}) | REST sin respuesta ${s.restErr} | WS sin dato ${s.wsMissing} | REST p50 ${ms.length ? ms[Math.floor(ms.length / 2)] : 'n/a'} ms, snapshot REST de hace p50 ${ages.length ? ages[Math.floor(ages.length / 2)] : 'n/a'} ms | retraso del WS al chequear p50 ${lags.length ? lags[Math.floor(lags.length / 2)] : 'n/a'} ms, máx ${lags.length ? lags[lags.length - 1] : 'n/a'} ms`;
  }
}

module.exports = { BookCheck };
