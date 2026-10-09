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
 * Los mercados cerrados que todavía esperan a Gamma se guardan al apagar (/data/shadow-pending.json)
 * y se retoman al arrancar: antes cada reinicio perdía el resultado de 1-2 mercados.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');
const { probUp } = require('./fair-value');
const loopMonitor = require('./loop-monitor');

const logger = new Logger('SHADOW');
const DATA_DIR = process.env.DATA_DIR || '/data';
const MARKETS_FILE = path.join(DATA_DIR, 'shadow-markets.jsonl');
const TICKS_FILE = path.join(DATA_DIR, 'shadow-ticks.jsonl');
const PENDING_FILE = path.join(DATA_DIR, 'shadow-pending.json');
const GAMMA = 'https://gamma-api.polymarket.com';

const THRESHOLDS = [0.03, 0.05, 0.08, 0.12];                         // ventajas a evaluar (fracción = puntos/100)
const DECISION_EDGE = parseFloat(process.env.SHADOW_EDGE || '0.05');  // umbral "el modelo entraría"
// Umbral del filtro FAIR para las entradas reales del bot (aparte del de la sombra).
// 8 pts: en 29/09 (180 mercados, ~6.300 señales) mejoró a 5 pts en los tres tramos del día;
// el modelo sobreestima ~5-10 pts su probabilidad, con 5 pts la ventaja era casi toda ruido.
const GATE_EDGE = parseFloat(process.env.FAIR_GATE_EDGE || '0.08');
// FAIR_GATE_FEE=true descuenta la comisión taker (0.07·p·(1−p) por acción) de la ventaja.
// Default false = como antes.
const GATE_FEE = process.env.FAIR_GATE_FEE === 'true';
const GATE_FEE_RATE = parseFloat(process.env.TAKER_FEE_RATE || '0.07');
const MIN_SECS = parseInt(process.env.SHADOW_MIN_SECS || '10');       // no contar oportunidades con <10s
// Con P(UP) ≈ 0.50 el modelo no sabe nada (spot ≈ strike al abrir) y la "ventaja" es solo la
// inclinación del mercado, que resultó informada: en 200 mercados esas entradas acertaron 19%.
// Variantes que se registran aparte del modelo base (para comparar sin perder el histórico):
//   first_conf:  exige |P − 0.5| ≥ SHADOW_MIN_CONF
//   first_agree: además, solo el lado que el mercado ya favorece (ask ≥ 0.50)
const MIN_CONF = parseFloat(process.env.SHADOW_MIN_CONF || '0.03');
// Estrategia "ventana" (solo registro): segundos del mercado y ventaja mínima
const WINDOW_FROM = parseInt(process.env.SHADOW_WINDOW_FROM || '60');
const WINDOW_TO = parseInt(process.env.SHADOW_WINDOW_TO || '120');
const WINDOW_EDGE = parseFloat(process.env.SHADOW_WINDOW_EDGE || '0.05');
// src: 1 = FAIR del bot con TWAP de Chainlink (cómo resuelve Polymarket), 0 = respaldo con spot de Binance
// z / move_pct: estado de la señal de Binance del bot en ese segundo (SignalEngine.snapshot);
// sig: el bot generó una señal en ese segundo (+1 UP, −1 DOWN, 0 no); pass: intentó comprar ([OPEN]).
// Con eso el backtest evalúa la regla que opera el bot, no solo las reglas del modelo.
const COLS = ['t', 'secs_left', 'btc', 'p_up', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'sigma_e6', 'book_imb', 'src', 'sigma_short_e6', 'sigma_long_e6',
  'z', 'move_pct', 'sig', 'pass'];
// Filtro FAIR "anclado" (solo sombra, no decide): precio justo = último mid de Polymarket + cuánto
// se movió el modelo desde que ese mid cambió por última vez. El nivel lo pone el mercado (que
// predice mejor que el modelo: Brier 0.162 vs 0.184 a 120 s, 528 mercados 03-05/10) y el modelo
// solo aporta el movimiento de Binance que Polymarket todavía no reflejó.
const ANCHOR_EDGE = parseFloat(process.env.FAIR_ANCHOR_EDGE || '0.03');

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
    this.signalFn = null; // () => { z, movePct } | null (SignalEngine.snapshot)
    this.stats = { markets: 0, written: 0, resolved_gamma: 0, resolved_fallback: 0, errors: 0 };
    try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  }

  // fn(gammaId, nowMs) → { p, strike, src, sigma } | null. Si no hay, se usa el modelo propio (Binance).
  setFairFn(fn) { this.fairFn = typeof fn === 'function' ? fn : null; }
  setSignalFn(fn) { this.signalFn = typeof fn === 'function' ? fn : null; }
  // Paper B (src/paper-b.js): segunda cuenta de paper con la regla anclada; recibe cada muestra
  // y el ganador oficial de cada mercado
  setPaperB(pb) { this.paperB = pb || null; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { loopMonitor.time('shadow', () => this._sample()); } catch (e) { this.stats.errors++; logger.warn(`sample error: ${e.message}`); }
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
      rows: [], first: {}, firstConf: {}, firstAgree: {}, firstWindow: null, maxEdge: { UP: null, DOWN: null }, path: {},
      signals: { UP: 0, DOWN: 0 }, firstSignal: { UP: null, DOWN: null }, trades: [],
      secSig: 0, secPass: 0, anchor: null, firstAnchored: null, gateCmp: { both: 0, onlyActual: 0, onlyAnchored: 0, neither: 0 },
      sigmaSum: 0, sigmaN: 0, sigmaShortSum: 0, sigmaShortN: 0, sigmaLongSum: 0, sigmaLongN: 0, closed: false, srcCount: [0, 0],
    };
  }

  // Cada vez que el bot genera una señal (antes de filtros)
  recordBotSignal(direction) {
    const m = this.cur;
    if (!m || (direction !== 'UP' && direction !== 'DOWN')) return;
    const now = Date.now();
    if (now < m.startTs || now > m.endTs) return;
    m.signals[direction]++;
    m.secSig = direction === 'UP' ? 1 : -1;
    if (!m.firstSignal[direction]) {
      m.firstSignal[direction] = { t: Math.round((now - m.startTs) / 1000), secs_left: Math.round((m.endTs - now) / 1000) };
    }
  }

  // Cada vez que el bot abre una posición
  recordBotTrade({ direction, price, zScore, posId }) {
    const m = this.cur;
    if (!m || m.closed) return;
    const now = Date.now();
    m.secPass = direction === 'UP' ? 1 : -1;
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

  // Filtro FAIR para las entradas del bot: ¿el modelo también entraría en este lado a este precio?
  // (ask = precio al que se compraría; el bot pasa el precio real de la orden)
  //   'edge':  ventaja (P del lado − ask) ≥ FAIR_GATE_EDGE (8 pts)
  //   'agree': además ask ≥ 0.50 (solo el lado que el mercado ya favorece; variante first_agree)
  // Sin dato del modelo, o con el shadow en otro mercado, no deja entrar.
  evaluateEntry({ gammaId, direction, ask, mode = 'agree' }) {
    const m = this.cur;
    if (!m || m.closed || (gammaId && m.gammaId !== gammaId)) return { ok: false, reason: 'modelo en otro mercado' };
    if (ask == null || !Number.isFinite(ask)) return { ok: false, reason: 'sin ask' };
    const F = this._fair(m, Date.now());
    const p = F?.p ?? null;
    if (p == null) return { ok: false, reason: 'modelo sin dato' };
    // Con Chainlink caído el modelo usa Binance (strike/spot con ~$25 de base USDT):
    // la probabilidad sale sesgada, así que el filtro no deja entrar.
    if (F.src !== 1 && process.env.FAIR_GATE_ALLOW_BINANCE !== 'true') return { ok: false, reason: 'modelo sin Chainlink (usando Binance)' };
    const pSide = direction === 'UP' ? p : 1 - p;
    const feeAdj = GATE_FEE ? GATE_FEE_RATE * ask * (1 - ask) : 0;
    const edge = pSide - ask - feeAdj;
    const txt = `P=${(pSide * 100).toFixed(1)}% ventaja=${(edge * 100).toFixed(1)} pts${GATE_FEE ? ` (neta de comisión ${(feeAdj * 100).toFixed(1)})` : ''}`;
    if (edge < GATE_EDGE) return { ok: false, p: pSide, edge, reason: `${txt} < ${(GATE_EDGE * 100).toFixed(0)} pts` };
    if (mode === 'agree' && ask < 0.5) return { ok: false, p: pSide, edge, reason: `${txt} pero precio $${ask.toFixed(3)} < 0.50 (lado que el mercado no favorece)` };
    return { ok: true, p: pSide, edge, reason: txt };
  }

  // Sombra del filtro anclado al mercado: no bloquea nada. Se llama en el mismo punto que
  // evaluateEntry con el resultado del filtro actual (actualOk) para comparar los dos.
  evaluateEntryAnchored({ gammaId, direction, ask, actualOk }) {
    const m = this.cur;
    if (!m || m.closed || (gammaId && m.gammaId !== gammaId) || ask == null || !Number.isFinite(ask)) return null;
    const now = Date.now();
    const F = this._fair(m, now);
    const Y = this.poly?._yesTokenId === m.yesTokenId ? this._top(m.yesTokenId, now) : null;
    if (F?.p == null || F.src !== 1 || Y?.bid == null || Y?.ask == null) return null;
    const mid = (Y.bid + Y.ask) / 2;
    // Si el mid cambió desde la última muestra, Polymarket ya está al día: ancla = ahora (Δ = 0)
    const a = m.anchor && Math.abs(m.anchor.mid - mid) < 1e-9 ? m.anchor : { mid, p: F.p, t: now };
    const pAdj = Math.min(0.999, Math.max(0.001, mid + (F.p - a.p)));
    const pSide = direction === 'UP' ? pAdj : 1 - pAdj;
    const edge = pSide - ask - GATE_FEE_RATE * ask * (1 - ask);
    const ok = edge >= ANCHOR_EDGE;
    const key = actualOk ? (ok ? 'both' : 'onlyActual') : (ok ? 'onlyAnchored' : 'neither');
    m.gateCmp[key]++;
    if (ok && !m.firstAnchored) {
      m.firstAnchored = { side: direction, t: Math.round((now - m.startTs) / 1000), secs_left: Math.round((m.endTs - now) / 1000),
        ask: rnd(ask, 4), p_adj: rnd(pSide, 4), edge: rnd(edge, 4), stale_s: rnd((now - a.t) / 1000, 1), actual_ok: !!actualOk };
    }
    return { ok, edge, pSide, staleS: (now - a.t) / 1000 };
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
          return { p: r.p, sigma: r.sigma ?? null, sigmaShort: r.sigmaShort ?? null, sigmaLong: r.sigmaLong ?? null, src: r.src === 'chainlink_twap' ? 1 : 0 };
        }
      } catch (e) { this.stats.errors++; }
    }
    const K = m.strikeSource === 'chainlink_twap_60s' ? null : this._strike(m);
    const fresh = this.fv.lastPrice && now - this.fv.lastTs < 5000;
    if (!K || !fresh) return null;
    const sigma = this.fv.sigma(now);
    const p = probUp(this.fv.lastPrice, K, (m.endTs - now) / 1000, sigma);
    return p == null ? null : { p, sigma, sigmaShort: null, sigmaLong: sigma, src: 0 };
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
    if (yesBid != null && yesAsk != null && p != null && F?.src === 1) {
      const mid = (yesBid + yesAsk) / 2;
      if (!m.anchor || Math.abs(m.anchor.mid - mid) >= 1e-9) m.anchor = { mid, p, t: now };
    }
    if (this.paperB) {
      try { this.paperB.onSample(m, { T, yesBid, yesAsk, noAsk, p, src: F?.src ?? null }); } catch (e) { this.stats.errors++; }
    }
    let snap = null;
    try { snap = this.signalFn ? this.signalFn() : null; } catch (_) {}
    m.rows.push([t, rnd(T, 1), rnd(S, 2), rnd(p, 4), yesBid, yesAsk, noBid, noAsk, rnd(sigma == null ? null : sigma * 1e6, 3), imb, F ? F.src : null,
      rnd(F?.sigmaShort == null ? null : F.sigmaShort * 1e6, 3), rnd(F?.sigmaLong == null ? null : F.sigmaLong * 1e6, 3),
      rnd(snap?.z, 2), rnd(snap?.movePct, 4), m.secSig, m.secPass]);
    m.secSig = 0; m.secPass = 0;
    if (F?.sigmaShort) { m.sigmaShortSum += F.sigmaShort; m.sigmaShortN++; }
    if (F?.sigmaLong) { m.sigmaLongSum += F.sigmaLong; m.sigmaLongN++; }
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
        const entry = { side: best.side, t, secs_left: Math.round(T), ask: best.ask, p: rnd(best.p, 4), edge: rnd(best.edge, 4) };
        const confident = Math.abs(p - 0.5) >= MIN_CONF;
        const agrees = confident && best.ask >= 0.5;
        for (const thr of THRESHOLDS) {
          if (best.edge < thr) continue;
          if (!m.first[thr]) m.first[thr] = entry;
          if (confident && !m.firstConf[thr]) m.firstConf[thr] = entry;
          if (agrees && !m.firstAgree[thr]) m.firstAgree[thr] = entry;
        }
        // Estrategia "ventana": primera oportunidad a favor del mercado con ≥ WINDOW_EDGE entre
        // los segundos WINDOW_FROM y WINDOW_TO del mercado, a precio ≤ $0.80. En 1.706 mercados
        // (25/09-01/10) la primera entrada a favor con ≥ 5 pts que cayó entre 60 y 120 s acertó
        // 76% a $0.63 promedio (91 casos). Solo se registra, no opera.
        if (!m.firstWindow && agrees && best.edge >= WINDOW_EDGE && t >= WINDOW_FROM && t <= WINDOW_TO && best.ask <= 0.80) {
          m.firstWindow = entry;
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

  // Apagado (redeploy): guarda los mercados cerrados que esperan el ganador oficial de Gamma
  savePending(file = PENDING_FILE) {
    const list = [...this.pending.values()];
    try {
      if (!list.length) { if (fs.existsSync(file)) fs.unlinkSync(file); return 0; }
      fs.writeFileSync(file, JSON.stringify(list));
      this.handedOff = true; // los resuelve el proceso nuevo: este ya no los escribe (sin duplicados)
      return list.length;
    } catch (e) { logger.warn(`[SHADOW] no se pudieron guardar los mercados pendientes: ${e.message}`); return 0; }
  }

  // Arranque: retoma los mercados que quedaron esperando a Gamma (hasta 2 h de cerrados)
  restorePending({ file = PENDING_FILE, now = Date.now(), delayMs = 5000 } = {}) {
    let list;
    try {
      if (!fs.existsSync(file)) return 0;
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { logger.warn(`[SHADOW] mercados pendientes ilegibles (${e.message}): se descartan`); list = []; }
    try { fs.unlinkSync(file); } catch (_) {}
    let n = 0;
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || !m.gammaId || !Array.isArray(m.rows) || this.pending.has(m.gammaId) || !(now - m.endTs <= 2 * 3600000)) continue;
      m.closed = true;
      this.pending.set(m.gammaId, m);
      setTimeout(() => this._resolve(m, 0), delayMs);
      n++;
    }
    if (n) logger.info(`[SHADOW] ${n} mercado(s) que cerraron antes del reinicio: se busca su ganador oficial`);
    return n;
  }

  async _resolve(m, attempt) {
    let winner = null, source = null, prices = null, closed = false;
    try {
      const res = await fetch(`${GAMMA}/markets/${m.gammaId}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        prices = typeof data.outcomePrices === 'string' ? JSON.parse(data.outcomePrices) : data.outcomePrices;
        closed = data.closed === true;
        const up = parseFloat(prices?.[0]), dn = parseFloat(prices?.[1]);
        if (closed && up >= 0.99) { winner = 'UP'; source = 'gamma'; }
        else if (closed && dn >= 0.99) { winner = 'DOWN'; source = 'gamma'; }
      }
    } catch (e) { logger.debug(`[SHADOW] gamma error ${m.gammaId}: ${e.message}`); }
    if (this.handedOff) return;

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
    if (this.paperB) { try { this.paperB.onResolved(m.gammaId, winner, source); } catch (e) { this.stats.errors++; } }
    this._write(m, winner, source);
  }

  _write(m, winner, source) {
    const W = (side) => winner ? side === winner : null;
    const firsts = (map) => THRESHOLDS.map(thr => {
      const f = map[thr];
      if (!f) return { thr, side: null };
      const win = W(f.side);
      return { thr, ...f, win, pnl_token: pnl(win, f.ask) };
    });
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
      sigma_short_avg_e6: m.sigmaShortN ? rnd(m.sigmaShortSum / m.sigmaShortN * 1e6, 3) : null,
      sigma_long_avg_e6: m.sigmaLongN ? rnd(m.sigmaLongSum / m.sigmaLongN * 1e6, 3) : null,
      sigma_mode: process.env.FAIR_SIGMA_MODE || 'short',
      samples: m.rows.length,
      model_src: { chainlink_twap: m.srcCount[1], binance: m.srcCount[0] },
      path: Object.keys(m.path).map(Number).sort((a, b) => a - b).map(k => m.path[k]),
      model: {
        decision_edge: DECISION_EDGE,
        min_conf: MIN_CONF,
        first: firsts(m.first),
        first_conf: firsts(m.firstConf),
        first_agree: firsts(m.firstAgree),
        window: m.firstWindow ? (() => { const win = W(m.firstWindow.side); return { ...m.firstWindow, from: WINDOW_FROM, to: WINDOW_TO, min_edge: WINDOW_EDGE, win, pnl_token: pnl(win, m.firstWindow.ask) }; })() : null,
        max_edge_up: m.maxEdge.UP, max_edge_down: m.maxEdge.DOWN,
        anchored: m.firstAnchored ? (() => { const win = W(m.firstAnchored.side); return { ...m.firstAnchored, min_edge: ANCHOR_EDGE, win, pnl_token: pnl(win, m.firstAnchored.ask) }; })() : null,
        gate_cmp: m.gateCmp,
      },
      bot: {
        signals: m.signals, first_signal: m.firstSignal,
        trades: m.trades.map(tr => { const win = W(tr.dir); return { ...tr, win, pnl_token: pnl(win, tr.price) }; }),
      },
    };
    const ticks = { v: 1, market_id: m.marketId, gamma_id: m.gammaId, start_ts: m.startTs, end_ts: m.endTs, strike: m.strike, winner, cols: COLS, rows: m.rows };

    const t0 = Date.now();
    fs.promises.appendFile(MARKETS_FILE, JSON.stringify(summary) + '\n').catch(e => logger.warn(`[SHADOW] write markets: ${e.message}`))
      .finally(() => loopMonitor.observeDisk(Date.now() - t0));
    fs.promises.appendFile(TICKS_FILE, JSON.stringify(ticks) + '\n').catch(e => logger.warn(`[SHADOW] write ticks: ${e.message}`))
      .finally(() => loopMonitor.observeDisk(Date.now() - t0));
    this.stats.written++;

    // Línea legible para leer desde los logs de Railway
    const hhmm = new Date(m.startTs).toISOString().slice(11, 16);
    const pick = arr => arr.find(x => x.thr === DECISION_EDGE) || arr[1];
    const fmt = f => f?.side
      ? `${f.side}@$${f.ask} P=${(f.p * 100).toFixed(0)}% +${(f.edge * 100).toFixed(1)}pts a ${f.secs_left}s → ${f.win == null ? '?' : f.win ? 'GANA' : 'PIERDE'}`
      : 'no entraba';
    const modelTxt = `${fmt(pick(summary.model.first))} | con confianza: ${fmt(pick(summary.model.first_conf))} | a favor del mercado: ${fmt(pick(summary.model.first_agree))} | ventana ${WINDOW_FROM}-${WINDOW_TO}s: ${fmt(summary.model.window)}`;
    const botTxt = summary.bot.trades.length
      ? summary.bot.trades.map(tr => `${tr.dir}@$${tr.price} (modelo ${tr.model_edge == null ? 'n/a' : (tr.model_edge >= 0 ? '+' : '') + (tr.model_edge * 100).toFixed(1) + 'pts'}) → ${tr.win == null ? '?' : tr.win ? 'GANA' : 'PIERDE'}`).join(', ')
      : 'sin trade';
    logger.info(`[SHADOW] ${hhmm}UTC ganó ${winner || '?'} (${source || 'sin dato'}) | modelo: ${modelTxt} | bot: ${botTxt}`);
    logger.info(`[SHADOW-JSON] ${JSON.stringify(summary)}`);
  }
}

module.exports = { Shadow, MARKETS_FILE, TICKS_FILE, PENDING_FILE, COLS, THRESHOLDS };
