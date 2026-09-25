/**
 * Shadow — modo sombra del modelo de valor justo. NO decide trades.
 *
 * Para cada mercado de 5 min, cada segundo:
 *   - calcula P(UP) con FairValue (BTC vs apertura, tiempo restante, volatilidad)
 *   - lee bid/ask de YES y NO del WebSocket de Polymarket
 *   - anota la ventaja del modelo:  edge UP = P(UP) − ask YES,  edge DOWN = (1 − P(UP)) − ask NO
 *   - anota la primera oportunidad para varios umbrales de ventaja
 * Registra también las señales y trades del bot en ese mercado y qué decía el modelo en ese momento.
 * Al cerrar, espera la resolución oficial en Gamma y escribe:
 *   /data/shadow-markets.jsonl  → un resumen por mercado (ganador, qué hizo el bot, qué habría hecho el modelo)
 *   /data/shadow-ticks.jsonl    → la serie segundo a segundo del mercado (una línea por mercado)
 * y deja en el log una línea [SHADOW] legible + una [SHADOW-JSON] con el resumen completo.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');
const { probUp } = require('./fair-value');

const logger = new Logger('SHADOW');
const DATA_DIR = process.env.DATA_DIR || '/data';
const MARKETS_FILE = path.join(DATA_DIR, 'shadow-markets.jsonl');
const TICKS_FILE = path.join(DATA_DIR, 'shadow-ticks.jsonl');
const GAMMA = 'https://gamma-api.polymarket.com';

const THRESHOLDS = [0.03, 0.05, 0.08, 0.12];                         // ventajas a evaluar (fracción = puntos/100)
const DECISION_EDGE = parseFloat(process.env.SHADOW_EDGE || '0.05');  // umbral "el modelo entraría"
const MIN_SECS = parseInt(process.env.SHADOW_MIN_SECS || '10');       // no contar oportunidades con <10s
// src: 1 = FAIR del bot con TWAP de Chainlink (cómo resuelve Polymarket), 0 = respaldo con spot de Binance
const COLS = ['t', 'secs_left', 'btc', 'p_up', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'sigma_e6', 'book_imb', 'src'];

const rnd = (v, d) => (v == null || !Number.isFinite(v)) ? null : Math.round(v * 10 ** d) / 10 ** d;
const pnl = (win, price) => win == null || price == null ? null : rnd(win ? 1 - price : -price, 4);

class Shadow {
  constructor({ fairValue, polyWs, rtds = null, sampleMs = parseInt(process.env.SHADOW_SAMPLE_MS || '1000') }) {
    this.fv = fairValue;
    this.poly = polyWs;
    this.rtds = rtds;
    this.sampleMs = sampleMs;
    this.cur = null;
    this.pending = new Map();
    this.timer = null;
    this.fairFn = null; // modelo principal inyectado desde index (FAIR con TWAP de Chainlink)
    this.stats = { markets: 0, written: 0, resolved_gamma: 0, resolved_fallback: 0, errors: 0 };
    try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  }

  // fn(gammaId, nowMs) → { p, strike, src, sigma } | null. Si no hay, se usa el modelo propio (Binance).
  setFairFn(fn) { this.fairFn = typeof fn === 'function' ? fn : null; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this._sample(); } catch (e) { this.stats.errors++; logger.warn(`sample error: ${e.message}`); }
    }, this.sampleMs);
    logger.info(`[SHADOW] ✅ Modo sombra activo — muestreo ${this.sampleMs}ms, umbral de decisión ${(DECISION_EDGE * 100).toFixed(0)} pts`);
  }

  startMarket({ marketId, gammaId, question, endTs, yesTokenId, noTokenId, botStrike }) {
    if (!gammaId || !endTs || !yesTokenId || !noTokenId) return;
    if (this.cur && this.cur.gammaId === gammaId) return;
    if (this.cur) this._close(this.cur);
    const startTs = endTs - 300000;
    this.stats.markets++;
    this.cur = {
      marketId, gammaId, question, startTs, endTs, yesTokenId, noTokenId,
      botStrike: botStrike || null, activatedAt: Date.now(),
      strike: null, strikeSource: null,
      rtdsAtStart: this.rtds?.getLatestTWAP?.(30)?.value_num ?? null,
      rows: [], first: {}, maxEdge: { UP: null, DOWN: null }, path: {},
      signals: { UP: 0, DOWN: 0 }, firstSignal: { UP: null, DOWN: null }, trades: [],
      sigmaSum: 0, sigmaN: 0, closed: false, srcCount: [0, 0],
    };
  }

  // Cada vez que el bot genera una señal (antes de filtros)
  recordBotSignal(direction) {
    const m = this.cur;
    if (!m || (direction !== 'UP' && direction !== 'DOWN')) return;
    const now = Date.now();
    if (now < m.startTs || now > m.endTs) return;
    m.signals[direction]++;
    if (!m.firstSignal[direction]) {
      m.firstSignal[direction] = { t: Math.round((now - m.startTs) / 1000), secs_left: Math.round((m.endTs - now) / 1000) };
    }
  }

  // Cada vez que el bot abre una posición
  recordBotTrade({ direction, price, zScore, posId }) {
    const m = this.cur;
    if (!m || m.closed) return;
    const now = Date.now();
    const p = this._pNow(m, now);
    const pSide = p == null ? null : (direction === 'UP' ? p : 1 - p);
    const edge = pSide == null || price == null ? null : pSide - price;
    m.trades.push({
      pos_id: posId || null, dir: direction, price: rnd(price, 4),
      t: Math.round((now - m.startTs) / 1000), secs_left: Math.round((m.endTs - now) / 1000),
      z: rnd(zScore, 2), model_p: rnd(pSide, 4), model_edge: rnd(edge, 4),
      model_would_enter: edge == null ? null : edge >= DECISION_EDGE,
    });
    logger.info(`[SHADOW] bot ${direction} @ $${price?.toFixed(3)} — modelo: P=${pSide == null ? 'n/a' : (pSide * 100).toFixed(1) + '%'} ventaja=${edge == null ? 'n/a' : (edge * 100).toFixed(1) + ' pts'} → ${edge == null ? 'sin dato' : edge >= DECISION_EDGE ? 'también entraría' : 'NO entraría'}`);
  }

  getStats() { return { ...this.stats, pending: this.pending.size, current: this.cur?.question || null }; }

  // ───────────────────────────────────────────────────────────────────────
  _strike(m) {
    if (m.strike == null) {
      const k = this.fv.priceAt(m.startTs);
      if (k) { m.strike = k; m.strikeSource = 'binance_at_start'; }
      else if (m.botStrike) { m.strike = m.botStrike; m.strikeSource = 'bot_captured'; }
    }
    return m.strike;
  }

  // Tope del libro de un token. Un nivel sin cambios sigue valiendo mientras el
  // socket esté conectado; se descarta si pasó >15s sin ningún update.
  _top(tokenId, now) {
    if (!this.poly?._connected) return null;
    const row = this.poly._topOfBook?.get(tokenId);
    if (!row || now - row.updatedAt > 15000) return null;
    return { bid: row.bestBid ?? null, ask: row.bestAsk ?? null };
  }

  // Probabilidad del modelo: primero el FAIR del bot (TWAP Chainlink); si no hay dato, spot de Binance
  _fair(m, now) {
    if (this.fairFn) {
      try {
        const r = this.fairFn(m.gammaId, now);
        if (r && r.p != null && Number.isFinite(r.p)) {
          if (r.src === 'chainlink_twap' && r.strike) { m.strike = r.strike; m.strikeSource = 'chainlink_twap_60s'; }
          return { p: r.p, sigma: r.sigma ?? null, src: r.src === 'chainlink_twap' ? 1 : 0 };
        }
      } catch (e) { this.stats.errors++; }
    }
    const K = m.strikeSource === 'chainlink_twap_60s' ? null : this._strike(m);
    const fresh = this.fv.lastPrice && now - this.fv.lastTs < 5000;
    if (!K || !fresh) return null;
    const sigma = this.fv.sigma(now);
    const p = probUp(this.fv.lastPrice, K, (m.endTs - now) / 1000, sigma);
    return p == null ? null : { p, sigma, src: 0 };
  }

  _pNow(m, now) { return this._fair(m, now)?.p ?? null; }

  _sample() {
    const m = this.cur;
    if (!m) return;
    const now = Date.now();
    if (now > m.endTs + 1500) { this._close(m); this.cur = null; return; }
    if (now < m.startTs || now > m.endTs) return;

    if (m.strike == null) this._strike(m); // respaldo hasta que haya strike TWAP
    const fresh = this.fv.lastPrice && now - this.fv.lastTs < 5000;
    const S = fresh ? this.fv.lastPrice : null;
    const T = (m.endTs - now) / 1000;
    const F = this._fair(m, now);
    const p = F?.p ?? null, sigma = F?.sigma ?? null;
    const K = m.strike;

    // Book: solo si el WS está conectado y en los tokens de ESTE mercado
    const same = this.poly?._yesTokenId === m.yesTokenId;
    const Y = same ? this._top(m.yesTokenId, now) : null;
    const N = same ? this._top(m.noTokenId, now) : null;
    const yesAsk = Y?.ask ?? null, yesBid = Y?.bid ?? null;
    const noAsk = N?.ask ?? null, noBid = N?.bid ?? null;
    const imb = same ? (this.poly.getDepthImbalance?.()?.imb ?? null) : null;

    const t = Math.round((now - m.startTs) / 1000);
    m.rows.push([t, rnd(T, 1), rnd(S, 2), rnd(p, 4), yesBid, yesAsk, noBid, noAsk, rnd(sigma == null ? null : sigma * 1e6, 3), imb, F ? F.src : null]);
    if (F) m.srcCount[F.src]++;
    if (sigma) { m.sigmaSum += sigma; m.sigmaN++; }

    // Foto cada 30s: cómo se movió el mercado
    const bucket = Math.floor(t / 30) * 30;
    if (!m.path[bucket] && S) {
      // btc_move_pct solo si el strike es de Binance (el TWAP de Chainlink está en otra escala: USD vs USDT)
      const move = K && String(m.strikeSource).startsWith('binance') ? rnd((S / K - 1) * 100, 4) : null;
      m.path[bucket] = { t, btc: rnd(S, 2), btc_move_pct: move, p_up: rnd(p, 4), yes_bid: yesBid, yes_ask: yesAsk, no_bid: noBid, no_ask: noAsk };
    }

    if (p == null) return;
    const edges = {
      UP: yesAsk != null ? { edge: p - yesAsk, ask: yesAsk, p } : null,
      DOWN: noAsk != null ? { edge: (1 - p) - noAsk, ask: noAsk, p: 1 - p } : null,
    };
    for (const side of ['UP', 'DOWN']) {
      const e = edges[side];
      if (e && (!m.maxEdge[side] || e.edge > m.maxEdge[side].edge)) {
        m.maxEdge[side] = { edge: rnd(e.edge, 4), t, secs_left: Math.round(T), ask: e.ask, p: rnd(e.p, 4) };
      }
    }
    if (T >= MIN_SECS) {
      const best = [edges.UP && { side: 'UP', ...edges.UP }, edges.DOWN && { side: 'DOWN', ...edges.DOWN }]
        .filter(Boolean).sort((a, b) => b.edge - a.edge)[0];
      if (best) {
        for (const thr of THRESHOLDS) {
          if (!m.first[thr] && best.edge >= thr) {
            m.first[thr] = { side: best.side, t, secs_left: Math.round(T), ask: best.ask, p: rnd(best.p, 4), edge: rnd(best.edge, 4) };
          }
        }
      }
    }
  }

  _close(m) {
    if (m.closed) return;
    m.closed = true;
    m.btcClose = this.fv.priceAt(m.endTs);
    // Chequeo spot-vs-spot solo con strike de Binance (con strike TWAP no es comparable)
    const K = String(m.strikeSource).startsWith('binance') ? m.strike : null;
    m.btcWinner = m.btcClose && K ? (m.btcClose >= K ? 'UP' : 'DOWN') : null;
    this.pending.set(m.gammaId, m);
    setTimeout(() => this._resolve(m, 0), 30000);
  }

  async _resolve(m, attempt) {
    let winner = null, source = null, prices = null, closed = false;
    try {
      const res = await fetch(`${GAMMA}/markets/${m.gammaId}`);
      if (res.ok) {
        const data = await res.json();
        prices = typeof data.outcomePrices === 'string' ? JSON.parse(data.outcomePrices) : data.outcomePrices;
        closed = data.closed === true;
        const up = parseFloat(prices?.[0]), dn = parseFloat(prices?.[1]);
        if (closed && up >= 0.99) { winner = 'UP'; source = 'gamma'; }
        else if (closed && dn >= 0.99) { winner = 'DOWN'; source = 'gamma'; }
      }
    } catch (e) { logger.debug(`[SHADOW] gamma error ${m.gammaId}: ${e.message}`); }

    if (!winner && attempt < 45) {                 // reintentar cada 20s, hasta ~15 min
      setTimeout(() => this._resolve(m, attempt + 1), 20000);
      return;
    }
    if (!winner) {                                  // sin resolución oficial: mejor dato disponible, marcado
      const up = parseFloat(prices?.[0]), dn = parseFloat(prices?.[1]);
      if (up >= 0.95) { winner = 'UP'; source = 'gamma_prices_unclosed'; }
      else if (dn >= 0.95) { winner = 'DOWN'; source = 'gamma_prices_unclosed'; }
      else if (m.btcWinner) { winner = m.btcWinner; source = 'btc_binance'; }
    }
    source === 'gamma' ? this.stats.resolved_gamma++ : this.stats.resolved_fallback++;
    this.pending.delete(m.gammaId);
    this._write(m, winner, source);
  }

  _write(m, winner, source) {
    const W = (side) => winner ? side === winner : null;
    const summary = {
      v: 1,
      market_id: m.marketId, gamma_id: m.gammaId, question: m.question,
      start_ts: m.startTs, end_ts: m.endTs,
      activation_delay_s: rnd((m.activatedAt - m.startTs) / 1000, 1),
      strike: m.strike, strike_source: m.strikeSource, bot_strike: m.botStrike,
      rtds_twap30_at_start: m.rtdsAtStart,
      btc_close: m.btcClose, btc_winner: m.btcWinner,
      winner, winner_source: source,
      sigma_avg_e6: m.sigmaN ? rnd(m.sigmaSum / m.sigmaN * 1e6, 3) : null,
      samples: m.rows.length,
      model_src: { chainlink_twap: m.srcCount[1], binance: m.srcCount[0] },
      path: Object.keys(m.path).map(Number).sort((a, b) => a - b).map(k => m.path[k]),
      model: {
        decision_edge: DECISION_EDGE,
        first: THRESHOLDS.map(thr => {
          const f = m.first[thr];
          if (!f) return { thr, side: null };
          const win = W(f.side);
          return { thr, ...f, win, pnl_token: pnl(win, f.ask) };
        }),
        max_edge_up: m.maxEdge.UP, max_edge_down: m.maxEdge.DOWN,
      },
      bot: {
        signals: m.signals, first_signal: m.firstSignal,
        trades: m.trades.map(tr => { const win = W(tr.dir); return { ...tr, win, pnl_token: pnl(win, tr.price) }; }),
      },
    };
    const ticks = { v: 1, market_id: m.marketId, gamma_id: m.gammaId, start_ts: m.startTs, end_ts: m.endTs, strike: m.strike, winner, cols: COLS, rows: m.rows };

    fs.promises.appendFile(MARKETS_FILE, JSON.stringify(summary) + '\n').catch(e => logger.warn(`[SHADOW] write markets: ${e.message}`));
    fs.promises.appendFile(TICKS_FILE, JSON.stringify(ticks) + '\n').catch(e => logger.warn(`[SHADOW] write ticks: ${e.message}`));
    this.stats.written++;

    // Línea legible para leer desde los logs de Railway
    const hhmm = new Date(m.startTs).toISOString().slice(11, 16);
    const f = summary.model.first.find(x => x.thr === DECISION_EDGE) || summary.model.first[1];
    const modelTxt = f?.side
      ? `${f.side}@$${f.ask} P=${(f.p * 100).toFixed(0)}% +${(f.edge * 100).toFixed(1)}pts a ${f.secs_left}s → ${f.win == null ? '?' : f.win ? 'GANA' : 'PIERDE'}`
      : 'no entraba';
    const botTxt = summary.bot.trades.length
      ? summary.bot.trades.map(tr => `${tr.dir}@$${tr.price} (modelo ${tr.model_edge == null ? 'n/a' : (tr.model_edge >= 0 ? '+' : '') + (tr.model_edge * 100).toFixed(1) + 'pts'}) → ${tr.win == null ? '?' : tr.win ? 'GANA' : 'PIERDE'}`).join(', ')
      : 'sin trade';
    logger.info(`[SHADOW] ${hhmm}UTC ganó ${winner || '?'} (${source || 'sin dato'}) | modelo: ${modelTxt} | bot: ${botTxt}`);
    logger.info(`[SHADOW-JSON] ${JSON.stringify(summary)}`);
  }
}

module.exports = { Shadow, MARKETS_FILE, TICKS_FILE, COLS, THRESHOLDS };
