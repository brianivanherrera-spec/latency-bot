/**
 * Polymarket CLOB WebSocket — precios YES/NO en tiempo real
 * Reemplaza el polling HTTP cada 2s por stream de <50ms
 * 
 * Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/
 * Canal: price_change — emite cambios de precio por token ID
 * Sin auth requerida para datos de mercado
 */

const WebSocket = require('ws');
const { Logger } = require('./logger');

const logger = new Logger('POLY-WS');
// Polymarket CLOB WebSocket — endpoint oficial
// Docs: https://docs.polymarket.com/#websocket-api
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

class PolymarketWS {
  constructor() {
    this.ws = null;
    this._connected = false;
    this._intentionalClose = false;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._subscribedTokens = new Set();
    this._priceCallback = null;  // (yes, no) => void
    this._resolvedCallback = null; // (winner) => void
    this._pingInterval = null;
  }

  onPrice(cb) { this._priceCallback = cb; }
  onResolved(cb) { this._resolvedCallback = cb; }
  isConnected() { return this._connected; }

  async connect() {
    return new Promise((resolve, reject) => {
      this._intentionalClose = false;
      logger.info(`Conectando a ${WS_URL}...`);
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        this._connected = true;
        this._reconnectDelay = 1000;
        logger.info('✅ Polymarket WS conectado');
        // Re-suscribir tokens si había suscripciones previas
        if (this._subscribedTokens.size > 0) {
          this._sendSubscribe([...this._subscribedTokens]);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msgs = JSON.parse(data);
          const events = Array.isArray(msgs) ? msgs : [msgs];
          for (const msg of events) {
            this._handleMessage(msg);
          }
        } catch (e) {
          logger.warn(`Parse error: ${e.message}`);
        }
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        // Si es 404, probar URL alternativa antes de rendirse
        if (err.message.includes('404')) {
          this._try404Fallback = true;
        }
        logger.error(`WS error: ${err.message}`);
        reject(err);
      });

      this.ws.on('close', (code) => {
        this._connected = false;
        if (!this._intentionalClose) {
          // Si 404 persiste después de 5 intentos → desactivar WS, usar HTTP fallback
          if (this._404count >= 5) {
            logger.warn(`WS endpoint no disponible (404x${this._404count}) — usando HTTP fallback`);
            return;
          }
          if (this._try404Fallback) {
            this._404count = (this._404count || 0) + 1;
            this._try404Fallback = false;
          }
          logger.warn(`Desconectado (${code}). Reconectando en ${this._reconnectDelay}ms...`);
          setTimeout(() => this._reconnect(), this._reconnectDelay);
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
        }
      });

      // Ping cada 30s para mantener la conexión viva
      this._pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });
  }

  // Suscribirse a un par de tokens YES/NO
  subscribe(yesTokenId, noTokenId) {
    const tokens = [yesTokenId, noTokenId].filter(Boolean);
    if (!tokens.length) return;
    tokens.forEach(t => this._subscribedTokens.add(t));
    if (this._connected) {
      this._sendSubscribe(tokens);
      logger.info(`[POLY-WS] Suscrito a ${tokens.length} tokens`);
    }
  }

  // Desuscribirse de tokens anteriores (al cambiar de mercado)
  unsubscribeAll() {
    if (this._connected && this._subscribedTokens.size > 0) {
      this._sendUnsubscribe([...this._subscribedTokens]);
    }
    this._subscribedTokens.clear();
  }

  _sendSubscribe(tokenIds) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Polymarket CLOB v2 WebSocket subscribe format
    // Canal "market" con markets array
    this.ws.send(JSON.stringify({
      auth: {},
      markets: tokenIds,
      type: 'subscribe',
    }));
  }

  _sendUnsubscribe(tokenIds) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      auth: {},
      markets: tokenIds,
      type: 'unsubscribe',
    }));
  }

  _handleMessage(msg) {
    if (!msg) return;
    const type = msg.event_type || msg.type || '';
    if (type === 'heartbeat' || type === 'subscribed') return;

    const tokens = [...this._subscribedTokens];
    if (tokens.length < 2) return;
    const [yesTokenId, noTokenId] = tokens;

    // Formato book: { event_type: "book", asset_id: tokenId, bids: [], asks: [] }
    if (type === 'book' || type === 'price_change') {
      const tokenId = msg.asset_id || msg.market;
      // Mejor precio disponible: mejor ask para comprar
      const bestAsk = msg.asks?.[0]?.price || msg.price;
      if (!bestAsk || !tokenId) return;
      const price = parseFloat(bestAsk);
      if (isNaN(price) || price <= 0) return;

      let yesPrice = null, noPrice = null;
      if (tokenId === yesTokenId) yesPrice = price;
      if (tokenId === noTokenId) noPrice = price;

      // Completar el par con el complemento si solo tenemos uno
      if (yesPrice !== null && noPrice === null) noPrice = parseFloat((1 - yesPrice).toFixed(3));
      if (noPrice !== null && yesPrice === null) yesPrice = parseFloat((1 - noPrice).toFixed(3));

      if (yesPrice !== null && noPrice !== null && this._priceCallback) {
        if (yesPrice >= 0.99 || noPrice >= 0.99) {
          const winner = yesPrice >= 0.99 ? 'YES' : 'NO';
          logger.info(`[POLY-WS] Mercado resuelto: ${winner}`);
          if (this._resolvedCallback) this._resolvedCallback(winner);
          return;
        }
        if (yesPrice >= 0.05 && yesPrice <= 0.95) {
          logger.info(`[POLY-WS] 💰 YES=${yesPrice.toFixed(3)} NO=${noPrice.toFixed(3)}`);
          this._priceCallback(yesPrice, noPrice);
        }
      }
    }

    // last_trade_price: { event_type: "last_trade_price", price: "0.99", ... }
    if (type === 'last_trade_price') {
      const price = parseFloat(msg.price);
      if (!isNaN(price) && price >= 0.99) {
        logger.info(`[POLY-WS] Último trade indica resolución: $${price}`);
        if (this._resolvedCallback) this._resolvedCallback(price >= 0.99 ? 'YES' : 'NO');
      }
      return;
    }

    // Log cualquier otro tipo para ver el formato real que manda Polymarket
    if (type && type !== 'heartbeat') {
      logger.info(`[POLY-WS] RAW tipo=${type}: ${JSON.stringify(msg).slice(0, 150)}`);
    }
  }

  _reconnect() {
    if (this._pingInterval) clearInterval(this._pingInterval);
    this.connect().catch((err) => {
      logger.error(`Reconexión fallida: ${err.message}`);
    });
  }

  close() {
    this._intentionalClose = true;
    if (this._pingInterval) clearInterval(this._pingInterval);
    this.ws?.close();
  }
}

module.exports = { PolymarketWS };
