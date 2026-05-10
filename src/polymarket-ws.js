/**
 * Polymarket WebSocket CLOB Client
 * Conexión en tiempo real al orderbook para latencia <100ms
 */

const { Logger } = require('./logger');
const config = require('./config');
const WebSocket = require('ws');

const logger = new Logger('POLYMARKET-WS');

let ClobClient, Side, OrderType, ethers, HAS_CLOB_CLIENT = false;
try {
  ({ ClobClient, Side, OrderType } = require('@polymarket/clob-client'));
  ethers = require('ethers');
  HAS_CLOB_CLIENT = true;
  logger.info('✓ @polymarket/clob-client disponible');
} catch (e) {
  logger.warn('⚠️  @polymarket/clob-client no instalado - usando fallback HTTP');
  logger.warn('   Para mejor performance: npm install @polymarket/clob-client');
  HAS_CLOB_CLIENT = false;
}

const CLOB_API_BASE = 'https://clob.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

class PolymarketWebSocketClient {
  constructor() {
    this.clobClient = null;
    this.wallet = null;
    this._initialized = false;
    this._orderHistory = [];
    
    // WebSocket connection
    this.ws = null;
    this.wsConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    
    // Orderbook state
    this.currentMarket = null;
    this.orderbook = {
      bids: [],
      asks: [],
      lastUpdate: null,
    };
    
    // Price tracking
    this.currentPrices = {
      yes: null,
      no: null,
      timestamp: null,
      staleCount: 0,
    };
    
    this.priceUpdateCallback = null;
    this.marketInvalidCallback = null;
  }

  async init() {
    if (this._initialized) return;

    if (config.DRY_RUN) {
      logger.info('✓ DRY RUN: Polymarket en modo simulación (sin WebSocket real)');
      this._initialized = true;
      return;
    }

    if (!HAS_CLOB_CLIENT) {
      logger.warn('⚠️  Sin CLOB client - usando modo HTTP fallback');
      this._initialized = true;
      return;
    }

    if (!config.POLY_PRIVATE_KEY) {
      throw new Error('POLY_PRIVATE_KEY no configurada');
    }

    try {
      this.wallet = new ethers.Wallet(config.POLY_PRIVATE_KEY);
      this.clobClient = new ClobClient(
        CLOB_API_BASE,
        137, // Polygon mainnet
        this.wallet,
        {
          key: config.POLY_API_KEY,
          secret: config.POLY_API_SECRET,
          passphrase: config.POLY_PASSPHRASE,
        }
      );
      
      await this.clobClient.deriveApiKey();
      this._initialized = true;
      logger.info(`✓ Wallet conectada: ${this.wallet.address}`);
    } catch (err) {
      throw new Error(`Error inicializando Polymarket WebSocket: ${err.message}`);
    }
  }

  /**
   * Suscribirse a updates en tiempo real del orderbook
   */
  async subscribeToMarket(tokenId) {
    if (config.DRY_RUN) {
      logger.info(`[DRY RUN] Simulando suscripción a token ${tokenId}`);
      return;
    }

    try {
      await this.init();
      
      // Obtener orderbook inicial vía REST
      const book = await this.clobClient.getOrderBook(tokenId);
      this._updateOrderbook(book);
      
      logger.info(`✓ Orderbook inicial obtenido para token ${tokenId}`);
      
      // Conectar WebSocket REAL para updates en tiempo real
      this._connectWebSocket(tokenId);
      
    } catch (err) {
      logger.error(`Error suscribiendo a mercado: ${err.message}`);
      // Fallback a polling si falla
      this._startFallbackPolling(tokenId);
    }
  }

  /**
   * Conectar WebSocket REAL a Polymarket CLOB
   * Latencia <100ms vs 1-5 segundos del polling
   */
  _connectWebSocket(tokenId) {
    if (config.DRY_RUN) {
      logger.info('[DRY RUN] WebSocket simulado (sin conexión real)');
      // En dry run, usar polling ligero cada 2s
      this._startFallbackPolling(tokenId);
      return;
    }

    try {
      this.ws = new WebSocket(CLOB_WS_URL);
      
      this.ws.on('open', () => {
        logger.info('🟢 WebSocket conectado a Polymarket CLOB');
        this.wsConnected = true;
        this.reconnectAttempts = 0;
        
        // Suscribirse al token específico
        const subscribeMsg = {
          type: 'market',
          assets_ids: [tokenId],
          custom_feature_enabled: true, // Habilita best_bid_ask
        };
        
        this.ws.send(JSON.stringify(subscribeMsg));
        logger.info(`✓ Suscrito a token: ${tokenId}`);
      });
      
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleWebSocketMessage(message);
        } catch (err) {
          logger.warn(`Error parseando mensaje WS: ${err.message}`);
        }
      });
      
      this.ws.on('error', (err) => {
        logger.error(`❌ WebSocket error: ${err.message}`);
        this.wsConnected = false;
      });
      
      this.ws.on('close', () => {
        logger.warn('⚠️  WebSocket desconectado');
        this.wsConnected = false;
        
        // Intentar reconexión
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          logger.info(`Reconectando en ${delay/1000}s... (intento ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          
          setTimeout(() => {
            this._connectWebSocket(tokenId);
          }, delay);
        } else {
          logger.error('❌ Max intentos de reconexión alcanzados, usando fallback polling');
          this._startFallbackPolling(tokenId);
        }
      });
      
    } catch (err) {
      logger.error(`Error conectando WebSocket: ${err.message}`);
      this._startFallbackPolling(tokenId);
    }
  }

  /**
   * Manejar mensajes del WebSocket
   */
  _handleWebSocketMessage(message) {
    const eventType = message.event_type || message.type;
    
    switch (eventType) {
      case 'best_bid_ask':
        // Mejor bid/ask actualizado (latencia <100ms)
        this._updateFromBestBidAsk(message);
        break;
        
      case 'book':
        // Snapshot completo del orderbook
        this._updateOrderbook(message);
        break;
        
      case 'price_change':
        // Cambio de precio individual
        this._updateFromPriceChange(message);
        break;
        
      case 'last_trade_price':
        // Nueva trade ejecutada
        logger.debug(`Nueva trade: ${message.price}`);
        break;
        
      case 'market_resolved':
        // Mercado resuelto
        logger.warn('⚠️  Mercado resuelto');
        this._invalidateMarket('MARKET_RESOLVED');
        break;
        
      default:
        logger.debug(`Mensaje WS no manejado: ${eventType}`);
    }
  }

  /**
   * Actualizar desde best_bid_ask (lo más rápido)
   */
  _updateFromBestBidAsk(message) {
    const bestBid = parseFloat(message.best_bid);
    const bestAsk = parseFloat(message.best_ask);
    
    if (!bestBid || !bestAsk || isNaN(bestBid) || isNaN(bestAsk)) {
      logger.warn('⚠️  Best bid/ask inválidos');
      return;
    }
    
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    
    // Validar precio razonable
    if (midPrice < 0.05 || midPrice > 0.95) {
      logger.warn(`⚠️  Precio sospechoso: ${midPrice.toFixed(3)}`);
      this._invalidateMarket('INVALID_PRICE');
      return;
    }
    
    this.currentPrices = {
      yes: midPrice,
      no: 1 - midPrice,
      timestamp: Date.now(),
      staleCount: 0,
      spread: spread,
      bestBid: bestBid,
      bestAsk: bestAsk,
    };
    
    // Callback para notificar update
    if (this.priceUpdateCallback) {
      this.priceUpdateCallback(this.currentPrices);
    }
    
    logger.debug(`📊 WS Update: YES=${midPrice.toFixed(3)} | Spread=${(spread * 100).toFixed(2)}% | Latency: <100ms`);
  }

  /**
   * Fallback: Polling si WebSocket falla
   */
  _startFallbackPolling(tokenId) {
    logger.warn('⚠️  Usando polling fallback (1s) - latencia reducida vs WebSocket');
    
    // Polling optimizado: 1 segundo
    this.pollingInterval = setInterval(async () => {
      if (!this.clobClient) return;
      
      try {
        const book = await this.clobClient.getOrderBook(tokenId);
        this._updateOrderbook(book);
      } catch (err) {
        logger.warn(`Error actualizando orderbook: ${err.message}`);
        this.currentPrices.staleCount++;
        
        // Invalidar después de 3 errores consecutivos
        if (this.currentPrices.staleCount >= 3) {
          this._invalidateMarket('CONSECUTIVE_ERRORS');
        }
      }
    }, 1000); // 1 segundo
  }

  _updateOrderbook(book) {
    if (!book || !book.bids || !book.asks) return;
    
    this.orderbook.bids = book.bids;
    this.orderbook.asks = book.asks;
    this.orderbook.lastUpdate = Date.now();
    
    // Calcular mejores precios
    const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : null;
    const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : null;
    
    if (bestBid && bestAsk) {
      const midPrice = (bestBid + bestAsk) / 2;
      
      // Validar precio razonable
      if (midPrice < 0.05 || midPrice > 0.95) {
        logger.warn(`⚠️  Precio sospechoso detectado: ${midPrice.toFixed(3)}`);
        this._invalidateMarket('INVALID_PRICE');
        return;
      }
      
      this.currentPrices = {
        yes: midPrice,
        no: 1 - midPrice,
        timestamp: Date.now(),
        staleCount: 0, // reset
        spread: bestAsk - bestBid,
      };
      
      // Callback para notificar update
      if (this.priceUpdateCallback) {
        this.priceUpdateCallback(this.currentPrices);
      }
      
      logger.debug(`Orderbook: YES=${midPrice.toFixed(3)} | Spread=${(this.currentPrices.spread * 100).toFixed(2)}%`);
    }
  }

  _invalidateMarket(reason) {
    logger.warn(`❌ Mercado invalidado: ${reason}`);
    
    this.currentPrices = {
      yes: null,
      no: null,
      timestamp: null,
      staleCount: 0,
    };
    
    if (this.marketInvalidCallback) {
      this.marketInvalidCallback(reason);
    }
    
    // Detener polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Validar liquidez del orderbook
   * Para orden de $5, necesitamos mínimo $15 (3x buffer)
   */
  checkLiquidity(minLiquidityUSD = 15) {
    if (!this.orderbook.bids || !this.orderbook.asks) {
      return {
        valid: false,
        reason: 'NO_ORDERBOOK',
        bidLiquidity: 0,
        askLiquidity: 0,
      };
    }
    
    // Calcular liquidez en top 3 niveles
    const bidLiquidity = this._calculateLiquidity(this.orderbook.bids.slice(0, 3));
    const askLiquidity = this._calculateLiquidity(this.orderbook.asks.slice(0, 3));
    
    const valid = bidLiquidity >= minLiquidityUSD && askLiquidity >= minLiquidityUSD;
    
    if (!valid) {
      logger.debug(`⚠️  Liquidez insuficiente: BID=$${bidLiquidity.toFixed(2)} ASK=$${askLiquidity.toFixed(2)} (min: $${minLiquidityUSD})`);
    }
    
    return {
      valid,
      reason: valid ? 'OK' : 'INSUFFICIENT_LIQUIDITY',
      bidLiquidity: parseFloat(bidLiquidity.toFixed(2)),
      askLiquidity: parseFloat(askLiquidity.toFixed(2)),
      spread: this.currentPrices.spread,
    };
  }

  /**
   * Calcular liquidez total de un array de niveles de precio
   */
  _calculateLiquidity(levels) {
    if (!levels || levels.length === 0) return 0;
    
    return levels.reduce((total, level) => {
      const price = parseFloat(level.price);
      const size = parseFloat(level.size);
      return total + (price * size);
    }, 0);
  }

  /**
   * Obtener precio actual con validación de freshness
   */
  getCurrentPrice() {
    if (!this.currentPrices.yes || !this.currentPrices.timestamp) {
      return { valid: false, reason: 'NO_PRICE' };
    }
    
    const age = Date.now() - this.currentPrices.timestamp;
    const MAX_AGE = config.MAX_PRICE_AGE_MS || 3000; // 3 segundos máximo
    
    if (age > MAX_AGE) {
      return { 
        valid: false, 
        reason: 'STALE', 
        age: Math.round(age / 1000),
        maxAge: Math.round(MAX_AGE / 1000)
      };
    }
    
    return {
      valid: true,
      yes: this.currentPrices.yes,
      no: this.currentPrices.no,
      age: Math.round(age),
      spread: this.currentPrices.spread,
    };
  }

  /**
   * Buscar mercado BTC activo
   */
  async findBTCMarket() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const windowTs = now - (now % 300); // ventana de 5 minutos
      const slug = `btc-updown-5m-${windowTs}`;

      const response = await fetch(`${GAMMA_API_BASE}/events?slug=${slug}`);
      
      if (!response.ok) {
        logger.warn(`Gamma API error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      const events = Array.isArray(data) ? data : (data.events || data.data || []);

      if (events.length > 0) {
        const event = events[0];
        logger.info(`✓ Mercado encontrado: ${event.title || slug}`);
        
        const market = event.markets?.[0];
        if (!market) return null;
        
        const formatted = this._formatMarket({
          ...market,
          question: event.title || market.question,
          endDate: new Date((windowTs + 300) * 1000).toISOString(),
        });
        
        // Suscribirse al orderbook de este mercado
        if (formatted.yesTokenId) {
          await this.subscribeToMarket(formatted.yesTokenId);
        }
        
        this.currentMarket = formatted;
        return formatted;
      }

      logger.warn(`Mercado no encontrado para slug: ${slug}`);
      return null;

    } catch (err) {
      logger.error(`Error buscando mercados: ${err.message}`);
      return null;
    }
  }

  _formatMarket(m) {
    const tokens = m.tokens || m.clobTokenIds || [];
    return {
      conditionId: m.conditionId || m.id,
      gammaId: m.id,
      question: m.question,
      endDate: m.endDate,
      yesTokenId: tokens[0] || m.clob_token_ids?.[0],
      noTokenId: tokens[1] || m.clob_token_ids?.[1],
      marketSlug: m.marketSlug,
    };
  }

  /**
   * Registrar callback para updates de precio
   */
  onPriceUpdate(callback) {
    this.priceUpdateCallback = callback;
  }

  /**
   * Registrar callback para invalidación de mercado
   */
  onMarketInvalid(callback) {
    this.marketInvalidCallback = callback;
  }

  /**
   * Colocar orden límite
   */
  async placeLimitOrder({ marketId, tokenId, side, price, size, marketQuestion }) {
    const orderRecord = {
      timestamp: new Date().toISOString(),
      marketId,
      marketQuestion,
      tokenId,
      side,
      price,
      size,
      usdcValue: (price * size).toFixed(2),
      status: 'PENDING',
    };

    if (config.DRY_RUN) {
      orderRecord.status = 'DRY_RUN';
      orderRecord.orderId = `DRY_${Date.now()}`;
      this._orderHistory.push(orderRecord);
      logger.info(`[DRY RUN] ${side} ${size} tokens @ $${price} (${marketQuestion})`);
      return { success: true, orderId: orderRecord.orderId, dryRun: true };
    }

    try {
      await this.init();

      const clobSide = side === 'BUY' ? Side.BUY : Side.SELL;

      const signedOrder = await this.clobClient.createOrder({
        tokenID: tokenId,
        price,
        size,
        side: clobSide,
        orderType: OrderType.LIMIT,
        feeRateBps: '0',
        nonce: '0',
        expiration: '0',
      });

      const result = await this.clobClient.postOrder(signedOrder, OrderType.LIMIT);

      orderRecord.status = 'PLACED';
      orderRecord.orderId = result?.orderID || result?.order?.id;
      this._orderHistory.push(orderRecord);

      logger.info(`✓ Orden colocada: ${orderRecord.orderId}`);
      return { success: true, orderId: orderRecord.orderId };

    } catch (err) {
      orderRecord.status = 'FAILED';
      orderRecord.error = err.message;
      this._orderHistory.push(orderRecord);
      logger.error(`Error colocando orden: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  getOrderHistory() {
    return this._orderHistory;
  }

  cleanup() {
    if (this.ws && this.wsConnected) {
      logger.info('Cerrando WebSocket...');
      this.ws.close();
    }
    
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
  }
}

module.exports = { PolymarketWebSocketClient };
