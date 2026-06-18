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
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/';

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
        logger.error(`WS error: ${err.message}`);
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
    this.ws.send(JSON.stringify({
      type: 'subscribe',
      channel: 'price_change',
      assets_ids: tokenIds,
    }));
  }

  _sendUnsubscribe(tokenIds) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: 'unsubscribe',
      channel: 'price_change',
      assets_ids: tokenIds,
    }));
  }

  _handleMessage(msg) {
    // Ignorar mensajes de control
    if (!msg || msg.event_type === 'heartbeat') return;

    const type = msg.event_type || msg.type;

    if (type === 'price_change') {
      const changes = msg.asset_ids_price_changes || [];
      let yesPrice = null;
      let noPrice = null;

      for (const change of changes) {
        const tokenId = change.asset_id;
        const price = parseFloat(change.price);
        if (isNaN(price)) continue;

        // Determinar si es YES o NO por posición en el par suscrito
        // YES es el primer token, NO el segundo
        const tokens = [...this._subscribedTokens];
        if (tokens[0] === tokenId) yesPrice = price;
        if (tokens[1] === tokenId) noPrice = price;
      }

      if (yesPrice !== null && noPrice !== null && this._priceCallback) {
        // Detectar mercado resuelto
        if (yesPrice >= 0.99 || noPrice >= 0.99) {
          const winner = yesPrice >= 0.99 ? 'YES' : 'NO';
          logger.info(`[POLY-WS] Mercado resuelto: ${winner}`);
          if (this._resolvedCallback) this._resolvedCallback(winner);
          return;
        }
        this._priceCallback(yesPrice, noPrice);
      }
    }

    if (type === 'last_trade_price') {
      // Precio del último trade — datos adicionales de liquidez
      const price = parseFloat(msg.price);
      if (!isNaN(price) && price >= 0.99) {
        logger.info(`[POLY-WS] Último trade indica resolución: $${price}`);
        if (this._resolvedCallback) this._resolvedCallback(price >= 0.99 ? 'YES' : 'NO');
      }
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
