/**
 * Sombra de otra serie de mercados "Up or Down" de Polymarket (por defecto BTC de 15 min). Solo registro: no opera
 * ni toca las cuentas A y B. Plan del 12/10 (b): buscar una regla donde haya menos competencia que en los de 5 min.
 *
 * Cada segundo, con el mercado en curso: libro de Sí y de No por la API REST (no abre otra conexión WS: la del bot ya
 * tiene cortes 1013) y P(UP) con el mismo modelo del bot (fairFn: TWAP 60 s de Chainlink contra el strike,
 * σ × FAIR_VOL_MULT). El strike es el TWAP 60 s de Chainlink en el segundo de apertura (strikeFn): lo que Polymarket
 * publica como priceToBeat (en BTC coincide con el del mercado de 5 min que abre a la misma hora). Al cerrar espera el
 * ganador oficial en Gamma y agrega una línea por mercado a DATA_DIR/shadow-ticks-<id>.jsonl con el formato de
 * shadow-ticks.jsonl (el backtest la lee igual: node scripts/backtest.js /data/shadow-ticks-btc15m.jsonl) y deja una
 * línea [SERIE <id>] con el ganador, el libro y qué habría hecho la regla de la cuenta B (anclada, 120-30 s).
 * Al resolver guarda también el priceToBeat que Gamma publica en eventMetadata (valida el strike).
 * Cuenta B15 (paper, solo con paper: true; PAPER_B15=off la apaga en BTC y PAPER_B15_ETH=off en ETH 15 min): la misma regla de B en vivo,
 * una entrada por mercado, orden con el límite justo de B (margen 2, tope $0.72, ~$5) y fill con el libro REST a
 * +PAPER_CHECK_MS (200 ms, lo más parecido a una orden real); se resuelve con el ganador oficial y guarda su estado en
 * DATA_DIR/paper-b15-<id>.json (sigue después de un reinicio). Líneas [PAPER-B15] con cada intento, WIN/LOSS y el balance.
 * SERIES_SHADOW=off apaga la de BTC 15 min; SERIES_SHADOW_ETH=off las de ETH 5 y 15 min (ids eth5m y eth15m, precio de Chainlink ETH
 * por PolyBolt, src/aux-price.js; en su archivo la columna "btc" lleva el precio de ETH).
 * Mercados horarios de BTC (id btc1h, plan del 23/10; SERIES_SHADOW_1H=off la apaga, PAPER_B1H=off solo la cuenta): resuelven
 * con la vela de 1 h de Binance BTC/USDT, así que el strike es su apertura (src/binance-kline.js) y el modelo es el precio de
 * Binance contra el strike, sin TWAP. Opciones para eso: slugFn (nombres candidatos del evento en Gamma; hourlySlugs),
 * strikeSource (se graba en el archivo), paperName (B1H: líneas [PAPER-B1H], estado en paper-b1h-<id>.json) y winnerFn
 * (ganador de respaldo con la vela de Binance si Gamma no lo publica en los intentos).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');
const { fetchRestBook } = require('./book-check');
const { marketLabel } = require('./market-label');

const logger = new Logger('SERIE');
const GAMMA = 'https://gamma-api.polymarket.com';
// Las columnas de shadow-ticks.jsonl hasta sigma_long_e6 (sin las de la señal de Binance del bot)
const COLS = ['t', 'secs_left', 'btc', 'p_up', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'sigma_e6', 'book_imb', 'src', 'sigma_short_e6', 'sigma_long_e6'];
const I = Object.fromEntries(COLS.map((k, i) => [k, i]));
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const rnd = (v, d) => (v == null || !Number.isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;
const usd = v => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const parseArr = v => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : null; } catch { return null; } };
// priceToBeat que Gamma publica en eventMetadata del evento (al resolver; a veces un rato después del ganador)
const gammaPriceToBeat = ev => {
  const meta = ev?.eventMetadata;
  const txt = typeof meta === 'string' ? meta : meta ? JSON.stringify(meta) : '';
  const v = parseFloat(/priceToBeat"?\s*:\s*"?([0-9.]+)/.exec(txt)?.[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

// Nombres candidatos del evento horario en Gamma para la hora que abre en startTs: "<prefijo>-<mes>-<día>-<hora><am|pm>-et"
// con la hora de Nueva York (bitcoin-up-or-down-october-23-10am-et, como figuran los eventos) y, por si Polymarket les
// pone el formato de las series de 5 y 15 min, "<corto>-<apertura en s>"
const NY_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', hour: 'numeric', hour12: true });
function hourlySlugs(startTs, prefix = 'bitcoin-up-or-down', short = 'btc-updown-1h') {
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(startTs)).map(x => [x.type, x.value]));
  return [`${prefix}-${p.month.toLowerCase()}-${p.day}-${p.hour}${String(p.dayPeriod).toLowerCase()}-et`, `${short}-${startTs / 1000}`];
}

class SeriesShadow {
  // fairFn(K, endMs, nowMs) → { p, sigma, sigmaShort, sigmaLong } | null; strikeFn(startMs) → número | null
  constructor({ id = 'btc15m', slugPrefix = 'btc-updown-15m', periodS = 900, fairFn, strikeFn, spotFn = () => null,
    fetchFn = globalThis.fetch, dataDir = process.env.DATA_DIR || '/data', sampleMs = 1000, now = Date.now,
    resolveDelayMs = 30000, resolveEveryMs = 20000, resolveTries = 45, ptbTries = 3, env = process.env, paper = false,
    slugFn = null, strikeSource = 'chainlink_twap_60s', paperName = 'B15', winnerFn = null } = {}) {
    Object.assign(this, { id, slugPrefix, fairFn, strikeFn, spotFn, sampleMs, now, resolveDelayMs, resolveEveryMs, resolveTries, ptbTries, dataDir,
      strikeSource, paperName, winnerFn });
    this.slugFn = slugFn || (ts => `${this.slugPrefix}-${ts / 1000}`);
    this.ptag = `[PAPER-${paperName}]`;
    this.periodMs = periodS * 1000;
    this.fetch = fetchFn;
    this.file = path.join(dataDir, `shadow-ticks-${id}.jsonl`);
    // Regla de la cuenta B (src/paper-b.js), para el resumen de cada mercado
    this.envFee = num(env.TAKER_FEE_RATE, 0.072);
    this.rule = { edge: num(env.PAPER_B_EDGE, 0.08), lo: num(env.PAPER_B_MIN_ASK, 0.30), hi: num(env.PAPER_B_MAX_ASK, 0.70),
      tMax: num(env.PAPER_B_TMAX, 120), tMin: num(env.PAPER_B_TMIN, 30), fee: this.envFee };
    this.cur = null;
    this.pending = new Set();
    this.timer = null;
    this.stats = { markets: 0, written: 0, unresolved: 0, noMarket: 0, restErrors: 0 };
    this.paper = paper ? this._paperInit(env) : null;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { try { this._tick(); } catch (e) { logger.warn(`[SERIE ${this.id}] ${e.message}`); } }, this.sampleMs);
    this.timer.unref?.();
    logger.info(`[SERIE ${this.id}] ✅ Sombra de ${this.slugPrefix} (${this.periodMs / 60000} min): libro REST cada ${this.sampleMs} ms y modelo ${this.strikeSource === 'binance_1h_open' ? 'de Binance contra la apertura de la vela de 1 h' : 'TWAP de Chainlink'} → ${this.file} (solo registro)`);
    if (this.paper) {
      const c = this.paper.cfg;
      logger.info(`[SERIE ${this.id}] ${this.ptag} ✅ cuenta en paper con la regla de B en vivo: límite justo margen ${Math.round(c.margin * 100)} pts, tope $${c.cap.toFixed(2)}, $${c.stake} por operación, fill con el libro REST a +${c.checkMs} ms | ${this._paperBalance()}`);
      this._paperResume();
    }
    return this;
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  _tick() {
    const now = this.now(), startTs = now - (now % this.periodMs);
    if (!this.cur || this.cur.startTs !== startTs) {
      if (this.cur) this._close(this.cur);
      this.stats.markets++;
      const slugs = [].concat(this.slugFn(startTs));
      this.cur = { startTs, endTs: startTs + this.periodMs, slug: slugs[0], slugs, partial: now - startTs > 5000,
        tokens: null, upIdx: 0, question: null, discovering: false, lastTry: 0, discoverErr: null, inFlight: false, skipped: 0,
        strike: null, rows: [], restMs: [], restReq: 0, restFail: 0, restCodes: {}, closed: false };
    }
    const m = this.cur;
    if (!m.tokens) { if (!m.discovering && now - m.lastTry >= 5000) m.done = this._discover(m); return; }
    if (m.inFlight) { m.skipped++; return; }
    m.done = this._sample(m);
  }

  // Mercado de la serie en Gamma por slug (<prefijo>-<apertura en s>, o el que dé slugFn): tokens de Sí (Up) y No (Down)
  async _gammaMarket(slug) {
    const res = await this.fetch(`${GAMMA}/events?slug=${slug}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ev = Array.isArray(data) ? data[0] : null, mk = ev?.markets?.[0];
    return mk ? { ev, mk } : null;
  }

  async _discover(m) {
    m.discovering = true;
    m.lastTry = this.now();
    try {
      // Nombres candidatos en orden: el primero que esté en Gamma pasa a ser el slug del mercado
      let r = null, found = null;
      for (const sl of m.slugs) { r = await this._gammaMarket(sl); if (r) { found = sl; break; } }
      const ids = parseArr(r?.mk.clobTokenIds), outs = parseArr(r?.mk.outcomes);
      if (!ids || ids.length < 2) { m.discoverErr = r ? 'sin tokens' : 'no está en Gamma'; return; }
      m.slug = found;
      m.upIdx = outs && /^(down|no)$/i.test(String(outs[0])) ? 1 : 0; // Sí = Up: el primero salvo que diga lo contrario
      m.tokens = { yes: ids[m.upIdx], no: ids[1 - m.upIdx] };
      m.question = r.ev.title || r.mk.question || m.slug;
      // Comisión de la serie: los mercados con feesEnabled=false en Gamma (los horarios, 23/10) no cobran → 0 en la regla y
      // en la cuenta; los demás siguen con TAKER_FEE_RATE (las reglas de B y B15 no cambian)
      const fee = r.mk.feesEnabled === false ? 0 : this.envFee;
      if (fee !== this.rule.fee) {
        this.rule.fee = fee;
        logger.info(`[SERIE ${this.id}] ${m.slug}: ${fee ? `comisión ${fee}·p·(1−p)` : 'sin comisión (feesEnabled=false)'} en la regla de B y la cuenta`);
      }
      // Una vez por arranque: qué dice Gamma de comisiones en esta serie
      if (!this.feesLogged) {
        this.feesLogged = true;
        const f = Object.entries(r.mk).filter(([k]) => /fee|rebate/i.test(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`.slice(0, 80));
        logger.info(`[SERIE ${this.id}] ${m.slug}: campos de comisión en Gamma: ${f.length ? f.join(', ') : 'ninguno'}`);
      }
    } catch (e) { m.discoverErr = e.message; }
    finally { m.discovering = false; }
  }

  async _sample(m) {
    m.inFlight = true;
    try {
      const t0 = this.now();
      // Pedido REST fallido: se cuenta por código (HTTP 429 = demasiados pedidos; el criterio de apagado mira esto)
      const fail = e => {
        m.restFail++;
        const code = /HTTP (\d{3})/.exec(e?.message || '')?.[1] || 'sin respuesta';
        m.restCodes[code] = (m.restCodes[code] || 0) + 1;
        if (code === '429' && !m.warned429) { m.warned429 = true; logger.warn(`[SERIE ${this.id}] la API REST respondió 429 (demasiados pedidos) en ${m.slug}`); }
        return null;
      };
      m.restReq += 2;
      const [Y, N] = await Promise.all([m.tokens.yes, m.tokens.no].map(tok => fetchRestBook(this.fetch, tok).catch(fail)));
      const now = this.now();
      if (m.closed || now > m.endTs) return;
      if (!Y && !N) this.stats.restErrors++;
      m.restMs.push(now - t0);
      if (m.strike == null) { let k = null; try { k = this.strikeFn?.(m.startTs); } catch (_) {} if (Number.isFinite(k)) m.strike = k; }
      let F = null;
      if (m.strike != null) { try { F = this.fairFn?.(m.strike, m.endTs, now) || null; } catch (_) { F = null; } }
      let btc = null;
      try { btc = this.spotFn(); } catch (_) {}
      const e6 = v => rnd(v == null ? null : v * 1e6, 3);
      m.rows.push([Math.round((now - m.startTs) / 1000), rnd((m.endTs - now) / 1000, 1), rnd(btc, 2), rnd(F?.p, 4),
        Y?.bid ?? null, Y?.ask ?? null, N?.bid ?? null, N?.ask ?? null, e6(F?.sigma), null, F?.p != null ? 1 : null,
        e6(F?.sigmaShort), e6(F?.sigmaLong)]);
      if (this.paper) { try { this._paperStep(m, m.rows[m.rows.length - 1], now); } catch (e) { logger.warn(`[SERIE ${this.id}] ${this.ptag} ${e.message}`); } }
    } finally { m.inFlight = false; }
  }

  _close(m) {
    if (m.closed) return;
    m.closed = true;
    if (!m.tokens || !m.rows.length) {
      this.stats.noMarket++;
      logger.info(`[SERIE ${this.id}] ${m.slug}: ${m.tokens ? 'sin muestras' : `sin mercado (${m.discoverErr || 'no se encontró'})`}`);
      return;
    }
    this.pending.add(m);
    const t = setTimeout(() => { m.done = this._resolve(m, 0); }, this.resolveDelayMs);
    t.unref?.();
  }

  // Ganador oficial: el mercado cerrado en Gamma con el precio de un resultado en 1
  async _resolve(m, attempt) {
    let winner = null;
    try {
      const r = await this._gammaMarket(m.slug);
      const prices = parseArr(r?.mk.outcomePrices);
      const up = parseFloat(prices?.[m.upIdx]), dn = parseFloat(prices?.[1 - m.upIdx]);
      if (r?.mk.closed === true && up >= 0.99) winner = 'UP';
      else if (r?.mk.closed === true && dn >= 0.99) winner = 'DOWN';
      const ptb = gammaPriceToBeat(r?.ev);
      if (ptb != null) m.ptb = ptb;
    } catch (_) {}
    // Sin ganador en Gamma después de todos los intentos: el de respaldo (vela de Binance en los horarios), si hay
    if (!winner && attempt + 1 >= this.resolveTries && this.winnerFn) {
      try { winner = await this.winnerFn({ startTs: m.startTs, endTs: m.endTs }); } catch (_) { winner = null; }
      if (winner) m.winnerSource = 'binance_kline';
    }
    // Sin ganador: reintenta; con ganador pero sin priceToBeat todavía: espera unos intentos más solo por él
    const waitPtb = winner && m.ptb == null && (m.ptbWaits = (m.ptbWaits || 0) + 1) <= this.ptbTries;
    if ((!winner && attempt + 1 < this.resolveTries) || waitPtb) {
      const t = setTimeout(() => { m.done = this._resolve(m, attempt + 1); }, this.resolveEveryMs);
      t.unref?.();
      return;
    }
    this.pending.delete(m);
    this._write(m, winner);
  }

  _write(m, winner) {
    if (winner) {
      const rec = { v: 1, series: this.id, question: m.question, slug: m.slug, start_ts: m.startTs, end_ts: m.endTs,
        strike: m.strike, strike_source: m.strike != null ? this.strikeSource : null, price_to_beat: m.ptb ?? null,
        winner, winner_source: m.winnerSource || 'gamma',
        partial: m.partial, samples: m.rows.length, skipped: m.skipped, cols: COLS, rows: m.rows };
      fs.promises.appendFile(this.file, JSON.stringify(rec) + '\n').catch(e => logger.warn(`[SERIE ${this.id}] escritura: ${e.message}`));
      this.stats.written++;
    } else this.stats.unresolved++;
    logger.info(this.summary(m, winner));
    if (this.paper && m.b15?.filled) this._paperSettle(m.slug, winner);
  }

  // Un paso de la regla de B sobre una muestra: precio justo anclado = mid de Sí + (p del modelo − p cuando el mid tomó
  // su valor actual); el ancla (st) se reinicia sin libro de Sí o sin modelo de Chainlink
  _bStep(st, r) {
    const R = this.rule;
    const p = r[I.p_up], yb = r[I.yes_bid], ya = r[I.yes_ask], sl = r[I.secs_left];
    if (p == null || r[I.src] !== 1 || yb == null || ya == null) { st.aMid = null; return null; }
    const mid = (yb + ya) / 2;
    if (st.aMid == null || Math.abs(mid - st.aMid) > 1e-9) { st.aMid = mid; st.aP = p; }
    if (sl > R.tMax || sl < R.tMin) return null;
    const pAdj = Math.min(0.999, Math.max(0.001, mid + (p - st.aP)));
    let best = null;
    for (const side of ['UP', 'DOWN']) {
      const ask = side === 'UP' ? ya : r[I.no_ask];
      if (ask == null || ask < R.lo || ask > R.hi) continue;
      const pa = side === 'UP' ? pAdj : 1 - pAdj;
      const edge = pa - ask - R.fee * ask * (1 - ask);
      if (edge >= R.edge) return { fire: true, side, ask, edge, sl, pa };
      if (!best || edge > best.edge) best = { fire: false, side, ask, edge, sl, pa };
    }
    return best;
  }

  // Primera entrada de la regla de B (como el backtest con kind 'anchored')
  bRule(m, winner) {
    const st = {};
    let best = null;
    for (const r of m.rows) {
      const b = this._bStep(st, r);
      if (!b) continue;
      if (b.fire) return { fire: true, side: b.side, ask: b.ask, edge: b.edge, sl: b.sl, win: winner ? b.side === winner : null };
      if (!best || b.edge > best.edge) best = { side: b.side, ask: b.ask, edge: b.edge, sl: b.sl };
    }
    return { fire: false, best };
  }

  // ── Cuenta B15 (paper) ──────────────────────────────────────────────────────────────────────────────
  _paperInit(env) {
    const file = path.join(this.dataDir, `paper-${this.paperName.toLowerCase()}-${this.id}.json`);
    const cfg = { stake: num(env.PAPER_B_STAKE, 5), margin: num(env.PAPER_B_LIMIT_MARGIN, 0.02), checkMs: num(env.PAPER_CHECK_MS, 200),
      cap: Math.round((this.rule.hi + 0.02) * 100) / 100 };
    let st = null;
    try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    if (!st || typeof st !== 'object') st = { pnl: 0, w: 0, l: 0, attempts: 0, filled: 0, noFill: 0, unresolved: 0, open: [], startedAt: this.now() };
    if (!Array.isArray(st.open)) st.open = [];
    return { file, cfg, st, chain: Promise.resolve() };
  }

  _paperBalance() {
    const st = this.paper.st;
    return `Balance ${this.paperName}: ${usd(st.pnl)} (${st.w}-${st.l}), intentos ${st.attempts}, llenadas ${st.filled}, sin fill ${st.noFill}, abiertas ${st.open.length}`
      + `${st.unresolved ? `, sin ganador ${st.unresolved}` : ''} | desde ${new Date(st.startedAt).toISOString().slice(0, 16)} UTC`;
  }

  // Escritura en orden (una a la vez) a un temporal y rename
  _paperSave() {
    const P = this.paper, tmp = `${P.file}.tmp`;
    P.chain = P.chain.then(() => fs.promises.writeFile(tmp, JSON.stringify(P.st)).then(() => fs.promises.rename(tmp, P.file)))
      .catch(e => logger.warn(`[SERIE ${this.id}] ${this.ptag} no se pudo guardar: ${e.message}`));
    return P.chain;
  }

  // En cada muestra: si la regla de B entra (una vez por mercado), orden al límite justo y fill con el REST a +checkMs
  _paperStep(m, r, now) {
    m.anc = m.anc || {};
    const b = this._bStep(m.anc, r);
    const P = this.paper, c = P.cfg;
    if (!b?.fire || m.b15 || P.st.open.some(o => o.slug === m.slug)) return;
    const l0 = b.pa - c.margin;
    const limit = Math.max(0.01, Math.min(c.cap, Math.floor((l0 - this.rule.fee * l0 * (1 - l0)) * 100 + 1e-9) / 100));
    const att = m.b15 = { side: b.side, ask: b.ask, edge: b.edge, pa: b.pa, sl: Math.round(b.sl), limit, size: Math.floor(c.stake / limit), t: now };
    P.st.attempts++;
    const tok = b.side === 'UP' ? m.tokens.yes : m.tokens.no;
    const t = setTimeout(() => { att.done = this._paperFill(m, att, tok); }, c.checkMs);
    t.unref?.();
  }

  async _paperFill(m, att, tok) {
    const P = this.paper, st = P.st, fee = p => this.rule.fee * p * (1 - p);
    let bk = null;
    try { bk = await fetchRestBook(this.fetch, tok); } catch (_) {}
    att.ask200 = bk?.ask ?? null;
    // Llena si a +checkMs el REST ofrece todas las acciones hasta el límite; paga el promedio de esos niveles
    let need = att.size, cost = 0;
    for (const [p, z] of bk?.asks || []) { if (p > att.limit + 1e-9 || need <= 0) break; const q = Math.min(need, z); cost += q * p; need -= q; }
    att.filled = att.size > 0 && need <= 1e-9;
    const label = marketLabel(m.question);
    if (att.filled) {
      att.paid = Math.round(cost / att.size * 1e4) / 1e4;
      st.filled++;
      st.open.push({ slug: m.slug, label, side: att.side, paid: att.paid, size: att.size, upIdx: m.upIdx, start: m.startTs, end: m.endTs,
        feeRate: this.rule.fee });
    } else st.noFill++;
    const px = v => (v == null ? 'n/a' : `$${v.toFixed(2)}`);
    logger.info(`[SERIE ${this.id}] ${this.ptag} ${att.side} ${label} | ${att.sl} s restantes | ask ${px(att.ask)} vs precio justo anclado ${(att.pa * 100).toFixed(1)}% (ventaja ${(att.edge * 100).toFixed(1)} pts) | orden ${att.size} a ${px(att.limit)} | ask a +${P.cfg.checkMs}ms ${px(att.ask200)} → `
      + `${att.filled ? `lleno a ${px(att.paid)} (ventaja al precio pagado ${((att.pa - att.paid - fee(att.paid)) * 100).toFixed(1)} pts)` : 'no llena'} | ${this._paperBalance()}`);
    return this._paperSave();
  }

  _paperSettle(slug, winner) {
    const st = this.paper.st;
    const i = st.open.findIndex(o => o.slug === slug);
    if (i < 0) return null;
    const o = st.open.splice(i, 1)[0];
    if (!winner) {
      st.unresolved++;
      logger.warn(`[SERIE ${this.id}] ${this.ptag} ${o.side} ${o.label}: sin ganador oficial en Gamma, queda afuera del balance | ${this._paperBalance()}`);
      return this._paperSave();
    }
    const win = o.side === winner, fee = (o.feeRate ?? this.rule.fee) * o.paid * (1 - o.paid) * o.size;
    const pnl = (win ? o.size * (1 - o.paid) : -o.size * o.paid) - fee;
    st.pnl = Math.round((st.pnl + pnl) * 1e4) / 1e4;
    if (win) st.w++; else st.l++;
    logger.info(`[SERIE ${this.id}] ${this.ptag} ${win ? 'WIN' : 'LOSS'} ${o.side} ${o.label} @ $${o.paid.toFixed(2)} ×${o.size} → ${usd(pnl)} (comisión $${fee.toFixed(2)}) | ${this._paperBalance()}`);
    return this._paperSave();
  }

  // Al arrancar: las posiciones que quedaron abiertas se resuelven con Gamma después del cierre de su mercado
  _paperResume() {
    for (const o of this.paper.st.open) {
      const t = setTimeout(() => { o.done = this._paperResolveOpen(o, 0); }, Math.max(0, o.end + this.resolveDelayMs - this.now()));
      t.unref?.();
    }
  }

  async _paperResolveOpen(o, attempt) {
    let winner = null;
    try {
      const r = await this._gammaMarket(o.slug);
      const pr = parseArr(r?.mk.outcomePrices), up = parseFloat(pr?.[o.upIdx]), dn = parseFloat(pr?.[1 - o.upIdx]);
      if (r?.mk.closed === true && up >= 0.99) winner = 'UP';
      else if (r?.mk.closed === true && dn >= 0.99) winner = 'DOWN';
    } catch (_) {}
    if (!winner && attempt + 1 >= this.resolveTries && this.winnerFn && o.start != null) {
      try { winner = await this.winnerFn({ startTs: o.start, endTs: o.end }); } catch (_) { winner = null; }
    }
    if (!winner && attempt + 1 < this.resolveTries) {
      const t = setTimeout(() => { o.done = this._paperResolveOpen(o, attempt + 1); }, this.resolveEveryMs);
      t.unref?.();
      return null;
    }
    return this._paperSettle(o.slug, winner);
  }

  summary(m, winner) {
    const rows = m.rows, withModel = rows.filter(r => r[I.src] === 1).length;
    const spreads = rows.filter(r => r[I.yes_bid] != null && r[I.yes_ask] != null).map(r => r[I.yes_ask] - r[I.yes_bid]);
    const ms = [...m.restMs].sort((a, b) => a - b), p50 = ms.length ? ms[Math.floor(ms.length / 2)] : null;
    const b = this.bRule(m, winner);
    const rule = b.fire
      ? `regla de B: ${b.side} a $${b.ask.toFixed(2)} con ${(b.edge * 100).toFixed(1)} pts a ${Math.round(b.sl)} s → ${b.win == null ? 'sin ganador' : b.win ? 'gana' : 'pierde'}`
      : `regla de B: no entra${b.best ? ` (mejor ${(b.best.edge * 100).toFixed(1)} pts, ${b.best.side} a $${b.best.ask.toFixed(2)})` : ''}`;
    const d = m.strike != null && m.ptb != null ? m.strike - m.ptb : null;
    const ptb = m.ptb != null ? ` (priceToBeat $${m.ptb.toFixed(2)}${d != null ? `, Δ ${d >= 0 ? '+' : '−'}$${Math.abs(d).toFixed(2)}` : ''})` : '';
    return `[SERIE ${this.id}] ${marketLabel(m.question)} | ganó ${winner || 'sin dato de Gamma'} | strike ${m.strike != null ? `$${m.strike.toFixed(2)}` : 'n/a'}${ptb}`
      + ` | ${rows.length} muestras (${withModel} con modelo${m.partial ? ', mercado empezado antes del arranque' : ''}${m.skipped ? `, ${m.skipped} saltadas` : ''}; REST p50 ${p50 ?? 'n/a'} ms`
      + `, sin respuesta ${m.restFail || 0} de ${m.restReq || 0}${m.restFail ? ` [${Object.entries(m.restCodes).map(([k, v]) => `${k}: ${v}`).join(', ')}]` : ''})`
      + ` | spread medio de Sí ${spreads.length ? (spreads.reduce((a, x) => a + x, 0) / spreads.length * 100).toFixed(1) : 'n/a'}¢ | ${rule}`;
  }
}

module.exports = { SeriesShadow, COLS, gammaPriceToBeat, hourlySlugs };
