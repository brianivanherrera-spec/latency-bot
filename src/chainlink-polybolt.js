/**
 * PolyBolt — WebSocket de precios de referencia de Polymarket (reemplazo de RTDS, que
 * Polymarket marcó como legado el 15/09/2026). wss://ws-live-v2.polymarket.com/ws
 *
 * Protocolo tomado del SDK oficial (@polymarket/client 0.12.0 + @polymarket/bindings
 * 0.12.0: websockets/realtime/socket.ts, subscriptions/polybolt.ts, heartbeat.ts), porque
 * el asyncapi no es accesible desde el entorno donde se escribió:
 *   - auth (credenciales CLOB):  {"op":"auth","auth":{"apiKey","secret","passphrase"},"rid"}
 *       → {"op":"authed","rid"}
 *   - subscribe: {"op":"subscribe","subscriptions":[{"channel","filter"}],"rid"}
 *       canales: price.crypto {symbol} y price.crypto.twap {symbol, window_seconds: 60}
 *       → {"op":"subscribed","channel","rid"} por canal, o {"op":"error","code","channel"}
 *   - mensajes: {"v":1,"channel","seq","ts","snapshot"?,"dropped"?,"payload"}
 *       update: payload {symbol, timestamp (ms), value, full_accuracy_value, window_seconds?}
 *       snapshot: payload {symbol, data:[{timestamp, value, full_accuracy_value}], window_seconds?}
 *   - heartbeat: {"op":"ping"} cada 30 s; sin mensajes 90 s = conexión muerta
 *   - entre frames de control, al menos 110 ms; cierre 4003 → esperar hasta 10 s
 * Símbolos en minúscula terminados en usd: "btcusd". No hay TWAP de 30 s.
 *
 * Solo se usa con CHAINLINK_SOURCE=polybolt|both|dual (default rtds: este archivo no corre).
 */
'use strict';
const WebSocket = require('ws');
const { Logger } = require('./logger');
const logger = new Logger('POLYBOLT');

const URL_PB = process.env.POLYBOLT_URL || 'wss://ws-live-v2.polymarket.com/ws';
const SYMBOL = 'btcusd';
const HISTORY_MS = 15 * 60 * 1000;
const PING_MS = 30_000;
const STALE_MS = 90_000;
const DATA_STALE_MS = parseInt(process.env.CHAINLINK_STALE_MS || '30000');

class PolyBoltClient {
  // getCreds: async () => ({ key, secret, passphrase }) | null
  constructor({ getCreds }) {
    this.getCreds = getCreds;
    this.ws = null;
    this._rid = 0;
    this._reconnectDelay = 1000;
    this._attempt = 0;
    this._timer = null;
    this._lastMsgAt = 0;
    this._lastDataAt = 0;
    this._closed = false;
    this.hist = { spot: [], twap: [] }; // [{ ts (fuente, ms), value, received }]
    this._onSpot = null;
    this._onTwap = null;
    this.diag = { authed: false, subscribed: [], errors: 0, reconnects: 0, spot: 0, twap: 0, dropped: 0, last_error: null };
  }

  onSpot(cb) { this._onSpot = cb; }
  onTwap(cb) { this._onTwap = cb; }

  async connect() {
    if (this._closed) return;
    let creds = null;
    try { creds = await this.getCreds(); } catch (e) { this.diag.last_error = `creds: ${e.message}`; }
    if (!creds?.key || !creds?.secret || !creds?.passphrase) {
      logger.error('[POLYBOLT] Sin credenciales CLOB (POLYBOLT_API_KEY/SECRET/PASSPHRASE o POLY_API_*, o derivadas de POLY_PRIVATE_KEY) — no se conecta');
      this.diag.last_error = 'sin credenciales';
      setTimeout(() => this.connect(), 5 * 60000).unref?.();
      return;
    }
    let ws;
    try { ws = new WebSocket(URL_PB); } catch (e) { return this._scheduleReconnect(0, e.message); }
    this.ws = ws;
    ws.on('open', () => {
      this._lastMsgAt = Date.now();
      this._send({ op: 'auth', auth: { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase } });
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(() => {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (now - this._lastMsgAt >= STALE_MS || (this.diag.authed && now - this._lastDataAt > DATA_STALE_MS)) {
          logger.warn(`[POLYBOLT] Sin datos (msg hace ${now - this._lastMsgAt} ms) — reconectando`);
          try { ws.terminate(); } catch (_) {}
          return;
        }
        if (now - (this._lastPing || 0) >= PING_MS) { this._lastPing = now; this._send({ op: 'ping' }, false); }
      }, 5000);
      this._timer.unref?.();
    });
    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      this._lastMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      this._handle(msg);
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.diag.authed = false;
      this.diag.subscribed = [];
      if (this._closed) return;
      this._scheduleReconnect(code, String(reason || ''));
    });
    ws.on('error', (e) => { this.diag.last_error = e.message; });
  }

  _scheduleReconnect(code, why) {
    this.diag.reconnects++;
    this._attempt++;
    // Igual que el SDK: 4003 → hasta 10 s; resto backoff exponencial con jitter, tope 30 s
    const delay = Math.random() * (code === 4003 ? 10_000 : Math.min(1000 * 2 ** this._attempt, 30_000));
    logger.warn(`[POLYBOLT] Desconectado (${code}${why ? ` ${why}` : ''}) — reconexión en ${Math.round(delay)} ms`);
    setTimeout(() => this.connect(), delay).unref?.();
  }

  // Frames de control con al menos 110 ms entre sí (límite del server)
  _send(frame, withRid = true) {
    const f = withRid ? { ...frame, rid: String(++this._rid) } : frame;
    const wait = Math.max(0, 110 - (Date.now() - (this._lastSent || 0)));
    this._lastSent = Date.now() + wait;
    setTimeout(() => { try { this.ws?.send(JSON.stringify(f)); } catch (_) {} }, wait);
  }

  _handle(msg) {
    // Acks: { op: authed | subscribed | unsubscribed | pong | error, rid?, channel?, code? }
    if (typeof msg.op === 'string' && msg.v === undefined) {
      if (msg.op === 'authed') {
        this.diag.authed = true;
        this._attempt = 0;
        logger.info('[POLYBOLT] ✅ Autenticado — suscribiendo price.crypto y price.crypto.twap (btcusd)');
        this._send({ op: 'subscribe', subscriptions: [
          { channel: 'price.crypto', filter: { symbol: SYMBOL } },
          { channel: 'price.crypto.twap', filter: { symbol: SYMBOL, window_seconds: 60 } },
        ] });
      } else if (msg.op === 'subscribed') {
        this.diag.subscribed.push(msg.channel);
        logger.info(`[POLYBOLT] Suscripto a ${msg.channel}`);
      } else if (msg.op === 'error') {
        this.diag.errors++;
        this.diag.last_error = `${msg.code}${msg.channel ? ` (${msg.channel})` : ''}`;
        logger.error(`[POLYBOLT] Error del server: ${this.diag.last_error}`);
      }
      return;
    }
    if (msg.v !== 1 || !msg.payload) return;
    if (msg.dropped > 0) this.diag.dropped += msg.dropped;
    const kind = msg.channel === 'price.crypto' ? 'spot' : msg.channel === 'price.crypto.twap' ? 'twap' : null;
    if (!kind) return;
    const p = msg.payload;
    if (p.symbol && String(p.symbol).toLowerCase() !== SYMBOL) return;
    const points = Array.isArray(p.data) ? p.data : [p];
    for (const pt of points) {
      // value es número/decimal; full_accuracy_value es el decimal completo como string
      let value = parseFloat(pt.value);
      if (!(value > 1000 && value < 10_000_000)) value = parseFloat(pt.full_accuracy_value);
      const ts = Number(pt.timestamp);
      if (!(value > 1000 && value < 10_000_000) || !Number.isFinite(ts)) continue;
      this._push(kind, ts > 1e12 ? ts : ts * 1000, value, !!msg.snapshot);
    }
  }

  _push(kind, ts, value, snapshot) {
    const h = this.hist[kind];
    const received = Date.now();
    this._lastDataAt = received;
    if (h.length && ts <= h[h.length - 1].ts) {
      if (h.some(x => x.ts === ts)) return; // duplicado
      const i = h.findIndex(x => x.ts > ts);
      h.splice(i === -1 ? h.length : i, 0, { ts, value, received });
    } else {
      h.push({ ts, value, received });
    }
    this.diag[kind]++;
    const cb = kind === 'spot' ? this._onSpot : this._onTwap;
    if (cb) { try { cb({ ts, value, received, snapshot }); } catch (_) {} }
    while (h.length && h[0].ts < received - HISTORY_MS) h.shift();
  }

  // Valor con timestamp de fuente <= tsMs (máx. maxGapMs antes)
  valueAt(kind, tsMs, maxGapMs = 5000) {
    const h = this.hist[kind];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].ts <= tsMs) return tsMs - h[i].ts <= maxGapMs ? h[i].value : null;
    }
    return null;
  }

  lastReceivedAt() { return this._lastDataAt || null; }

  close() {
    this._closed = true;
    if (this._timer) clearInterval(this._timer);
    try { this.ws?.close(); } catch (_) {}
  }
}

module.exports = { PolyBoltClient };
