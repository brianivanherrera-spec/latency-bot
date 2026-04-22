/**
 * Polymarket CLOB API Client
 * Limit orders en mercados BTC 5-minute
 * Docs: https://docs.polymarket.com/#clob-api
 */

const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('POLYMARKET');

// Manejo condicional de imports (algunos pueden no estar disponibles)
let ClobClient, Side, OrderType, ethers;
try {
  ({ ClobClient, Side, OrderType } = require('@polymarket/clob-client'));
  ethers = require('ethers');
} catch (e) {
  logger.warn('Polymarket CLOB client no instalado, usando modo HTTP directo');
}

const CLOB_API_BASE = 'https://clob.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

class PolymarketClient {
  constructor() {
    this.clobClient = null;
    this.wallet = null;
    this._initialized = false;
    this._orderHistory = [];
  }

  async _init() {
    if (this._initialized) return;

    if (config.DRY_RUN) {
      logger.info('DRY RUN: Polymarket client en modo simulación');
      this._initialized = true;
      return;
    }

    if (!config.POLY_PRIVATE_KEY) {
      throw new Error('POLY_PRIVATE_KEY no configurada en variables de entorno');
    }

    if (!ethers || !ClobClient) {
      throw new Error('Dependencias de Polymarket no instaladas. Ejecutar: npm install @polymarket/clob-client ethers');
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
      logger.info(`Wallet: ${this.wallet.address}`);
    } catch (err) {
      throw new Error(`Error inicializando Polymarket: ${err.message}`);
    }
  }

  /**
   * Buscar mercado BTC 5-minute activo en Polymarket
   * Retorna el mercado más cercano a su cierre (mayor urgencia)
   */
  async findBTCMarket() {
  try {
  const response = await fetch(
  `${GAMMA_API_BASE}/markets?active=true&closed=false&limit=50&tag_slug=crypto&order=volume24hr&ascending=false`
);

    if (!response.ok) throw new Error(`Gamma API error: ${response.status}`);

    const data = await response.json();
    const markets = Array.isArray(data) ? data : (data.markets || data.data || []);

    // Buscar mercado BTC 5 minutos - múltiples idiomas
    const btc5min = markets.find(m => {
      const q = (m.question || '').toLowerCase();
      return (
        (q.includes('btc') || q.includes('bitcoin')) &&
        (q.includes('5 min') || q.includes('5min') || q.includes('5 minutos') || 
         q.includes('5-min') || q.includes('five min')) &&
        m.active && !m.closed && !m.archived
      );
    });

    if (btc5min) {
      logger.info(`Mercado 5min encontrado: ${btc5min.question}`);
      return this._formatMarket(btc5min);
    }

 logger.warn('No se encontró mercado BTC 5min');
const allQuestions = markets.slice(0, 20).map(m => m.question);
logger.info('Mercados disponibles: ' + JSON.stringify(allQuestions));
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
      question: m.question,
      endDate: m.endDate,
      yesTokenId: tokens[0] || m.clob_token_ids?.[0],
      noTokenId: tokens[1] || m.clob_token_ids?.[1],
      marketSlug: m.marketSlug,
    };
  }

  /**
   * Colocar limit order en Polymarket
   */
  async placeLimitOrder({ marketId, tokenId, side, price, size, marketQuestion }) {
    // Registrar en historial siempre
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
      this._logOrderHistory();
      return { success: true, orderId: orderRecord.orderId, dryRun: true };
    }

    try {
      await this._init();

      // Construir y firmar orden
      const clobSide = side === 'BUY' ? Side.BUY : Side.SELL;

      const signedOrder = await this.clobClient.createOrder({
        tokenID: tokenId,
        price,
        size,
        side: clobSide,
        orderType: OrderType.LIMIT,
        feeRateBps: '0',
        nonce: '0',
        expiration: '0', // no expira
      });

      const result = await this.clobClient.postOrder(signedOrder, OrderType.LIMIT);

      orderRecord.status = 'PLACED';
      orderRecord.orderId = result?.orderID || result?.order?.id;
      this._orderHistory.push(orderRecord);
      this._logOrderHistory();

      return { success: true, orderId: orderRecord.orderId };

    } catch (err) {
      orderRecord.status = 'FAILED';
      orderRecord.error = err.message;
      this._orderHistory.push(orderRecord);
      logger.error(`Error colocando orden: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  _logOrderHistory() {
    const last5 = this._orderHistory.slice(-5);
    logger.info('--- Últimas órdenes ---');
    last5.forEach(o => {
      logger.info(`[${o.status}] ${o.side} ${o.size}t @ $${o.price} | USDC: $${o.usdcValue} | ${o.timestamp}`);
    });
  }

  getOrderHistory() {
    return this._orderHistory;
  }
}

module.exports = { PolymarketClient };
