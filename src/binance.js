/**
 * BTC Price WebSocket — Binance primary, Coinbase fallback
 * Binance btcusdt@bookTicker: bid/ask top en tiempo real (~10-15ms)
 * Coinbase ticker: fallback si Binance no está disponible
 */

const WebSocket = require('ws');
const { Logger } = require('./logger');

const logger = new Logger('BINANCE-WS');

const BINANCE_URL  = 'wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/btcusdt@aggTrade';
const COINBASE_URL = 'wss://advanced-trade-ws.coinbase.com';

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
    this._lastBestBid = null;
    this._lastBestAsk = null;
    this._lastTradeAt = 0; // timestamp del último aggTrade
    this._useCoinbase = false; // intenta Binance primero
    this._pingInterval = null;
  }

  onPrice(cb) { this.priceCallback = cb; }
  onError(cb) { this.errorCallback = cb; }
  onReconnect(cb) { this.reconnectCallback = cb; }
  isConnected() { return this._connected; }

  async connect() {
    // Intentar Binance primero, si falla en 5s usar Coinbase
    try {
      await this._connectBinance();
    } catch (e) {
      logger.warn(`Binance no disponible (${e.message}) — usando Coinbase como fallback`);
      this._useCoinbase = true;
      await this._connectCoinbase();
    }
  }

  async _connectBinance() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('timeout conectando a Binance'));
      }, 5000);

      this.ws = new WebSocket(BINANCE_URL);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this._connected = true;
        this._reconnectDelay = 1000;
        logger.info(`✅ Conectado a Binance bookTicker (BTC/USDT)`);
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const outer = JSON.parse(data);
          // Combined stream: { stream: 'btcusdt@bookTicker', data: {...} }
          const streamName = outer.stream || '';
          const msg = outer.data || outer;
          const receivedAt = Date.now();
          const exchangeTs = msg.E || msg.T || receivedAt;

          if (streamName.includes('bookTicker') || (msg.b && msg.a)) {
            // bookTicker: { b: bestBid, B: bidQty, a: bestAsk, A: askQty }
            const bestBid = parseFloat(msg.b);
            const bestAsk = parseFloat(msg.a);
            const price   = (bestBid + bestAsk) / 2;
            if (!price || isNaN(price)) return;

            this._lastBestBid = bestBid;
            this._lastBestAsk = bestAsk;
            this._lastPrice = price;
            this._lastTimestamp = receivedAt;

            // Solo emitir desde bookTicker si no hubo aggTrade reciente (<200ms)
            if (Date.now() - (this._lastTradeAt || 0) > 200 && this.priceCallback) {
              this.priceCallback({
                price, timestamp: receivedAt, latencyMs: receivedAt - exchangeTs,
                bestBid, bestAsk,
                bidQty: parseFloat(msg.B) || 0,
                askQty: parseFloat(msg.A) || 0,
                spread: bestAsk - bestBid,
                isBuyerMaker: undefined,
              });
            }

          } else if (streamName.includes('aggTrade') || msg.m !== undefined) {
            // aggTrade: { p: price, q: qty, m: isBuyerMaker, T: tradeTime, E: eventTime }
            const price = parseFloat(msg.p);
            if (!price || isNaN(price)) return;

            this._lastPrice = price;
            this._lastTimestamp = receivedAt;
            this._lastTradeAt = receivedAt;

            if (this.priceCallback) {
              this.priceCallback({
                price, timestamp: receivedAt, latencyMs: receivedAt - exchangeTs,
                bestBid: this._lastBestBid || price,
                bestAsk: this._lastBestAsk || price,
                spread: (this._lastBestAsk || price) - (this._lastBestBid || price),
                bidQty: 0, askQty: parseFloat(msg.q) || 0,
                isBuyerMaker: msg.m === true, // true=seller, false=buyer
              });
            }
          }
        } catch (e) {
          logger.warn(`Error parseando Binance: ${e.message}`);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        this._connected = false;
        reject(err);
      });

      this.ws.on('close', (code) => {
        this._connected = false;
        if (!this._intentionalClose) {
          logger.warn(`Binance desconectado (${code}). Reconectando en ${this._reconnectDelay}ms...`);
          setTimeout(() => this._reconnect(), this._reconnectDelay);
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
        }
      });

      this._startPing();
    });
  }

  async _connectCoinbase() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(COINBASE_URL);

      this.ws.on('open', () => {
        this._connected = true;
        this._reconnectDelay = 1000;
        logger.info(`✅ Conectado a Coinbase ticker (BTC-USD) [fallback]`);
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
          const ticker = msg.events?.[0]?.tickers?.[0];
          if (!ticker) return;

          const price   = parseFloat(ticker.price);
          const bestBid = parseFloat(ticker.best_bid) || price;
          const bestAsk = parseFloat(ticker.best_ask) || price;
          if (!price || isNaN(price)) return;

          this._lastPrice = price;
          this._lastTimestamp = Date.now();

          if (this.priceCallback) {
            this.priceCallback({
              price, timestamp: this._lastTimestamp,
              bestBid, bestAsk,
              bidQty: parseFloat(ticker.best_bid_quantity) || 0,
              askQty: parseFloat(ticker.best_ask_quantity) || 0,
              spread: bestAsk - bestBid,
              isBuyerMaker: price < bestAsk,
            });
          }
        } catch (e) {
          logger.warn(`Error parseando Coinbase: ${e.message}`);
        }
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        logger.error(`Coinbase error: ${err.message}`);
        if (this.errorCallback) this.errorCallback(err);
        reject(err);
      });

      this.ws.on('close', (code) => {
        this._connected = false;
        if (!this._intentionalClose) {
          logger.warn(`Coinbase desconectado (${code}). Reconectando...`);
          setTimeout(() => this._reconnect(), this._reconnectDelay);
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
        }
      });

      this._startPing();
    });
  }

  _startPing() {
    if (this._pingInterval) clearInterval(this._pingInterval);
    this._pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, 30000);
  }

  _reconnect() {
    if (this._pingInterval) clearInterval(this._pingInterval);
    const reconnectFn = this._useCoinbase
      ? () => this._connectCoinbase()
      : () => this._connectBinance().catch(() => { this._useCoinbase = true; return this._connectCoinbase(); });
    reconnectFn().then(() => {
      if (this.reconnectCallback) this.reconnectCallback();
    }).catch(err => logger.error(`Reconexión fallida: ${err.message}`));
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
