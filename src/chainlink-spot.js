/**
 * ChainlinkSpot — precio spot BTC/USD de Chainlink vía Polymarket RTDS.
 * Es la fuente con la que Polymarket resuelve los mercados BTC Up/Down:
 * "Price to Beat" = precio al inicio de la ventana; UP si el cierre es >= inicio.
 * Conexión separada de chainlink-rtds.js (TWAP): ese parser distingue 30s/60s
 * por alternancia de mensajes y un tercer tópico en el mismo socket lo rompería.
 */
'use strict';
const WebSocket = require('ws');
const { Logger } = require('./logger');
const logger = new Logger('CHAINLINK-SPOT');

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const HISTORY_MS = 15 * 60 * 1000;
// Sin precios en este tiempo con el socket "abierto" → se corta y reconecta
const STALE_RECONNECT_MS = parseInt(process.env.CHAINLINK_STALE_MS || '30000');

class ChainlinkSpot {
  constructor() {
    this.ws = null;
    this._pingTimer = null;
    this._reconnectDelay = 1000;
    this._history = []; // [{ ts (ms, fuente), value, received }] ordenado por ts
    this._firstLogged = false;
    this._onUpdate = null;
    this.bySrc = {}; // modo dual: puntos que entraron primero por fuente, repetidos y el último
  }

  onUpdate(cb) { this._onUpdate = cb; }
  _srcStat(src, accepted, received) {
    const s = this.bySrc[src] || (this.bySrc[src] = { first: 0, dup: 0, last: 0 });
    if (accepted) s.first++; else s.dup++;
    s.last = received;
  }

  connect() {
    try { this.ws = new WebSocket(RTDS_URL); } catch (e) {
      logger.error(`[SPOT] WS create error: ${e.message}`);
      setTimeout(() => this.connect(), this._reconnectDelay);
      return;
    }
    this.ws.on('open', () => {
      this._reconnectDelay = 1000;
      this.ws.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }],
      }));
      logger.info('[SPOT] ✅ Conectado — suscripto a crypto_prices_chainlink btc/usd');
      this._lastDataTs = Date.now();
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this._lastDataTs > STALE_RECONNECT_MS) {
          logger.warn(`[SPOT] ⚠️ Sin precios hace ${((Date.now() - this._lastDataTs) / 1000).toFixed(0)}s con el socket abierto — reconectando`);
          this.ws.terminate(); // dispara 'close' → reconexión
          return;
        }
        this.ws.send('PING');
      }, 5000);
    });
    this.ws.on('message', (data) => {
      const raw = data.toString();
      if (raw === 'PONG' || !raw.startsWith('{')) return;
      try { this._handle(JSON.parse(raw)); } catch (_) { /* mensajes parciales/no JSON */ }
    });
    this.ws.on('close', (code) => {
      if (this._pingTimer) clearInterval(this._pingTimer);
      logger.warn(`[SPOT] Desconectado (${code}). Reconectando...`);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
      setTimeout(() => this.connect(), this._reconnectDelay);
    });
    this.ws.on('error', (e) => logger.error(`[SPOT] Error: ${e.message}`));
  }

  _handle(msg) {
    if (msg.topic && msg.topic !== 'crypto_prices_chainlink') return;
    const p = msg.payload;
    if (!p) return;
    // Snapshot inicial: payload.data = [{ timestamp, value }, ...]
    const points = Array.isArray(p.data) ? p.data : [p];
    const src = msg.src || 'rtds';
    for (const pt of points) {
      const value = parseFloat(pt.value);
      const ts = Number(pt.timestamp);
      if (!(value > 1000 && value < 10_000_000) || !Number.isFinite(ts)) continue;
      const added = this._push(ts > 1e12 ? ts : ts * 1000, value);
      this._lastDataTs = Date.now();
      this._srcStat(src, added, this._lastDataTs);
    }
    if (!this._firstLogged && this._history.length) {
      this._firstLogged = true;
      const last = this._history[this._history.length - 1];
      logger.info(`[SPOT] Primer precio Chainlink BTC/USD: $${last.value.toFixed(2)} (ts ${new Date(last.ts).toISOString()})`);
    }
  }

  // true si el punto entró; false si ya estaba (en modo dual lo trajo la otra fuente)
  _push(ts, value) {
    const h = this._history;
    if (h.length && ts <= h[h.length - 1].ts) {
      if (ts === h[h.length - 1].ts) return false;
      // Fuera de orden (snapshot o la otra fuente): insertar ordenado, sin repetir el segundo
      const i = h.findIndex(x => x.ts >= ts);
      if (i !== -1 && h[i].ts === ts) return false;
      h.splice(i === -1 ? h.length : i, 0, { ts, value, received: Date.now() });
    } else {
      h.push({ ts, value, received: Date.now() });
      if (this._onUpdate) this._onUpdate(h[h.length - 1]);
    }
    const cutoff = Date.now() - HISTORY_MS;
    while (h.length && h[0].ts < cutoff) h.shift();
    return true;
  }

  // Último punto publicado { ts, value, received } o null
  getLast() {
    return this._history[this._history.length - 1] || null;
  }

  // Último precio si su timestamp de fuente no tiene más de maxAgeMs
  getLatest(maxAgeMs = 5000) {
    const last = this._history[this._history.length - 1];
    if (!last || Date.now() - last.ts > maxAgeMs) return null;
    return last.value;
  }

  // Promedio simple de los precios publicados en (endTsMs - windowMs, endTsMs], y cuántos
  // puntos lo forman. Chainlink publica ~1 punto/s, así que aproxima el TWAP de esa ventana.
  // null si hay menos de minCoverage de los puntos esperados.
  getTwap(endTsMs, windowMs = 60000, minCoverage = 0.8) {
    const h = this._history;
    let sum = 0, n = 0;
    for (let i = h.length - 1; i >= 0; i--) {
      const ts = h[i].ts;
      if (ts > endTsMs) continue;
      if (ts <= endTsMs - windowMs) break;
      sum += h[i].value; n++;
    }
    if (n < (windowMs / 1000) * minCoverage) return null;
    return { value: sum / n, n };
  }

  // Último precio publicado en o antes de tsMs (máx. maxGapMs antes)
  getPriceAt(tsMs, maxGapMs = 5000) {
    const h = this._history;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].ts <= tsMs) return tsMs - h[i].ts <= maxGapMs ? h[i].value : null;
    }
    return null;
  }
}

module.exports = { ChainlinkSpot };
