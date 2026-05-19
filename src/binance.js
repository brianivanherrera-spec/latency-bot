/**
 * Coinbase WebSocket - BTC/USD precio en tiempo real
 * Reemplaza Binance (bloqueado en Railway)
 * No requiere API key
 */

const WebSocket = require('ws');
const { Logger } = require('./logger');

const logger = new Logger('BINANCE-WS');

const WS_URL = 'wss://advanced-trade-ws.coinbase.com';

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
    this._loggedFirst = false;  // ← LOG TEMPORAL
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
        this._reconnectDelay = 1000;
        logger.info(`Conectado: ${WS_URL}`);
        this.ws.send(JSON.stringify({
          type: 'subscribe',
          product_ids: ['BTC-USD'],
          channel: 'ticker'
        }));
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);

          // ✅ LOG TEMPORAL: ver los primeros 3 mensajes
          if (!this._loggedFirst) {
            logger.info(`RAW MSG tipo=${msg.type} channel=${msg.channel}: ${data.toString().slice(0, 400)}`);
            this._loggedFirst = true;
          }

          if (msg.channel !== 'ticker') return;
          const event = msg.events?.[0];
          if (!event) return;
          const ticker = event.tickers?.[0];
          if (!ticker) return;

          const price = parseFloat(ticker.price);
          const timestamp = Date.now();
          const isBuyerMaker = parseFloat(ticker.price) < parseFloat(ticker.best_ask);
          const bestBid = parseFloat(ticker.best_bid) || price;
          const bestAsk = parseFloat(ticker.best_ask) || price;
          const bidQty = parseFloat(ticker.best_bid_quantity) || 0;
          const askQty = parseFloat(ticker.best_ask_quantity) || 0;
          const spread = bestAsk - bestBid;

          if (!price || isNaN(price)) return;

          this._lastPrice = price;
          this._lastTimestamp = timestamp;

          if (this.priceCallback) {
            this.priceCallback({ price, timestamp, isBuyerMaker, bestBid, bestAsk, bidQty, askQty, spread });
          }
        } catch (e) {
          logger.warn(`Error parseando mensaje WS: ${e.message}`);
        }
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        logger.error(`Error: ${err.message}`);
        if (this.errorCallback) this.errorCallback(err);
        reject(err);
      });

      this.ws.on('close', (code) => {
        this._connected = false;
        if (!this._intentionalClose) {
          logger.warn(`Desconectado (${code}). Reconectando en ${this._reconnectDelay}ms...`);
          setTimeout(() => this._reconnect(), this._reconnectDelay);
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
        }
      });

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
