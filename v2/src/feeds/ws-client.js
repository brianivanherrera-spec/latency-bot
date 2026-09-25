'use strict';
// Cliente WebSocket con reconexión exponencial, ping y registro de último mensaje.
const WebSocket = require('ws');

class WsClient {
  constructor({ url, name, log, onOpen, onMessage, pingText = null, pingMs = 10000, maxDelay = 30000 }) {
    Object.assign(this, { url, name, log, onOpen, onMessage, pingText, pingMs, maxDelay });
    this.ws = null;
    this.connected = false;
    this.lastMsgAt = 0;
    this._delay = 1000;
    this._stopped = false;
    this._ping = null;
    this._timer = null;
  }

  start() { this._stopped = false; this._connect(); return this; }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    clearInterval(this._ping);
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.terminate(); } catch (_) {} }
    this.ws = null;
    this.connected = false;
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  _connect() {
    if (this._stopped) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.log.warn(`${this.name}: ${e.message}`); return this._retry(); }
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this._delay = 1000;
      this.lastMsgAt = Date.now();
      try { this.onOpen?.(this); } catch (e) { this.log.warn(`${this.name} onOpen: ${e.message}`); }
      if (this.pingText) {
        clearInterval(this._ping);
        this._ping = setInterval(() => this.send(this.pingText), this.pingMs);
      }
    });
    ws.on('message', (data) => {
      this.lastMsgAt = Date.now();
      const raw = data.toString();
      if (raw === 'PONG' || raw === 'pong' || raw === '') return;
      try { this.onMessage?.(raw); } catch (e) { this.log.debug(`${this.name} msg: ${e.message}`); }
    });
    ws.on('error', (e) => this.log.warn(`${this.name} error: ${e.message}`));
    ws.on('close', (code) => {
      this.connected = false;
      clearInterval(this._ping);
      if (!this._stopped) { this.log.warn(`${this.name} desconectado (${code})`); this._retry(); }
    });
  }

  _retry() {
    if (this._stopped) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._connect(), this._delay);
    this._delay = Math.min(this._delay * 2, this.maxDelay);
  }
}

module.exports = { WsClient };
