/**
 * ChainlinkRTDS — Polymarket Real-Time Data Service
 * Suscribe a wss://ws-live-data.polymarket.com
 * Recibe TWAP 30s y 60s de Chainlink para BTC/USD sin credenciales.
 * NO modifica la lógica de trading. Fuente observacional pura.
 */
'use strict';
const WebSocket = require('ws');
const { Logger } = require('./logger');
const logger = new Logger('CHAINLINK-RTDS');
const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const PING_MS = 5000;
const BTC_MIN = 1000, BTC_MAX = 10_000_000;
const STALE_MS = 10000;
// Sin datos de precio en este tiempo con el socket "abierto" → se corta y reconecta.
// Antes un socket colgado (abierto pero sin mensajes) dejaba el TWAP congelado sin aviso.
const STALE_RECONNECT_MS = parseInt(process.env.CHAINLINK_STALE_MS || '30000');
const RTDS_LATENCY_WARN_MS = parseInt(process.env.RTDS_LATENCY_WARN_MS || '3000');

// Timestamps de fuente en ms (RTDS y PolyBolt mandan ms; por las dudas, segundos → ms)
const toMs = t => { const n = Number(t); return n > 1e12 ? n : n * 1000; };

class ChainlinkRTDS {
  constructor() {
    this.ws = null;
    this._connected = false;
    this._intentionalClose = false;
    this._reconnectDelay = 1000;
    this._pingTimer = null;
    this._last = { 30: null, 60: null };
    this._hist = { 30: [], 60: [] }; // [{ ts (fuente, ms), value }] últimos 15 min
    this._onUpdate = null;
    // Por fuente del TWAP 60 s (modo dual: RTDS y PolyBolt alimentan este mismo historial):
    // puntos que entraron primero desde cada una, repetidos y cuándo llegó el último
    this.bySrc = {};
    this.diag = {
      connected_30s: false, connected_60s: false,
      events_30s: 0, events_60s: 0,
      duplicates: 0, gaps: 0, out_of_range: 0, missing_ts: 0, stale: 0,
      last_received_30s: null, last_received_60s: null, disconnections: 0,
    };
  }
  onUpdate(cb) { this._onUpdate = cb; }
  _srcStat(src, accepted, received_ts) {
    const s = this.bySrc[src] || (this.bySrc[src] = { first: 0, dup: 0, last: 0 });
    if (accepted) s.first++; else s.dup++;
    s.last = received_ts;
  }
  getLatestTWAP(w) { return this._last[w] || null; }
  // TWAP publicado por Chainlink con timestamp de fuente <= tsMs (máx. maxGapMs antes)
  getTwapAt(w, tsMs, maxGapMs = 5000) {
    const h = this._hist[w] || [];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].ts <= tsMs) return tsMs - h[i].ts <= maxGapMs ? h[i].value : null;
    }
    return null;
  }
  // TWAP en tsMs interpolado entre el último punto anterior y el primero posterior, cuando
  // el feed tuvo un hueco justo en tsMs (desconexión, "Gap 8000ms"). El TWAP de 60 s es un
  // promedio móvil y cambia poco en unos segundos: con los dos puntos a <= maxSideMs el
  // error es de centavos. null si falta alguno de los dos lados.
  getTwapInterp(w, tsMs, maxSideMs = 12000) {
    const h = this._hist[w] || [];
    let a = null, b = null;
    for (const p of h) {
      if (p.ts <= tsMs) a = p;
      else { b = p; break; }
    }
    if (!a || !b || tsMs - a.ts > maxSideMs || b.ts - tsMs > maxSideMs) return null;
    if (a.ts === tsMs) return a.value;
    return a.value + (b.value - a.value) * (tsMs - a.ts) / (b.ts - a.ts);
  }
  // true si ya llegó un TWAP con timestamp de fuente >= tsMs: recién ahí el valor de
  // getTwapAt(w, tsMs) es el del segundo exacto y no el del segundo anterior.
  hasTwapAfter(w, tsMs) {
    const h = this._hist[w] || [];
    return h.length > 0 && h[h.length - 1].ts >= tsMs;
  }
  _record(w, tsMs, value) {
    if (!tsMs) return;
    const ts = tsMs > 1e12 ? tsMs : tsMs * 1000;
    const h = this._hist[w];
    if (h.length && ts <= h[h.length - 1].ts) return;
    h.push({ ts, value });
    while (h.length && h[0].ts < ts - 15 * 60000) h.shift();
  }
  connect() {
    if (this._connected || this._intentionalClose) return;
    this._connectOnce();
  }
  close() {
    this._intentionalClose = true;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this.ws) this.ws.terminate();
  }
  _connectOnce() {
    try { this.ws = new WebSocket(RTDS_URL); } catch(e) {
      logger.error(`[RTDS] WS create error: ${e.message}`);
      setTimeout(() => this._connectOnce(), this._reconnectDelay);
      return;
    }
    this.ws.on('open', () => {
      logger.info('[RTDS] ✅ Conectado a Polymarket RTDS (Chainlink TWAP 30s+60s)');
      this._connected = true; this._reconnectDelay = 1000;
      // Formato correcto según docs oficiales: topic, type="*", filters=JSON string
      // Los topics crypto_prices_twap_thirty y crypto_prices_twap_sixty están en el SDK oficial
      const subMsg = JSON.stringify({
        action: 'subscribe',
        subscriptions: [
          { topic: 'crypto_prices_twap_thirty', type: '*', filters: '{"symbol":"btc/usd"}' },
          { topic: 'crypto_prices_twap_sixty',  type: '*', filters: '{"symbol":"btc/usd"}' },
        ]
      });
      this.ws.send(subMsg);
      logger.info(`[RTDS] Suscripción enviada: ${subMsg}`);
      this._openedAt = Date.now();
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        const lastData = Math.max(this._openedAt, this.diag.last_received_30s || 0, this.diag.last_received_60s || 0);
        if (Date.now() - lastData > STALE_RECONNECT_MS) {
          logger.warn(`[RTDS] ⚠️ Sin datos hace ${((Date.now() - lastData) / 1000).toFixed(0)}s con el socket abierto — reconectando`);
          this.diag.stale_reconnects = (this.diag.stale_reconnects || 0) + 1;
          this.ws.terminate(); // dispara 'close' → reconexión
          return;
        }
        this.ws.send('PING');
      }, 3000); // 3s — reduce detección de caídas vs 5s original
    });
    this.ws.on('message', (data) => {
      const received_ts = Date.now();
      const raw = data.toString();
      // PONG, y el mensaje vacío que llega al reconectar (el servidor corta cada ~2 h con 1001)
      if (raw === 'PONG' || !raw.trim()) return;
      // NO loguear cada MSG — overhead de I/O causaba 1-2s de latencia
      try { this._handle(JSON.parse(raw), received_ts); } catch(e) {
        logger.warn(`[RTDS] Parse error: ${e.message}`);
      }
    });
    this.ws.on('close', (code) => {
      this._connected = false; this.diag.disconnections++;
      if (this._pingTimer) clearInterval(this._pingTimer);
      if (!this._intentionalClose) {
        logger.warn(`[RTDS] Desconectado (${code}). Reconectando...`);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
        setTimeout(() => this._connectOnce(), this._reconnectDelay);
      }
    });
    this.ws.on('error', (e) => logger.error(`[RTDS] Error: ${e.message}`));
  }
  _handle(msg, received_ts) {
    const topic = msg.topic || '';
    const payload = msg.payload;
    if (!payload) return;
    const src = msg.src || 'rtds';
    if (received_ts == null) received_ts = Date.now();

    // Formato real del RTDS: llegan 2 mensajes por segundo (30s y 60s)
    // sin campo topic en los updates — se identifica por alternancia
    // MSG de snapshot (type=subscribe): payload.data = array de historico
    // MSG de update: payload = { full_accuracy_value, symbol, timestamp, value }
    let window_s = null;
    if (topic === 'crypto_prices_twap_thirty') window_s = 30;
    else if (topic === 'crypto_prices_twap_sixty') window_s = 60;
    else if (!topic && payload.symbol) {
      // Sin topic — alternar entre 30s y 60s basándonos en el contador de mensajes
      // Los mensajes llegan en pares: par con mismo timestamp → 30s y 60s
      // Usamos el _msgPairTracker para identificar cuál es cuál
      const ts = payload.timestamp;
      if (!this._pairTs || this._pairTs !== ts) {
        // Nuevo timestamp → es el primero del par (30s)
        this._pairTs = ts;
        window_s = 30;
      } else {
        // Mismo timestamp que el anterior → es el segundo del par (60s)
        this._pairTs = null;
        window_s = 60;
      }
    }

    if (!window_s) return;

    // Snapshot inicial (array de histórico)
    if (Array.isArray(payload.data)) {
      for (const pt of payload.data) {
        const v = parseFloat(String(pt.value));
        if (!isNaN(v) && v > BTC_MIN && v < BTC_MAX) this._record(window_s, Number(pt.timestamp), v);
      }
      if (payload.data.length > 0) {
        const last = payload.data[payload.data.length - 1];
        const value_num = parseFloat(String(last.value));
        if (isNaN(value_num) || value_num < 1000 || value_num > 10_000_000) return;
        const event = {
          source: 'chainlink_rtds', symbol: payload.symbol || 'btc/usd',
          window_s, value: String(last.full_accuracy_value || last.value), value_num,
          source_ts: last.timestamp || null, received_ts,
          outer_ts: msg.timestamp || null, type: 'snapshot',
          timestamp_quality: 'good',
        };
        // En modo dual la otra fuente pudo haber traído puntos más nuevos: no retroceder
        const prevSnap = this._last[window_s];
        if (prevSnap?.source_ts && last.timestamp && toMs(last.timestamp) < toMs(prevSnap.source_ts)) return;
        this._last[window_s] = event;
        if (window_s === 30) { this.diag.events_30s++; this.diag.connected_30s = true; this.diag.last_received_30s = received_ts; }
        else                 { this.diag.events_60s++; this.diag.connected_60s = true; this.diag.last_received_60s = received_ts; }
        if (this._onUpdate) this._onUpdate(event);
      }
      return;
    }

    // Update individual
    const source_ts = payload.timestamp || null;
    if (!source_ts) this.diag.missing_ts++;

    // Medir latencia real — loguear solo si supera RTDS_LATENCY_WARN_MS (default 3000).
    // Con 2000ms avisaba cada ~10s: la llegada normal de Chainlink es p50 ~1.4s, p90 ~1.9s.
    if (source_ts) {
      const latency_ms = received_ts - source_ts;
      const now = Date.now();
      const lastLogTime = this._lastLatencyLogTime || 0;
      if (latency_ms > RTDS_LATENCY_WARN_MS && (now - lastLogTime) > 10000) {
        logger.warn(`[RTDS] Alta latencia: ${latency_ms}ms (window=${window_s}s)`);
        this._lastLatencyLogTime = now;
      }
    }

    // Preferir full_accuracy_value pero está en wei — usar value (float)
    const value_num = parseFloat(String(payload.value || 0));
    if (isNaN(value_num) || value_num < 1000 || value_num > 10_000_000) {
      this.diag.out_of_range++;
      logger.warn(`[RTDS] Valor fuera de rango: ${payload.value} window=${window_s}s`);
      return;
    }

    if (source_ts && (received_ts - source_ts) > 10000) this.diag.stale++;

    const prev = this._last[window_s];
    // Repetido (mismo segundo y valor: en modo dual la otra fuente ya lo trajo) o más viejo
    // que el último (fuera de orden): no entra
    if (prev && source_ts && prev.source_ts && (toMs(source_ts) < toMs(prev.source_ts) ||
        (toMs(source_ts) === toMs(prev.source_ts) && Math.abs(prev.value_num - value_num) < 0.005))) {
      this.diag.duplicates++;
      if (window_s === 60) this._srcStat(src, false, received_ts);
      return;
    }
    if (prev?.source_ts && source_ts && (source_ts - prev.source_ts) > 5000) {
      this.diag.gaps++;
      logger.warn(`[RTDS] Gap ${source_ts - prev.source_ts}ms en TWAP ${window_s}s`);
    }

    const event = {
      source: 'chainlink_rtds', symbol: payload.symbol || 'btc/usd',
      window_s, value: String(payload.full_accuracy_value || payload.value), value_num,
      source_ts, received_ts, outer_ts: msg.timestamp || null, type: 'update',
      timestamp_quality: source_ts ? ((received_ts - source_ts) < 2000 ? 'good' : 'stale') : 'no_source_ts',
    };

    this._last[window_s] = event;
    this._record(window_s, Number(source_ts), value_num);
    if (window_s === 60) this._srcStat(src, true, received_ts);
    if (window_s === 30) { this.diag.events_30s++; this.diag.connected_30s = true; this.diag.last_received_30s = received_ts; }
    else                 { this.diag.events_60s++; this.diag.connected_60s = true; this.diag.last_received_60s = received_ts; }
    if (this._onUpdate) this._onUpdate(event);
  }
  getDiag() {
    const now = Date.now();
    return { ...this.diag, connected: this._connected,
      age_30s_ms: this.diag.last_received_30s ? now - this.diag.last_received_30s : null,
      age_60s_ms: this.diag.last_received_60s ? now - this.diag.last_received_60s : null,
      latest_twap_30s: this._last[30]?.value ?? null,
      latest_twap_60s: this._last[60]?.value ?? null,
    };
  }
}
module.exports = { ChainlinkRTDS };
