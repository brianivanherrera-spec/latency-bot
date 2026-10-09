/**
 * Paper B — segunda cuenta de paper con la regla "anclada", en paralelo a la del bot. No cambia
 * nada de lo que hace el bot: solo simula sus propias entradas y lleva su propio balance, para
 * comparar las dos reglas con la misma ejecución. Elegida por el backtest ([BACKTEST-ANCLA] del
 * 08/10: test n=45 +9.9¢/acc z 1.6, la única familia con resultado fuera de muestra positivo).
 *
 * Regla (la misma que scripts/backtest.js evalúa con kind 'anchored'):
 *   - precio justo anclado: pAdj = mid de YES + (p del modelo − p del modelo cuando el mid tomó
 *     su valor actual). El ancla se reinicia si falta el libro de YES o el modelo con TWAP de
 *     Chainlink (como las filas vacías del backtest).
 *   - entre PAPER_B_TMIN y PAPER_B_TMAX segundos restantes (30-120), ask del lado entre
 *     PAPER_B_MIN_ASK y PAPER_B_MAX_ASK (0.30-0.70) y pAdj del lado − ask − comisión ≥ PAPER_B_EDGE (0.08)
 *   - un intento por mercado: el primero que cumple, UP antes que DOWN
 * Ejecución como el paper del bot: límite = ask + ORDER_LIMIT_BUFFER (tope PAPER_B_MAX_ASK + 0.02),
 * tamaño floor(PAPER_B_STAKE / límite); se mira el libro a +PAPER_CHECK_MS (200, solo registro: lo
 * que tardaría una orden real) y a +PAPER_B_DELAY_MS (400): llena si el ask sigue ≤ límite y
 * alcanza el tamaño, y paga max(ask al decidir + tick, promedio del libro hasta el límite).
 * Comisión taker TAKER_FEE_RATE·p·(1−p) por acción. Se resuelve con el ganador oficial (Gamma).
 * Estado en DATA_DIR/paper-b.json: sobrevive reinicios (se guarda desde el arranque).
 * En cada mercado sin entrada deja una línea con la mejor ventaja que vio en la ventana (para ver
 * que la cuenta está viva y qué tan cerca quedó). En cada intento pide además el libro por la API
 * REST al decidir y al momento del fill (PAPER_REST_CHECK, solo registro: el fill sigue siendo el del WS);
 * el balance suma la cuenta "con el libro REST": las llenadas al precio del REST, sin las que según el REST
 * no llenaban y con las que solo llenaba el REST. Límite de la orden: PAPER_B_LIMIT=buffer (ask + buffer)
 * o fair (hasta donde queda PAPER_B_LIMIT_MARGIN de ventaja contra el precio justo anclado).
 * Precio viejo del WS: si el libro REST pedido al decidir ya tiene el ask más de PAPER_B_REST_GUARD_TOL (2¢)
 * arriba del WS, el disparo salió de un libro atrasado. Por defecto solo se mide (entra igual y se cuenta
 * aparte: el backtest no muestra que esas entradas pierdan); con PAPER_B_REST_GUARD=on no se manda la orden
 * y se anota cómo habría salido (en vivo el chequeo sumaría lo que tarda el REST, ~40 ms).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');
const { marketLabel } = require('./market-label');
const { fetchRestBook, restSizeUpTo, restVwapUpTo } = require('./book-check');
const logger = new Logger('PAPER-B');

const GAMMA = 'https://gamma-api.polymarket.com';
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const round2 = v => Math.round(v * 100) / 100;
const usd = v => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const px = v => (v == null ? 'n/a' : `$${v.toFixed(2)}`);

class PaperB {
  constructor({ polyWs, stateFile, env = process.env, fetchFn = globalThis.fetch } = {}) {
    this.poly = polyWs;
    this.stateFile = stateFile || path.join(env.DATA_DIR || '/data', 'paper-b.json');
    this.fetch = fetchFn;
    const c = this.cfg = {
      edge: num(env.PAPER_B_EDGE, 0.08), lo: num(env.PAPER_B_MIN_ASK, 0.30), hi: num(env.PAPER_B_MAX_ASK, 0.70),
      tMax: num(env.PAPER_B_TMAX, 120), tMin: num(env.PAPER_B_TMIN, 30), stake: num(env.PAPER_B_STAKE, 5),
      delayMs: Math.max(0, num(env.PAPER_B_DELAY_MS, 400)), buffer: num(env.ORDER_LIMIT_BUFFER, 0.02),
      feeRate: num(env.TAKER_FEE_RATE, 0.072),
      // Límite de la orden: 'buffer' = ask + ORDER_LIMIT_BUFFER; 'fair' = paga hasta donde todavía queda
      // PAPER_B_LIMIT_MARGIN de ventaja contra el precio justo anclado (neta de comisión). Tope en los dos: max + 2¢
      limitMode: env.PAPER_B_LIMIT === 'fair' ? 'fair' : 'buffer', margin: num(env.PAPER_B_LIMIT_MARGIN, 0.02),
      // Precio viejo del WS (REST al decidir con el ask más de restGuardTol arriba del WS): on = no entra; por defecto solo se mide
      restGuard: env.PAPER_B_REST_GUARD === 'on', restGuardTol: num(env.PAPER_B_REST_GUARD_TOL, 0.02),
    };
    c.checkMs = Math.min(c.delayMs, Math.max(0, num(env.PAPER_CHECK_MS, 200)));
    c.cap = round2(c.hi + 0.02);
    this.restCheck = env.PAPER_REST_CHECK !== 'false';
    this.state = this._load();
    if (!fs.existsSync(this.stateFile)) this._save(); // que "desde" no se reinicie con cada arranque
    this.markets = new Map(); // gammaId → { anchor, tried, inWin, withData, best }
    this._last = null;        // mercado en curso (para reportarlo cuando empieza el siguiente)
    this._timers = [];
  }

  fee(p) { return this.cfg.feeRate * p * (1 - p); }

  describe() {
    const c = this.cfg;
    const lim = c.limitMode === 'fair' ? `límite = precio justo − comisión − ${Math.round(c.margin * 100)} pts` : `límite = ask + ${Math.round(c.buffer * 100)}¢`;
    const tol = Math.round(c.restGuardTol * 100);
    const guard = !this.restCheck ? '' : c.restGuard ? `; no entra si el REST al decidir está más de ${tol}¢ arriba del WS` : `; precio viejo del WS (REST al decidir más de ${tol}¢ arriba): solo se mide`;
    return `regla anclada: ventaja ≥ ${Math.round(c.edge * 100)} pts neta de comisión, ask $${c.lo.toFixed(2)}-$${c.hi.toFixed(2)}, ${c.tMax}-${c.tMin} s restantes, $${c.stake} por operación (${lim}, tope $${c.cap.toFixed(2)}), fill a +${c.delayMs} ms (registro a +${c.checkMs} ms)${guard}`;
  }

  // Resolución de respaldo (reinicios, o si el shadow no resolvió) y resumen cada 5 min
  start() {
    const a = setInterval(() => this._resolveStale().catch(e => logger.warn(`[PAPER-B] resolución: ${e.message}`)), 60000);
    const b = setInterval(() => logger.info(this.summary()), 5 * 60000);
    for (const t of [a, b]) { if (t.unref) t.unref(); this._timers.push(t); }
  }

  stop() { for (const t of this._timers) clearInterval(t); this._timers = []; }

  // Una muestra por segundo del shadow: s = { T (s restantes), yesBid, yesAsk, noAsk, p, src }
  onSample(m, s) {
    let st = this.markets.get(m.gammaId);
    if (!st) {
      this._reportLast();
      st = { anchor: null, tried: false, market: marketLabel(m.question), inWin: 0, withData: 0, best: null };
      this.markets.set(m.gammaId, st);
      this._last = st;
      if (this.markets.size > 20) this.markets.delete(this.markets.keys().next().value);
    }
    const inWin = s.T <= this.cfg.tMax && s.T >= this.cfg.tMin;
    if (inWin) st.inWin++;
    if (s.yesBid == null || s.yesAsk == null || s.p == null || s.src !== 1) { st.anchor = null; return; }
    const mid = (s.yesBid + s.yesAsk) / 2;
    if (!st.anchor || Math.abs(mid - st.anchor.mid) > 1e-9) st.anchor = { mid, p: s.p };
    if (st.tried || !inWin) return;
    st.withData++;
    const pAdj = Math.min(0.999, Math.max(0.001, mid + (s.p - st.anchor.p)));
    for (const side of ['UP', 'DOWN']) {
      const ask = side === 'UP' ? s.yesAsk : s.noAsk;
      if (ask == null || ask < this.cfg.lo || ask > this.cfg.hi) continue;
      const pa = side === 'UP' ? pAdj : 1 - pAdj;
      const edge = pa - ask - this.fee(ask);
      if (!st.best || edge > st.best.edge) st.best = { edge, side, ask, T: Math.round(s.T) };
      if (edge < this.cfg.edge) continue;
      st.tried = true;
      st.done = this._execute(m, side, ask, pa, edge, s.T).catch(e => logger.warn(`[PAPER-B] ejecución: ${e.message}`));
      return;
    }
  }

  // Línea del mercado anterior si no entró: segundos de la ventana con datos y mejor ventaja vista
  _reportLast() {
    const st = this._last;
    if (!st || st.tried || !st.inWin) return;
    const b = st.best, c = this.cfg;
    logger.info(`[PAPER-B] sin entrada en ${st.market} | ${st.withData} de ${st.inWin} s de la ventana con libro y modelo Chainlink | ${b ? `mejor ventaja ${(b.edge * 100).toFixed(1)} pts (${b.side}, ask ${px(b.ask)}, ${b.T} s restantes; pide ${Math.round(c.edge * 100)})` : `ningún ask en $${c.lo.toFixed(2)}-$${c.hi.toFixed(2)}`}`);
  }

  async _execute(m, side, ask, pa, edge, T) {
    const c = this.cfg, tick = 0.01;
    const tokenId = side === 'UP' ? m.yesTokenId : m.noTokenId;
    const minPx = round2(ask + tick);
    // Límite 'fair': el precio más alto con el que todavía quedan `margin` pts de ventaja contra el precio
    // justo anclado, neto de comisión (redondeado hacia abajo al centavo)
    const fairLimit = () => { const l0 = pa - c.margin; return Math.floor((l0 - this.fee(Math.min(0.99, Math.max(0.01, l0)))) * 100 + 1e-9) / 100; };
    const limit = Math.max(minPx, Math.min(c.cap, c.limitMode === 'fair' ? fairLimit() : round2(ask + c.buffer)));
    const size = Math.floor(c.stake / limit);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const book = () => ({ ask: this.poly?.getBestAskForToken?.(tokenId) ?? null, size: this.poly?.getAskSizeUpTo?.(tokenId, limit) ?? null });
    const fills = b => b.ask != null && b.ask <= limit + 1e-9 && (b.size == null || b.size >= size);
    const restOn = this.restCheck && typeof this.fetch === 'function';
    const restBook = () => fetchRestBook(this.fetch, tokenId).catch(() => null);
    const t0 = Date.now();
    const r0 = restOn ? restBook().then(b => ({ b, ms: Date.now() - t0 })) : null;
    const lag0 = this.poly?._lastLagMs ?? null;
    await wait(c.checkMs);
    const b200 = book();
    await wait(c.delayMs - c.checkMs);
    const b400 = book();
    const r1 = restOn ? restBook() : null;
    const filled = size > 0 && fills(b400);
    let paid = null;
    if (filled) {
      const v = this.poly?.getAskVwapUpTo?.(tokenId, limit, size);
      paid = v?.vwap != null && v.filled >= size ? Math.min(limit, Math.max(minPx, +v.vwap.toFixed(4))) : limit;
    }
    // Libro REST al decidir (ya llegó: tarda ~40 ms): si tenía el ask más de restGuardTol arriba del WS,
    // el disparo salió de un precio viejo del WS
    const d0 = r0 ? await r0 : null;
    const restAsk0 = d0?.b?.ask ?? null;
    const phantom = restAsk0 != null && restAsk0 > ask + c.restGuardTol + 1e-9;
    const S = this.state;
    const pos = {
      id: `PB_${Date.now()}`, gammaId: m.gammaId, market: marketLabel(m.question), endTs: m.endTs,
      side, t: Date.now(), secsLeft: Math.round(T), ask, pa: +pa.toFixed(4), edge: +edge.toFixed(4),
      limit, size, ask200: b200.ask, ask400: b400.ask, fill200: fills(b200), filled, paid,
      restAsk0, restMs0: d0?.ms ?? null, phantom,
    };
    if (phantom) { S.phantom.n++; if (filled) S.phantom.filled++; }
    if (phantom && c.restGuard) {
      // No se manda la orden; si con el WS llenaba, se guarda para ver cómo habría salido (no cuenta en el P&L)
      if (filled) S.phantomOpen.push(pos);
      this._save();
      logger.info(`[PAPER-B] ${side} ${pos.market} | ${pos.secsLeft} s restantes | ask ${px(ask)} vs precio justo anclado ${(pa * 100).toFixed(1)}% (ventaja ${(edge * 100).toFixed(1)} pts) | NO ENTRA: precio viejo del WS (el REST al decidir ya estaba en ${px(restAsk0)}, respuesta en ${d0.ms} ms; retraso del WS ${lag0 ?? 'n/a'} ms): con el libro real no queda ventaja | ask a +${c.checkMs}ms ${px(b200.ask)} → +${c.delayMs}ms ${px(b400.ask)}; orden ${size} a $${limit} ${filled ? `habría llenado a $${paid}` : 'no habría llenado'}`);
      return pos;
    }
    S.attempts++;
    if (pos.fill200) S.fill200++;
    if (filled) { S.filled++; S.open.push(pos); } else { S.noFill++; if (pos.fill200) S.only200.push(pos); }
    if (S.only200.length > 200) S.only200.shift();
    this._save();
    logger.info(`[PAPER-B] ${side} ${pos.market} | ${pos.secsLeft} s restantes | ask ${px(ask)} vs precio justo anclado ${(pa * 100).toFixed(1)}% (ventaja ${(edge * 100).toFixed(1)} pts) | ask a +${c.checkMs}ms ${px(b200.ask)} → +${c.delayMs}ms ${px(b400.ask)} | orden ${size} a $${limit} | ${filled ? `lleno a $${paid}` : 'no'}`);
    if (restOn) {
      const b = await r1;
      const sz = restSizeUpTo(b, limit);
      pos.restAsk400 = b?.ask ?? null;
      pos.restFill = b ? size > 0 && b.ask != null && b.ask <= limit + 1e-9 && sz >= size : null;
      if (pos.restFill) {
        // Precio con el libro REST (mismo criterio que el WS: al menos ask al decidir + 1 tick, sin pasar el límite)
        const v = restVwapUpTo(b, limit, size);
        pos.restPaid = v.vwap != null ? Math.min(limit, Math.max(minPx, +v.vwap.toFixed(4))) : limit;
        // El WS no llenó pero el REST sí: la cuenta "con el libro REST" tiene esta posición
        if (!filled) S.restOpen.push(pos);
      }
      this._save();
      logger.info(`[PAPER-B] REST: al decidir ask ${px(pos.restAsk0)} (WS ${px(ask)}${pos.restMs0 != null ? `; respuesta en ${pos.restMs0} ms` : ''}) | a +${c.delayMs}ms ${px(pos.restAsk400)} (WS ${px(b400.ask)}), ${sz ?? 'n/a'} acciones hasta $${limit} → con REST ${pos.restFill == null ? 'sin dato' : pos.restFill ? `llenaba a $${pos.restPaid}` : 'no llenaba'} (paper: ${filled ? 'lleno' : 'no'}) | retraso del WS al decidir ${lag0 ?? 'n/a'} ms${phantom ? ' | PRECIO VIEJO del WS al decidir: entró igual (se cuenta aparte)' : ''}`);
    }
    return pos;
  }

  // Ganador oficial del mercado (lo llama el shadow al resolverlo). Solo resultados de Gamma.
  onResolved(gammaId, winner, source) {
    if ((winner !== 'UP' && winner !== 'DOWN') || !String(source || '').startsWith('gamma')) return;
    for (const p of this.state.open.filter(x => x.gammaId === gammaId)) this._close(p, winner, source);
    for (const p of this.state.restOpen.filter(x => x.gammaId === gammaId)) this._closeRestOnly(p, winner);
    for (const p of this.state.phantomOpen.filter(x => x.gammaId === gammaId)) this._closePhantom(p, winner);
    for (const p of this.state.only200.filter(x => x.gammaId === gammaId && x.winner == null)) p.winner = winner;
  }

  // Resultado de una posición al precio del libro REST (cuenta "con el libro REST")
  _restResult(p, winner, onlyRest) {
    const R = this.state.rest, rp = p.restPaid ?? p.paid, win = p.side === winner;
    const pnl = (win ? p.size * (1 - rp) : -p.size * rp) - this.fee(rp) * p.size;
    R.n++; if (win) R.w++; if (onlyRest) R.only++;
    R.pnl = +(R.pnl + pnl).toFixed(4);
    return pnl;
  }

  // Posición que solo llenaba con el libro REST (el WS no llenó): cuenta solo en el P&L con REST
  _closeRestOnly(p, winner) {
    const S = this.state;
    if (!S.restOpen.some(x => x.id === p.id)) return;
    S.restOpen = S.restOpen.filter(x => x.id !== p.id);
    const pnl = this._restResult(p, winner, true);
    this._save();
    logger.info(`[PAPER-B] solo con el libro REST: ${p.side === winner ? 'WIN' : 'LOSS'} ${p.side} ${p.market} @ $${p.restPaid} ×${p.size} → ${usd(pnl)} (el WS no llenó) | P&L con REST ${usd(S.rest.pnl)}`);
  }

  // Resultado de un disparo con precio viejo del WS, al precio del paper con el WS (cuenta aparte)
  _phantomResult(p, winner) {
    const X = this.state.phantom, win = p.side === winner;
    const pnl = (win ? p.size * (1 - p.paid) : -p.size * p.paid) - this.fee(p.paid) * p.size;
    if (win) X.w++; else X.l++;
    X.pnl = +(X.pnl + pnl).toFixed(4);
    return pnl;
  }

  // Disparo descartado por precio viejo del WS que con el WS llenaba: cómo habría salido (no cuenta en el P&L)
  _closePhantom(p, winner) {
    const S = this.state;
    if (!S.phantomOpen.some(x => x.id === p.id)) return;
    S.phantomOpen = S.phantomOpen.filter(x => x.id !== p.id);
    const pnl = this._phantomResult(p, winner);
    this._save();
    logger.info(`[PAPER-B] sin entrada por precio viejo del WS: habría sido ${p.side === winner ? 'WIN' : 'LOSS'} ${p.side} ${p.market} @ $${p.paid} ×${p.size} → ${usd(pnl)} (no cuenta) | descartadas que llenaban: ${S.phantom.w}-${S.phantom.l} ${usd(S.phantom.pnl)}`);
  }

  _close(p, winner, source) {
    const S = this.state;
    if (!S.open.some(x => x.id === p.id)) return;
    const win = p.side === winner;
    const fee = this.fee(p.paid) * p.size;
    const pnl = (win ? p.size * (1 - p.paid) : -p.size * p.paid) - fee;
    S.open = S.open.filter(x => x.id !== p.id);
    if (win) S.w++; else S.l++;
    S.pnl = +(S.pnl + pnl).toFixed(4);
    S.fees = +(S.fees + fee).toFixed(4);
    // Llenadas que según el libro REST a +delay no llenaban: se cuentan aparte; el resto entra en el P&L
    // "con el libro REST" al precio del REST (sin dato del REST: al del WS)
    if (p.restFill === false) { const r = S.restNo; r.n++; if (win) r.w++; r.pnl = +(r.pnl + pnl).toFixed(4); }
    else this._restResult(p, winner, false);
    if (p.phantom) this._phantomResult(p, winner);
    S.recent.push({ ...p, winner, win, pnl: +pnl.toFixed(4), source, closedAt: Date.now() });
    if (S.recent.length > 50) S.recent.shift();
    this._save();
    logger.info(`[PAPER-B] ${win ? 'WIN' : 'LOSS'} ${p.side} ${p.market} @ $${p.paid} ×${p.size} → ${usd(pnl)} (comisión $${fee.toFixed(2)}) | P&L B ${usd(S.pnl)} (${S.w}-${S.l})${p.restFill === false ? ' | con el libro REST no llenaba: no cuenta en el P&L con REST' : ''}`);
  }

  // Posiciones abiertas cuyo mercado cerró hace > 5 min y el shadow no resolvió (p. ej. hubo un
  // reinicio): se consulta Gamma, como hace el shadow
  async _resolveStale(now = Date.now()) {
    const stale = [...this.state.open, ...this.state.restOpen, ...this.state.phantomOpen].filter(x => now - x.endTs > 5 * 60000);
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

  summary() {
    const S = this.state, n = S.w + S.l;
    const o2 = S.only200.filter(x => x.winner), o2w = o2.filter(x => x.winner === x.side).length;
    const R = S.rest, X = S.phantom, c = this.cfg;
    const ph = ` | precio viejo del WS al decidir (REST > WS + ${Math.round(c.restGuardTol * 100)}¢): ${X.n}, llenaban ${X.filled}${X.w + X.l ? ` (${X.w}-${X.l} ${usd(X.pnl)})` : ''}, ${c.restGuard ? 'sin entrada' : 'entran igual'}`;
    return `[PAPER-B] Balance B: ${usd(S.pnl)} | W:${S.w} L:${S.l}${n ? ` (${(S.w / n * 100).toFixed(1)}%)` : ''} | intentos ${S.attempts}, llenadas ${S.filled}, sin fill ${S.noFill}, abiertas ${S.open.length} | a +${this.cfg.checkMs}ms llenaban ${S.fill200} (solo a ${this.cfg.checkMs} ms: ${S.only200.length}${o2.length ? `, ganaban ${o2w}/${o2.length}` : ''}) | con el libro REST: ${usd(R.pnl)} (${R.w}-${R.n - R.w}); ${S.restNo.n} llenadas que con REST no llenaban, ${R.only} que solo llenaba el REST | límite ${this.cfg.limitMode}${ph} | desde ${new Date(S.startedAt).toISOString().slice(0, 16)} UTC`;
  }

  _load() {
    const fresh = { v: 1, startedAt: Date.now(), attempts: 0, filled: 0, noFill: 0, fill200: 0, w: 0, l: 0, pnl: 0, fees: 0, open: [], recent: [], only200: [],
      restNo: { n: 0, w: 0, pnl: 0 }, rest: { n: 0, w: 0, pnl: 0, only: 0 }, restOpen: [],
      phantom: { n: 0, filled: 0, w: 0, l: 0, pnl: 0 }, phantomOpen: [] };
    try {
      if (fs.existsSync(this.stateFile)) {
        const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        const s = { ...fresh, ...saved };
        // Estado anterior al contador "con el libro REST": se arma con las cerradas guardadas
        if (!saved.restNo) {
          const g = (s.recent || []).filter(x => x.restFill === false);
          s.restNo = { n: g.length, w: g.filter(x => x.win).length, pnl: +g.reduce((a, x) => a + (x.pnl || 0), 0).toFixed(4) };
        }
        // Estado anterior a la cuenta "con el libro REST" a precio REST: las cerradas que el REST llenaba, a su precio
        if (!saved.rest) {
          const g = (s.recent || []).filter(x => x.restFill !== false);
          s.rest = { n: g.length, w: g.filter(x => x.win).length, pnl: +g.reduce((a, x) => a + (x.pnl || 0), 0).toFixed(4), only: 0 };
        }
        return s;
      }
    } catch (e) { logger.warn(`[PAPER-B] estado ilegible (${e.message}) — empieza de cero`); }
    return fresh;
  }

  _save() {
    try {
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { logger.warn(`[PAPER-B] no se pudo guardar el estado: ${e.message}`); }
  }
}

module.exports = { PaperB };
