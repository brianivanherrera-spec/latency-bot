/**
 * Polymarket CLOB API Client - V2
 * Configurado para browser wallet (Rabby/MetaMask) con Gnosis Safe proxy
 */

const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('POLYMARKET');

let ClobClient, Side, OrderType, Chain;
let createWalletClient, http, privateKeyToAccount;
let HAS_CLOB_V2 = false;

try {
  ({ ClobClient, Side, OrderType, Chain } = require('@polymarket/clob-client-v2'));
  ({ createWalletClient, http } = require('viem'));
  ({ privateKeyToAccount } = require('viem/accounts'));
  HAS_CLOB_V2 = true;
  logger.info('✓ @polymarket/clob-client-v2 disponible');
} catch (e) {
  logger.warn(`CLOB V2 client no instalado: ${e.message}`);
}

const CLOB_API_BASE = 'https://clob.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

class PolymarketClient {
  constructor() {
    this.clobClient = null;
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

    if (!config.POLY_PRIVATE_KEY) throw new Error('POLY_PRIVATE_KEY no configurada');
    // POLY_FUNDER_ADDRESS es opcional (solo necesaria para cuentas con Rabby/MetaMask)
    if (!HAS_CLOB_V2) throw new Error('clob-client-v2 no instalado');

    try {
      const privateKey = config.POLY_PRIVATE_KEY.startsWith('0x')
        ? config.POLY_PRIVATE_KEY
        : `0x${config.POLY_PRIVATE_KEY}`;

      const account = privateKeyToAccount(privateKey);
      const walletClient = createWalletClient({
        account,
        transport: http('https://polygon-rpc.com'),
      });

      logger.info(`Wallet EOA (firmante): ${account.address}`);
      logger.info(`Funder address (proxy): ${config.POLY_FUNDER_ADDRESS}`);

      // Cliente L1 para derivar credenciales
      const useFunder = !!config.POLY_FUNDER_ADDRESS;
      const l1Client = new ClobClient({
        host: CLOB_API_BASE,
        chain: Chain.POLYGON,
        signer: walletClient,
        ...(useFunder && { funderAddress: config.POLY_FUNDER_ADDRESS, signatureType: 2 }),
      });

      let creds;
      if (config.POLY_API_KEY && config.POLY_API_SECRET && config.POLY_PASSPHRASE) {
        creds = {
          key: config.POLY_API_KEY,
          secret: config.POLY_API_SECRET,
          passphrase: config.POLY_PASSPHRASE,
        };
        logger.info(`Usando credentials configuradas: ${creds.key.slice(0, 8)}...`);
      } else {
        logger.info('Derivando API credentials...');
        creds = await l1Client.createOrDeriveApiKey();
        logger.info(`Credentials obtenidas: ${creds.key.slice(0, 8)}...`);
      }

      // Cliente L2 autenticado
      this.clobClient = new ClobClient({
        host: CLOB_API_BASE,
        chain: Chain.POLYGON,
        signer: walletClient,
        creds,
        ...(useFunder && { funderAddress: config.POLY_FUNDER_ADDRESS, signatureType: 2 }),
      });

      this._initialized = true;
      logger.info('✅ Polymarket CLOB V2 inicializado (Gnosis Safe mode)');

    } catch (err) {
      throw new Error(`Error inicializando Polymarket: ${err.message}`);
    }
  }

  async findBTCMarket() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const windowTs = now - (now % 300);
      const slug = `btc-updown-5m-${windowTs}`;

      const response = await fetch(`${GAMMA_API_BASE}/events?slug=${slug}`);
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

      logger.warn(`Mercado no encontrado: ${slug}`);
      return null;

    } catch (err) {
      logger.error(`Error buscando mercados: ${err.message}`);
      return null;
    }
  }

  _formatMarket(m) {
    let tokens = m.tokens || [];
    if (!tokens.length && m.clobTokenIds) {
      try {
        tokens = typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : m.clobTokenIds;
      } catch(e) {
        tokens = [];
      }
    }

    return {
      conditionId: m.conditionId || m.id,
      gammaId: m.id,
      question: m.question,
      endDate: m.endDate,
      yesTokenId: tokens[0] || null,
      noTokenId: tokens[1] || null,
      marketSlug: m.marketSlug,
    };
  }

  async placeLimitOrder({ marketId, tokenId, side, price, size, marketQuestion }) {
    const orderRecord = {
      timestamp: new Date().toISOString(),
      marketId, marketQuestion, tokenId, side, price, size,
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

    if (!tokenId) {
      logger.error(`Token ID inválido para: ${marketQuestion}`);
      return { success: false, error: 'Token ID no disponible' };
    }

    try {
      await this._init();

      const result = await this.clobClient.createAndPostOrder({
        tokenID: tokenId,
        price,
        size,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        orderType: OrderType.GTC,
      });

      logger.info(`[LIVE] SDK response: ${JSON.stringify(result)}`);

      if (!result?.success) {
        const errMsg = result?.errorMsg || result?.error || 'Respuesta inesperada del SDK';
        logger.error(`[LIVE] ❌ Orden rechazada: ${errMsg}`);
        orderRecord.status = 'REJECTED';
        orderRecord.error = errMsg;
        this._orderHistory.push(orderRecord);
        return { success: false, error: errMsg };
      }

      const orderId = result?.orderID || result?.orderId || result?.id;
      orderRecord.status = 'PLACED';
      orderRecord.orderId = orderId;
      this._orderHistory.push(orderRecord);

      logger.info(`[LIVE] ✅ Order ID: ${orderId}`);
      return { success: true, orderId };

    } catch (err) {
      orderRecord.status = 'FAILED';
      orderRecord.error = err.message;
      this._orderHistory.push(orderRecord);
      logger.error(`Error colocando orden: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  getOrderHistory() { return this._orderHistory; }
}

module.exports = { PolymarketClient };
