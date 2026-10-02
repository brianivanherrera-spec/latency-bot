/**
 * BTC Price WebSocket — una fuente fija por instancia
 *   new BinanceWS()                       → Binance aggTrade (BTC/USDT)
 *   new BinanceWS({ source: 'coinbase' }) → Coinbase ticker (BTC-USD)
 *
 * Antes una instancia que no conectaba a Binance pasaba a Coinbase para siempre y sus
 * ticks (USD, ~$17 abajo de USDT) entraban sin etiqueta a la señal, a FairValue y a la
 * base Binance−Chainlink; además la instancia "Coinbase" intentaba Binance primero y abría
 * una segunda conexión a Binance. Ahora cada tick lleva `source`, Binance se reintenta
 * siempre con backoff, el socket pendiente se cierra en el timeout de conexión, nunca hay
 * dos sockets vivos en la misma instancia y un watchdog reconecta si no llegan datos.
 */

const WebSocket = require('ws');
const { Logger } = require('./logger');

const logger = new Logger('BINANCE-WS');

const BINANCE_URL  = process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
const COINBASE_URL = 'wss://advanced-trade-ws.coinbase.com';
const CONNECT_TIMEOUT_MS = 5000;
// Sin datos en este tiempo → reconectar (aggTrade de BTC llega varias veces por segundo)
const WATCHDOG_MS = parseInt(process.env.BINANCE_WATCHDOG_MS || '5000');

class BinanceWS {
  constructor({ source = 'binance' } = {}) {
    this.source = source === 'coinbase' ? 'coinbase' : 'binance';
    this.ws = null;
    this.priceCallback = null;
    this.errorCallback = null;
    this.reconnectCallback = null;
    this._connected = false;
    this._connecting = false;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._reconnectTimer = null;
    this._intentionalClose = false;
    this._lastPrice = null;
    this._lastTimestamp = null;
    this._lastDataAt = 0;
    this._pingInterval = null;
    this._watchdog = null;
    this._everConnected = false;
  }

  // El callback es async: un rechazo sin .catch quedaba como unhandledRejection
  _emitPrice(data) {
    if (!this.priceCallback) return;
    const fail = err => logger.error(`[PRICE-CB] ${err?.stack || err?.message || err}`);
    try { Promise.resolve(this.priceCallback(data)).catch(fail); } catch (err) { fail(err); }
  }

  onPrice(cb) { this.priceCallback = cb; }
  onError(cb) { this.errorCallback = cb; }
  onReconnect(cb) { this.reconnectCallback = cb; }
  isConnected() { return this._connected; }

  // Primera conexión: si falla, no lanza; queda reintentando en segundo plano
  async connect() {
    this._intentionalClose = false;
    this._startWatchdog();
    try {
      await this._open();
    } catch (e) {
      logger.warn(`${this._label()} no disponible (${e.message}) — reintento en ${this._reconnectDelay}ms`);
      this._scheduleReconnect();
    }
  }

  _label() { return this.source === 'coinbase' ? 'Coinbase' : 'Binance'; }

  _open() {
    if (this._connecting) return Promise.reject(new Error('conexión en curso'));
    this._connecting = true;
    this._teardownSocket(); // nunca dos sockets vivos
    return new Promise((resolve, reject) => {
      const url = this.source === 'coinbase' ? COINBASE_URL : BINANCE_URL;
      const sock = new WebSocket(url);
      this.ws = sock;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._connecting = false;
        if (err) {
          if (this.ws === sock) this.ws = null;
          try { sock.terminate(); } catch (_) {}
          reject(err);
        } else resolve();
      };
      // Antes el timeout rechazaba sin cerrar el socket, que podía abrir después y
      // quedar duplicado
      const timeout = setTimeout(() => done(new Error(`timeout conectando a ${this._label()}`)), CONNECT_TIMEOUT_MS);

      sock.on('open', () => {
        if (this.ws !== sock) { try { sock.terminate(); } catch (_) {} return; }
        this._connected = true;
        this._reconnectDelay = 1000;
        this._lastDataAt = Date.now();
        if (this.source === 'coinbase') {
          sock.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker' }));
          logger.info(`✅ Conectado a Coinbase ticker (BTC-USD) — solo referencia, no entra a la señal`);
        } else {
          logger.info(`✅ Conectado a Binance aggTrade (BTC/USDT)`);
        }
        this._startPing();
        const wasReconnect = this._everConnected;
        this._everConnected = true;
        done();
        if (wasReconnect && this.reconnectCallback) {
          try { this.reconnectCallback(); } catch (_) {}
        }
      });

      sock.on('message', (data) => {
        if (this.ws !== sock) return;
        if (this.source === 'coinbase') this._onCoinbase(data);
        else this._onBinance(data);
      });

      sock.on('error', (err) => {
        if (this.errorCallback && this.ws === sock) this.errorCallback(err);
        done(err);
      });

      sock.on('close', (code) => {
        if (this.ws !== sock) return; // socket viejo reemplazado: no reconectar dos veces
        this._connected = false;
        this.ws = null;
        if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
        done(new Error(`cerrado (${code}) antes de abrir`));
        if (!this._intentionalClose) {
          logger.warn(`${this._label()} desconectado (${code}). Reconectando en ${this._reconnectDelay}ms...`);
          this._scheduleReconnect();
        }
      });
    });
  }

  _onBinance(data) {
    try {
      const msg = JSON.parse(data);
      const receivedAt = Date.now();
      // aggTrade: { p: price, q: qty, m: isBuyerMaker, T: tradeTime, E: eventTime }
      const price = parseFloat(msg.p);
      if (!price || isNaN(price)) return;
      const exchangeTs = msg.T || msg.E || null;
      this._lastPrice = price;
      this._lastTimestamp = receivedAt;
      this._lastDataAt = receivedAt;
      this._emitPrice({
        source: 'binance',
        price,
        timestamp: receivedAt,
        exchangeTs,
        latencyMs: exchangeTs ? receivedAt - exchangeTs : null,
        bestBid: price,
        bestAsk: price,
        spread: 0,
        // aggTrade no trae tamaños del book: 0/0 → imbalance neutro.
        // Antes bidQty=0 y askQty=q daban imbalance -1.00 fijo, que sumaba
        // +8 al score de toda señal DOWN y podía marcar señales como ÉLITE.
        bidQty: 0,
        askQty: 0,
        isBuyerMaker: msg.m === true,
      });
    } catch (e) {
      logger.warn(`Error parseando Binance: ${e.message}`);
    }
  }

  _onCoinbase(data) {
    try {
      const msg = JSON.parse(data);
      if (msg.channel !== 'ticker') return;
      const ticker = msg.events?.[0]?.tickers?.[0];
      if (!ticker) return;
      const price   = parseFloat(ticker.price);
      if (!price || isNaN(price)) return;
      const bestBid = parseFloat(ticker.best_bid) || price;
      const bestAsk = parseFloat(ticker.best_ask) || price;
      const receivedAt = Date.now();
      const exchangeTs = msg.timestamp ? Date.parse(msg.timestamp) || null : null;
      this._lastPrice = price;
      this._lastTimestamp = receivedAt;
      this._lastDataAt = receivedAt;
      this._emitPrice({
        source: 'coinbase',
        price, timestamp: receivedAt, exchangeTs,
        bestBid, bestAsk,
        bidQty: parseFloat(ticker.best_bid_quantity) || 0,
        askQty: parseFloat(ticker.best_ask_quantity) || 0,
        spread: bestAsk - bestBid,
        isBuyerMaker: price < bestAsk,
      });
    } catch (e) {
      logger.warn(`Error parseando Coinbase: ${e.message}`);
    }
  }

  _scheduleReconnect() {
    if (this._intentionalClose || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._open().catch(err => {
        logger.warn(`Reconexión a ${this._label()} fallida: ${err.message} — próximo intento en ${this._reconnectDelay}ms`);
        this._scheduleReconnect();
      });
    }, delay);
  }

  // Watchdog de datos: conectado pero sin mensajes en WATCHDOG_MS → cerrar y reconectar.
  // (Coinbase ticker puede quedar quieto unos segundos: se le da 6× más margen.)
  _startWatchdog() {
    if (this._watchdog) return;
    const limit = this.source === 'coinbase' ? WATCHDOG_MS * 6 : WATCHDOG_MS;
    this._watchdog = setInterval(() => {
      if (!this._connected || !this.ws) return;
      const idle = Date.now() - this._lastDataAt;
      if (idle > limit) {
        logger.warn(`[WATCHDOG] ${this._label()} sin datos hace ${idle}ms — reconectando`);
        this._lastDataAt = Date.now();
        try { this.ws.terminate(); } catch (_) {} // dispara 'close' → reconexión
      }
    }, 1000);
    this._watchdog.unref?.();
  }

  _startPing() {
    if (this._pingInterval) clearInterval(this._pingInterval);
    this._pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, 30000);
    this._pingInterval.unref?.();
  }

  _teardownSocket() {
    const old = this.ws;
    this.ws = null;
    this._connected = false;
    if (old) { try { old.removeAllListeners('message'); old.terminate(); } catch (_) {} }
  }

  close() {
    this._intentionalClose = true;
    if (this._pingInterval) clearInterval(this._pingInterval);
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._pingInterval = this._watchdog = this._reconnectTimer = null;
    this._teardownSocket();
  }

  getLastPrice() {
    return { price: this._lastPrice, timestamp: this._lastTimestamp, source: this.source };
  }
}

module.exports = { BinanceWS };
