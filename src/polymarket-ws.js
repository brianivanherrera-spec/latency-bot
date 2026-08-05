/**
 * Polymarket CLOB WebSocket — precios YES/NO en tiempo real
 * Reemplaza el polling HTTP cada 2s por stream de <50ms
 *
 * Fix 2026-08-05:
 *   1) URL corregida a /ws/market (antes /ws/ daba 404 siempre)
 *   2) Payload de subscribe corregido: assets_ids + type:'market'
 *   3) Heartbeat corregido: texto "PING" cada 10s (antes ws.ping() que Polymarket ignora)
 *   4) Parser price_change: leer best_bid/best_ask del item, no asks[0]
 */

const WebSocket = require('ws');
const { Logger } = require('./logger');

const logger = new Logger('POLY-WS');

// URL correcta confirmada con pruebas en vivo (05/08/2026)
// /ws/ siempre devuelve 404; /ws/market es el endpoint real del CLOB
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

class PolymarketWS {
  constructor() {
    this.ws = null;
    this._connected = false;
    this._intentionalClose = false;
    this._reconnectDelay = 1000;
    this._maxReconnectDelay = 30000;
    this._subscribedTokens = new Set();
    this._priceCallback = null;
    this._resolvedCallback = null;
    this._pingInterval = null;
    this._fastCloseCount = 0;
    this._connectedAt = null;
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
        this._connectedAt = Date.now();
        this._reconnectDelay = 1000;
        this._fastCloseCount = 0;
        logger.info('✅ Polymarket WS conectado');

        // Fix 3: heartbeat texto "PING" cada 10s — Polymarket responde "PONG"
        // El ws.ping() anterior era un frame ping del protocolo WS que Polymarket ignora
        if (this._pingInterval) clearInterval(this._pingInterval);
        this._pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send('PING');
          }
        }, 10000);

        // Re-suscribir tokens si había suscripciones previas (reconexión)
        if (this._subscribedTokens.size > 0) {
          this._sendSubscribe([...this._subscribedTokens]);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        // Ignorar PONG y mensajes de texto no-JSON conocidos
        const raw = data.toString();
        if (raw === 'PONG') return;
        if (raw === 'INVALID OPERATION') return; // Polymarket manda esto cuando el token ya no existe
        try {
          const msgs = JSON.parse(raw);
          const events = Array.isArray(msgs) ? msgs : [msgs];
          for (const msg of events) {
            this._handleMessage(msg);
          }
        } catch (e) {
          // Solo loguear si no es un texto plano conocido
          if (!raw.startsWith('INVALID') && !raw.startsWith('PONG')) {
            logger.warn(`Parse error: ${e.message} | raw: ${raw.slice(0,100)}`);
          }
        }
      });

      this.ws.on('error', (err) => {
        this._connected = false;
        logger.error(`WS error: ${err.message}`);
        reject(err);
      });

      this.ws.on('close', (code) => {
        this._connected = false;
        if (this._pingInterval) clearInterval(this._pingInterval);

        if (!this._intentionalClose) {
          const connDuration = Date.now() - (this._connectedAt || Date.now());
          if (connDuration < 200) {
            this._fastCloseCount++;
          }

          if (this._fastCloseCount >= 5) {
            if (this._fastCloseCount === 5) {
              logger.warn(`WS no disponible (${this._fastCloseCount} cierres rápidos) — usando HTTP polling como fallback`);
            }
            return;
          }

          logger.warn(`Desconectado (${code}). Reconectando en ${this._reconnectDelay}ms...`);
          setTimeout(() => this._reconnect(), this._reconnectDelay);
          this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
        }
      });
    });
  }

  subscribe(yesTokenId, noTokenId) {
    const tokens = [yesTokenId, noTokenId].filter(Boolean);
    if (!tokens.length) return;
    tokens.forEach(t => this._subscribedTokens.add(t));
    if (this._connected) {
      this._sendSubscribe(tokens);
      logger.info(`Suscrito a ${tokens.length} tokens`);
    }
  }

  unsubscribeAll() {
    if (this._connected && this._subscribedTokens.size > 0) {
      this._sendUnsubscribe([...this._subscribedTokens]);
    }
    this._subscribedTokens.clear();
  }

  // Fix 2: payload correcto confirmado con pruebas en vivo
  // El formato anterior { auth:{}, markets:[], type:'subscribe' } devolvía 1008
  _sendSubscribe(tokenIds) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      assets_ids: tokenIds,
      type: 'market',
      custom_feature_enabled: true,
    }));
  }

  _sendUnsubscribe(tokenIds) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      assets_ids: tokenIds,
      type: 'unsubscribe',
    }));
  }

  _handleMessage(msg) {
    if (!msg) return;
    const type = msg.event_type || msg.type || '';

    // Ignorar heartbeats y confirmaciones de suscripción
    if (type === 'heartbeat' || type === 'subscribed' || type === 'last_trade_price') {
      if (type === 'last_trade_price') {
        const price = parseFloat(msg.price);
        if (!isNaN(price) && price >= 0.99) {
          if (this._resolvedCallback) this._resolvedCallback(price >= 0.99 ? 'YES' : 'NO');
        }
      }
      return;
    }

    const tokens = [...this._subscribedTokens];
    if (tokens.length < 2) return;
    const [yesTokenId, noTokenId] = tokens;

    // Fix: Polymarket manda best_bid_ask como tipo principal de update de precio
    // (no price_change como indicaban las docs antiguas)
    if (type === 'best_bid_ask') {
      const tokenId = msg.asset_id || msg.market;
      const bid = parseFloat(msg.best_bid || 0);
      const ask = parseFloat(msg.best_ask || 0);
      const mid = (bid && ask) ? (bid + ask) / 2
                : parseFloat(msg.price || ask || bid || 0);
      if (mid && tokenId) this._updatePrice(tokenId, mid, yesTokenId, noTokenId);
      return;
    }

    // book: snapshot inicial con bids[]/asks[] por token
    if (type === 'book') {
      const tokenId = msg.asset_id || msg.market;
      const bestAsk = parseFloat(msg.asks?.[0]?.price || msg.price || 0);
      const bestBid = parseFloat(msg.bids?.[0]?.price || 0);
      const mid = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : (bestAsk || bestBid);
      if (!mid || !tokenId) return;
      this._updatePrice(tokenId, mid, yesTokenId, noTokenId);
    }

    if (type === 'price_change') {
      // price_changes puede ser array de cambios en este mensaje
      const changes = msg.price_changes || (msg.asset_id ? [msg] : []);
      for (const ch of changes) {
        const tokenId = ch.asset_id || ch.market;
        const bid = parseFloat(ch.best_bid || 0);
        const ask = parseFloat(ch.best_ask || 0);
        // mid del best bid/ask; fallback al price directo
        const mid = (bid && ask) ? (bid + ask) / 2
                  : parseFloat(ch.price || ch.best_ask || ch.best_bid || 0);
        if (!mid || !tokenId) continue;
        this._updatePrice(tokenId, mid, yesTokenId, noTokenId);
      }
    }

    // Log tipos desconocidos para debugging futuro
    if (type && !['book','price_change','heartbeat','subscribed','last_trade_price'].includes(type)) {
      logger.info(`RAW tipo=${type}: ${JSON.stringify(msg).slice(0, 200)}`);
    }
  }

  _updatePrice(tokenId, mid, yesTokenId, noTokenId) {
    if (isNaN(mid) || mid <= 0) return;

    // Ignorar updates de tokens que ya no son el mercado activo
    // (pueden llegar durante la transición entre mercados)
    if (tokenId !== yesTokenId && tokenId !== noTokenId) return;

    let yesPrice = null, noPrice = null;

    if (tokenId === yesTokenId) yesPrice = mid;
    else if (tokenId === noTokenId) noPrice = mid;
    else return; // token no reconocido

    // Completar el par con el complemento
    if (yesPrice !== null && noPrice === null) noPrice = parseFloat((1 - yesPrice).toFixed(4));
    if (noPrice !== null && yesPrice === null) yesPrice = parseFloat((1 - noPrice).toFixed(4));

    if (yesPrice === null || noPrice === null) return;

    // Detectar resolución
    if (yesPrice >= 0.99 || noPrice >= 0.99) {
      const winner = yesPrice >= 0.99 ? 'YES' : 'NO';
      logger.info(`Mercado resuelto via WS: ${winner}`);
      if (this._resolvedCallback) this._resolvedCallback(winner);
      return;
    }

    if (yesPrice >= 0.05 && yesPrice <= 0.95 && this._priceCallback) {
      this._priceCallback(yesPrice, noPrice);
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
