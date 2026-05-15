/**
 * Polymarket CLOB API Client
 */
 
const { Logger } = require('./logger');
const config = require('./config');
 
const logger = new Logger('POLYMARKET');
 
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
      throw new Error('POLY_PRIVATE_KEY no configurada');
    }
 
    if (!ethers || !ClobClient) {
      throw new Error('Dependencias de Polymarket no instaladas');
    }
 
    try {
      this.wallet = new ethers.Wallet(config.POLY_PRIVATE_KEY);
      this.clobClient = new ClobClient(
        CLOB_API_BASE,
        137,
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
 
  async findBTCMarket() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const windowTs = now - (now % 300);
      const slug = `btc-updown-5m-${windowTs}`;
 
      const response = await fetch(
        `${GAMMA_API_BASE}/events?slug=${slug}`
      );
 
      if (!response.ok) throw new Error(`Gamma API error: ${response.status}`);
 
      const data = await response.json();
      const events = Array.isArray(data) ? data : (data.events || data.data || []);
 
      if (events.length > 0) {
        const event = events[0];
        logger.info(`Mercado encontrado: ${event.title || slug}`);
        const market = event.markets?.[0];
        if (!market) return null;
        return this._formatMarket({
          ...market,
          question: event.title || market.question,
          endDate: new Date((windowTs + 300) * 1000).toISOString(),
        });
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
    // ✅ FIX: Los tokens pueden ser objetos {token_id, outcome} o strings
    const yesToken = tokens[0];
    const noToken = tokens[1];
    return {
      conditionId: m.conditionId || m.id,
      gammaId: m.id,
      question: m.question,
      endDate: m.endDate,
      yesTokenId: yesToken?.token_id || yesToken || m.clob_token_ids?.[0],
      noTokenId: noToken?.token_id || noToken || m.clob_token_ids?.[1],
      marketSlug: m.marketSlug,
    };
  }
 
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

    // ✅ Validar tokenId antes de intentar
    if (!tokenId) {
      logger.error(`Token ID inválido para mercado: ${marketQuestion}`);
      return { success: false, error: 'Token ID no disponible' };
    }
 
    try {
      await this._init();
 
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
}
 
module.exports = { PolymarketClient };
