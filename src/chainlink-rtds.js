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

class ChainlinkRTDS {
  constructor() {
    this.ws = null;
    this._connected = false;
    this._intentionalClose = false;
    this._reconnectDelay = 1000;
    this._pingTimer = null;
    this._last = { 30: null, 60: null };
    this._onUpdate = null;
    this.diag = {
      connected_30s: false, connected_60s: false,
      events_30s: 0, events_60s: 0,
      duplicates: 0, gaps: 0, out_of_range: 0, missing_ts: 0, stale: 0,
      last_received_30s: null, last_received_60s: null, disconnections: 0,
    };
  }
  onUpdate(cb) { this._onUpdate = cb; }
  getLatestTWAP(w) { return this._last[w] || null; }
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
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('PING');
      }, 3000); // 3s — reduce detección de caídas vs 5s original
    });
    this.ws.on('message', (data) => {
      const received_ts = Date.now();
      const raw = data.toString();
      if (raw === 'PONG') return;
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

    // Medir latencia real — loguear solo si supera 2000ms (reduce spam)
    if (source_ts) {
      const latency_ms = received_ts - source_ts;
      const now = Date.now();
      const lastLogTime = this._lastLatencyLogTime || 0;
      if (latency_ms > 2000 && (now - lastLogTime) > 10000) {
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
    if (prev && source_ts && prev.source_ts === source_ts && prev.value_num === value_num) {
      this.diag.duplicates++; return;
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
