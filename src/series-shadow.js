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
 * SERIES_SHADOW=off apaga la de BTC 15 min; SERIES_SHADOW_ETH=off la de ETH 5 min (id eth5m, precio de Chainlink ETH
 * por PolyBolt, src/aux-price.js; en su archivo la columna "btc" lleva el precio de ETH).
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
const parseArr = v => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : null; } catch { return null; } };
// priceToBeat que Gamma publica en eventMetadata del evento (al resolver; a veces un rato después del ganador)
const gammaPriceToBeat = ev => {
  const meta = ev?.eventMetadata;
  const txt = typeof meta === 'string' ? meta : meta ? JSON.stringify(meta) : '';
  const v = parseFloat(/priceToBeat"?\s*:\s*"?([0-9.]+)/.exec(txt)?.[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

class SeriesShadow {
  // fairFn(K, endMs, nowMs) → { p, sigma, sigmaShort, sigmaLong } | null; strikeFn(startMs) → número | null
  constructor({ id = 'btc15m', slugPrefix = 'btc-updown-15m', periodS = 900, fairFn, strikeFn, spotFn = () => null,
    fetchFn = globalThis.fetch, dataDir = process.env.DATA_DIR || '/data', sampleMs = 1000, now = Date.now,
    resolveDelayMs = 30000, resolveEveryMs = 20000, resolveTries = 45, ptbTries = 3, env = process.env } = {}) {
    Object.assign(this, { id, slugPrefix, fairFn, strikeFn, spotFn, sampleMs, now, resolveDelayMs, resolveEveryMs, resolveTries, ptbTries });
    this.periodMs = periodS * 1000;
    this.fetch = fetchFn;
    this.file = path.join(dataDir, `shadow-ticks-${id}.jsonl`);
    // Regla de la cuenta B (src/paper-b.js), para el resumen de cada mercado
    this.rule = { edge: num(env.PAPER_B_EDGE, 0.08), lo: num(env.PAPER_B_MIN_ASK, 0.30), hi: num(env.PAPER_B_MAX_ASK, 0.70),
      tMax: num(env.PAPER_B_TMAX, 120), tMin: num(env.PAPER_B_TMIN, 30), fee: num(env.TAKER_FEE_RATE, 0.072) };
    this.cur = null;
    this.pending = new Set();
    this.timer = null;
    this.stats = { markets: 0, written: 0, unresolved: 0, noMarket: 0, restErrors: 0 };
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { try { this._tick(); } catch (e) { logger.warn(`[SERIE ${this.id}] ${e.message}`); } }, this.sampleMs);
    this.timer.unref?.();
    logger.info(`[SERIE ${this.id}] ✅ Sombra de ${this.slugPrefix} (${this.periodMs / 60000} min): libro REST cada ${this.sampleMs} ms y modelo TWAP de Chainlink → ${this.file} (solo registro)`);
    return this;
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  _tick() {
    const now = this.now(), startTs = now - (now % this.periodMs);
    if (!this.cur || this.cur.startTs !== startTs) {
      if (this.cur) this._close(this.cur);
      this.stats.markets++;
      this.cur = { startTs, endTs: startTs + this.periodMs, slug: `${this.slugPrefix}-${startTs / 1000}`, partial: now - startTs > 5000,
        tokens: null, upIdx: 0, question: null, discovering: false, lastTry: 0, discoverErr: null, inFlight: false, skipped: 0,
        strike: null, rows: [], restMs: [], restReq: 0, restFail: 0, restCodes: {}, closed: false };
    }
    const m = this.cur;
    if (!m.tokens) { if (!m.discovering && now - m.lastTry >= 5000) m.done = this._discover(m); return; }
    if (m.inFlight) { m.skipped++; return; }
    m.done = this._sample(m);
  }

  // Mercado de la serie en Gamma por slug (<prefijo>-<apertura en s>): tokens de Sí (Up) y No (Down)
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
      const r = await this._gammaMarket(m.slug);
      const ids = parseArr(r?.mk.clobTokenIds), outs = parseArr(r?.mk.outcomes);
      if (!ids || ids.length < 2) { m.discoverErr = r ? 'sin tokens' : 'no está en Gamma'; return; }
      m.upIdx = outs && /^(down|no)$/i.test(String(outs[0])) ? 1 : 0; // Sí = Up: el primero salvo que diga lo contrario
      m.tokens = { yes: ids[m.upIdx], no: ids[1 - m.upIdx] };
      m.question = r.ev.title || r.mk.question || m.slug;
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
        strike: m.strike, strike_source: m.strike != null ? 'chainlink_twap_60s' : null, price_to_beat: m.ptb ?? null,
        winner, winner_source: 'gamma',
        partial: m.partial, samples: m.rows.length, skipped: m.skipped, cols: COLS, rows: m.rows };
      fs.promises.appendFile(this.file, JSON.stringify(rec) + '\n').catch(e => logger.warn(`[SERIE ${this.id}] escritura: ${e.message}`));
      this.stats.written++;
    } else this.stats.unresolved++;
    logger.info(this.summary(m, winner));
  }

  // Primera entrada de la regla de B (como el backtest con kind 'anchored'): precio justo anclado = mid de Sí + (p del
  // modelo − p cuando el mid tomó su valor actual); el ancla se reinicia sin libro de Sí o sin modelo de Chainlink
  bRule(m, winner) {
    const R = this.rule;
    let aMid = null, aP = null, best = null;
    for (const r of m.rows) {
      const p = r[I.p_up], yb = r[I.yes_bid], ya = r[I.yes_ask], sl = r[I.secs_left];
      if (p == null || r[I.src] !== 1 || yb == null || ya == null) { aMid = null; continue; }
      const mid = (yb + ya) / 2;
      if (aMid == null || Math.abs(mid - aMid) > 1e-9) { aMid = mid; aP = p; }
      if (sl > R.tMax || sl < R.tMin) continue;
      const pAdj = Math.min(0.999, Math.max(0.001, mid + (p - aP)));
      for (const side of ['UP', 'DOWN']) {
        const ask = side === 'UP' ? ya : r[I.no_ask];
        if (ask == null || ask < R.lo || ask > R.hi) continue;
        const edge = (side === 'UP' ? pAdj : 1 - pAdj) - ask - R.fee * ask * (1 - ask);
        if (!best || edge > best.edge) best = { side, ask, edge, sl };
        if (edge >= R.edge) return { fire: true, side, ask, edge, sl, win: winner ? side === winner : null };
      }
    }
    return { fire: false, best };
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

module.exports = { SeriesShadow, COLS, gammaPriceToBeat };
