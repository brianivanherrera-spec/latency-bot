/**
 * Binance WebSocket - BTC/USDT precio en tiempo real
 * Usa el stream público (no requiere API key)
 * Reconexión automática con backoff exponencial
 */

const WebSocket = require('ws');
const { Logger } = require('./logger');

const logger = new Logger('BINANCE-WS');

const WS_URL = 'wss://stream.binance.com:443/ws/btcusdt@aggTrade';

class BinanceWS {
  constructor() {
    this.ws = null;
    this.priceCallback = null;
    this.errorCallback = null;
    this.reconnectCallback = null;
    this._connected = false;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._intentionalClose = false;
    this._lastPrice = null;
    this._lastTimestamp = null;
  }

  onPrice(cb) { this.priceCallback = cb; }
  onError(cb) { this.errorCallback = cb; }
  onReconnect(cb) { this.reconnectCallback = cb; }
  isConnected() { return this._connected; }

  async connect() {
    return new Promise((resolve, reject) => {
      this._intentionalClose = false;
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        this._connected = true;
        this._reconnectDelay = 1000; // reset backoff
        logger.info(`Conectado: ${WS_URL}`);
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          // aggTrade: { p: price, T: tradeTime, m: isBuyerMaker }
          const price = parseFloat(msg.p);
          const timestamp = msg.T;
          const isBuyerMaker = msg.m; // true = sell pressure, false = buy pressure

          if (!price || isNaN(price)) return;

          this._lastPrice = price;
          this._lastTimestamp = timestamp;

          if (this.priceCallback) {
            this.priceCallback({ price, timestamp, isBuyerMaker });
          }
        } catch (e) {
          // ignorar mensajes malformados
        }
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        logger.error(`Error: ${err.message}`);
        if (this.errorCallback) this.errorCallback(err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this._connected = false;
        if (!this._intentionalClose) {
          logger.warn(`Desconectado (${code}). Reconectando en ${this._reconnectDelay}ms...`);
          setTimeout(() => this._reconnect(), this._reconnectDelay);
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
        }
      });

      // Ping para mantener conexión viva
      this._pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });
  }

  _reconnect() {
    if (this._pingInterval) clearInterval(this._pingInterval);
    this.connect().then(() => {
      if (this.reconnectCallback) this.reconnectCallback();
    }).catch((err) => {
      logger.error(`Reconexión fallida: ${err.message}`);
    });
  }

  close() {
    this._intentionalClose = true;
    if (this._pingInterval) clearInterval(this._pingInterval);
    if (this.ws) this.ws.close();
  }

  getLastPrice() {
    return { price: this._lastPrice, timestamp: this._lastTimestamp };
  }
}

module.exports = { BinanceWS };
