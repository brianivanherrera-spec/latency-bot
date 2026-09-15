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
      // Intentar formato 1: topic + type (formato original docs)
      const subMsg = JSON.stringify({
        action: 'subscribe',
        subscriptions: [
          { topic: 'crypto_prices_twap_thirty' },
          { topic: 'crypto_prices_twap_sixty'  },
        ]
      });
      this.ws.send(subMsg);
      logger.info(`[RTDS] Suscripción enviada (formato simple): ${subMsg}`);
      this._msgCount = 0;
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('PING');
      }, PING_MS);
    });
    this.ws.on('message', (data) => {
      const received_ts = Date.now();
      const raw = data.toString();
      if (raw === 'PONG') return;
      // Log primeros 15 mensajes para diagnosticar formato del RTDS
      this._msgCount = (this._msgCount || 0) + 1;
      if (this._msgCount <= 15) {
        logger.info(`[RTDS] MSG #${this._msgCount}: ${raw.slice(0, 300)}`);
      }
      try { this._handle(JSON.parse(raw), received_ts); } catch(e) {
        logger.warn(`[RTDS] Parse error: ${e.message} | raw: ${raw.slice(0, 100)}`);
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
    let window_s = null;
    if (topic === 'crypto_prices_twap_thirty') window_s = 30;
    else if (topic === 'crypto_prices_twap_sixty') window_s = 60;
    else return;
    const source_ts = payload.timestamp || null;
    if (!source_ts) this.diag.missing_ts++;
    const value_num = parseFloat(String(payload.value ?? '0'));
    if (isNaN(value_num) || value_num < BTC_MIN || value_num > BTC_MAX) {
      this.diag.out_of_range++;
      logger.warn(`[RTDS] Valor fuera de rango: ${payload.value} window=${window_s}s`);
      return;
    }
    if (source_ts && (received_ts - source_ts) > STALE_MS) this.diag.stale++;
    const prev = this._last[window_s];
    if (prev && source_ts && prev.source_ts === source_ts) { this.diag.duplicates++; return; }
    if (prev?.source_ts && source_ts && (source_ts - prev.source_ts) > 5000) {
      this.diag.gaps++;
      logger.warn(`[RTDS] Gap ${source_ts - prev.source_ts}ms en TWAP ${window_s}s`);
    }
    const event = {
      source: 'chainlink_rtds', symbol: payload.symbol || 'btc/usd',
      window_s, value: String(payload.value), value_num, source_ts, received_ts,
      outer_ts: msg.timestamp || null,
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
