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
        // Suscribirse al canal de ticker BTC-USD
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
          if (msg.channel !== 'ticker') return;
          const event = msg.events?.[0];
          if (!event) return;
          const ticker = event.tickers?.[0];
          if (!ticker) return;

          const price = parseFloat(ticker.price);
          const timestamp = Date.now();
          const isBuyerMaker = parseFloat(ticker.price) < parseFloat(ticker.best_ask);

          if (!price || isNaN(price)) return;

          this._lastPrice = price;
          this._lastTimestamp = timestamp;

          if (this.priceCallback) {
            this.priceCallback({ price, timestamp, isBuyerMaker });
          }
        } catch (e) {}
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        logger.error(`Error: ${err.message}`);
        if (this.errorCallback) this.errorCallback(err);
        reject(err);
      });

      this.ws.on('close', (code) => {
        this._connected = false;
