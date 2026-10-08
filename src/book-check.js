/**
 * Chequeo del libro: cada BOOK_CHECK_MS (30 s) compara el mejor bid/ask que el bot tiene por el
 * WebSocket de Polymarket con el libro que devuelve en ese momento la API REST del CLOB, para los
 * dos tokens (Sí/No) del mercado en curso. Solo registro: no cambia ninguna decisión.
 * El libro cambia en milisegundos: se lee el WS antes y después de la consulta REST (los dos tokens
 * a la vez) y cuenta como igual si alguna de las dos lecturas coincide con el REST. Si difiere más
 * de 1¢ se separa en: libro moviéndose (el WS cambió durante la consulta: es el tiempo), WS
 * atrasado (el WS no cambió pero sus mensajes llegaban con ≥ BOOK_CHECK_LAG_MS de retraso: el
 * servidor nos manda los datos tarde) y WS al día (ni se movió ni estaba atrasado: diferencia real,
 * a investigar). El retraso es hora local − timestamp del servidor del último mensaje del WS; se
 * muestra también cuánto antes que la foto del REST se fijó el top del WS (topTs, hora del servidor).
 * fetchRestBook/restSizeUpTo/restVwapUpTo los usa también el paper para comparar cada intento con el REST.
 * Logs: [BOOK-CHECK] con detalle cuando difiere más de 1¢, y un resumen cada BOOK_CHECK_SUMMARY_MIN (15).
 */
'use strict';
const { Logger } = require('./logger');
const logger = new Logger('BOOK-CHECK');

const HOST = process.env.CLOB_API_BASE || 'https://clob.polymarket.com';
const px = v => (v == null ? '—' : `$${Number(v).toFixed(v < 0.01 || v > 0.99 ? 3 : 2)}`);

// Libro de un token por la API REST del CLOB: niveles ordenados (asks de menor a mayor, bids de
// mayor a menor), mejor bid/ask, hora del snapshot según Polymarket (ts), demora de la respuesta
// (ms) y edad del snapshot al recibirlo (age)
async function fetchRestBook(fetchFn, tokenId, timeoutMs = 3000) {
  const t0 = Date.now();
  const res = await fetchFn(`${HOST}/book?token_id=${tokenId}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b = await res.json();
  const lv = arr => (arr || []).map(x => [parseFloat(x.price), parseFloat(x.size)]).filter(([p, z]) => Number.isFinite(p) && Number.isFinite(z) && z > 0);
  const asks = lv(b.asks).sort((x, y) => x[0] - y[0]), bids = lv(b.bids).sort((x, y) => y[0] - x[0]);
  const ts = Number(b.timestamp);
  const now = Date.now();
  return { asks, bids, bid: bids.length ? bids[0][0] : null, ask: asks.length ? asks[0][0] : null, ms: now - t0,
    ts: Number.isFinite(ts) && ts > 1e12 ? ts : null, age: Number.isFinite(ts) && ts > 1e12 ? now - ts : null };
}

// Acciones ofrecidas en el REST hasta el precio límite (lo que una compra a ese límite podría llenar)
function restSizeUpTo(book, limit) {
  if (!book) return null;
  let n = 0;
  for (const [p, z] of book.asks) { if (p > limit + 1e-9) break; n += z; }
  return n;
}

// Precio promedio de comprar `size` acciones en el libro REST sin pasar del límite → { vwap, filled }
function restVwapUpTo(book, limit, size) {
  if (!book || !(size > 0)) return { vwap: null, filled: 0 };
  let got = 0, cost = 0;
  for (const [p, z] of book.asks) {
    if (p > limit + 1e-9 || got >= size) break;
    const take = Math.min(z, size - got);
    got += take; cost += take * p;
  }
  return { vwap: got > 0 ? cost / got : null, filled: got };
}

class BookCheck {
  constructor({ polyWs, fetchFn = globalThis.fetch, intervalMs = parseInt(process.env.BOOK_CHECK_MS || '30000'),
    summaryMin = parseFloat(process.env.BOOK_CHECK_SUMMARY_MIN || '15'), lagMs = parseInt(process.env.BOOK_CHECK_LAG_MS || '100') } = {}) {
    this.poly = polyWs;
    this.fetch = fetchFn;
    this.intervalMs = intervalMs;
    this.summaryMin = summaryMin;
    this.lagMs = lagMs;
    this._reset();
    this._timers = [];
  }

  _reset() { this.s = { n: 0, same: 0, oneCent: 0, more: 0, moreMoving: 0, moreLagged: 0, moreReal: 0, restErr: 0, wsMissing: 0, restMs: [], restAge: [], wsLag: [], since: Date.now() }; }

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
    return { bid: r.bestBid ?? null, ask: r.bestAsk ?? null, age: Date.now() - r.updatedAt, topTs: r.topTs ?? null };
  }

  _rest(tokenId) { return fetchRestBook(this.fetch, tokenId); }

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
      const lagged = !moving && lag != null && lag >= this.lagMs;
      if (moving) this.s.moreMoving++; else if (lagged) this.s.moreLagged++; else this.s.moreReal++;
      const kind = moving ? '(libro moviéndose)' : lagged ? `(WS atrasado ${lag} ms)` : '(WS al día: diferencia REAL)';
      const topAge = r.ts != null && after[i]?.topTs != null ? r.ts - after[i].topTs : null;
      logger.warn(`[BOOK-CHECK] ⚠️ ${side} ${kind}: WS antes ${px(before[i]?.bid)}/${px(before[i]?.ask)} después ${px(after[i]?.bid)}/${px(after[i]?.ask)} vs REST ${px(r.bid)}/${px(r.ask)} (respuesta ${r.ms} ms${r.age != null ? `, snapshot de hace ${r.age} ms` : ''}${lag != null ? `, retraso del WS ${lag} ms` : ''}${topAge != null ? `, top del WS fijado ${topAge} ms antes que la foto del REST` : ''})`);
    });
  }

  summary() {
    const s = this.s, ms = [...s.restMs].sort((a, b) => a - b);
    const pct = v => (s.n ? `${(v / s.n * 100).toFixed(1)}%` : 'n/a');
    const mins = Math.round((Date.now() - s.since) / 60000);
    const ages = [...s.restAge].sort((a, b) => a - b);
    const lags = [...s.wsLag].sort((a, b) => a - b);
    return `[BOOK-CHECK] últimos ${mins} min, libro del WS vs API REST de Polymarket (Sí y No, cada ${Math.round(this.intervalMs / 1000)} s): n=${s.n} | iguales ${s.same} (${pct(s.same)}) | 1¢ de diferencia ${s.oneCent} (${pct(s.oneCent)}) | más de 1¢ ${s.more} (con el libro moviéndose ${s.moreMoving}, con el WS atrasado ${s.moreLagged}, con el WS al día ${s.moreReal}) | REST sin respuesta ${s.restErr} | WS sin dato ${s.wsMissing} | REST p50 ${ms.length ? ms[Math.floor(ms.length / 2)] : 'n/a'} ms, snapshot REST de hace p50 ${ages.length ? ages[Math.floor(ages.length / 2)] : 'n/a'} ms | retraso del WS al chequear p50 ${lags.length ? lags[Math.floor(lags.length / 2)] : 'n/a'} ms, máx ${lags.length ? lags[lags.length - 1] : 'n/a'} ms`;
  }
}

module.exports = { BookCheck, fetchRestBook, restSizeUpTo, restVwapUpTo };
