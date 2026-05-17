/**
 * Polymarket CLOB API Client - v7 SIMPLE
 *
 * Cuentas email/Google (Magic Link) = signatureType POLY_PROXY (1)
 * - API creds: derivadas via SDK con EOA (sin bypass manual)
 * - Órdenes: firmadas con POLY_PROXY, funder = proxy/deposit wallet
 *
 * POLY_PROXY es el tipo correcto para cuentas nuevas email según docs oficiales.
 */

const { Logger } = require('./logger');
const config = require('./config');
const logger = new Logger('POLYMARKET');

const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const DEPOSIT_WALLET_IMPL    = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';
const CLOB_API_BASE  = 'https://clob.polymarket.com';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

let ClobClient, SignatureTypeV2, Chain, Side, OrderType;
let createWalletClient, http, privateKeyToAccount;
let deriveDepositWallet;
let HAS_CLOB_V2 = false, HAS_RELAYER = false;

try {
  ({ ClobClient, SignatureTypeV2, Chain, Side, OrderType } = require('@polymarket/clob-client-v2'));
  ({ createWalletClient, http } = require('viem'));
  ({ privateKeyToAccount } = require('viem/accounts'));
  HAS_CLOB_V2 = true;
  logger.info('✓ @polymarket/clob-client-v2 disponible');
} catch (e) { logger.warn(`CLOB V2 no instalado: ${e.message}`); }

try {
  ({ deriveDepositWallet } = require('@polymarket/builder-relayer-client'));
  HAS_RELAYER = true;
  logger.info('✓ @polymarket/builder-relayer-client disponible');
} catch (e) { logger.warn(`builder-relayer-client no instalado: ${e.message}`); }

class PolymarketClient {
  constructor() {
    this.clobClient = null;
    this._initialized = false;
    this._orderHistory = [];
    this._depositWalletAddress = null;
  }

  async _init() {
    if (this._initialized) return;
    if (config.DRY_RUN) { logger.info('DRY RUN'); this._initialized = true; return; }

    if (!config.POLY_PRIVATE_KEY) throw new Error('POLY_PRIVATE_KEY no configurada');
    if (!HAS_CLOB_V2) throw new Error('clob-client-v2 no instalado');

    const pk = config.POLY_PRIVATE_KEY.startsWith('0x')
      ? config.POLY_PRIVATE_KEY : `0x${config.POLY_PRIVATE_KEY}`;

    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({ account, transport: http('https://polygon-rpc.com') });
    logger.info(`EOA: ${account.address}`);

    // Proxy wallet (donde están los fondos)
    let proxyAddress = config.POLY_FUNDER_ADDRESS || config.POLY_DEPOSIT_WALLET;
    if (!proxyAddress && HAS_RELAYER) {
      proxyAddress = deriveDepositWallet(account.address, DEPOSIT_WALLET_FACTORY, DEPOSIT_WALLET_IMPL);
    }
    logger.info(`Proxy/funder wallet: ${proxyAddress}`);
    this._depositWalletAddress = proxyAddress;

    // API creds via SDK con EOA (sin ningún bypass)
    let creds;
    if (config.POLY_API_KEY && config.POLY_API_SECRET && config.POLY_PASSPHRASE) {
      creds = { key: config.POLY_API_KEY, secret: config.POLY_API_SECRET, passphrase: config.POLY_PASSPHRASE };
      logger.info(`Creds desde config: ${creds.key.slice(0,8)}...`);
    } else {
      // Derivar con EOA puro — sin signatureType, sin funderAddress
      const tempClient = new ClobClient({
        host: CLOB_API_BASE, chain: Chain?.POLYGON ?? 137, signer: walletClient,
      });
      creds = await tempClient.createOrDeriveApiKey();
      logger.info(`Creds derivadas (EOA): ${creds.key.slice(0,8)}...`);
    }

    // Cliente final con POLY_PROXY para órdenes
    this.clobClient = new ClobClient({
      host:          CLOB_API_BASE,
      chain:         Chain?.POLYGON ?? 137,
      signer:        walletClient,
      creds,
      signatureType: SignatureTypeV2.POLY_PROXY,   // = 1, correcto para email/Magic
      funderAddress: proxyAddress,
    });

    this._initialized = true;
    logger.info(`✅ CLOB V2 listo (POLY_PROXY) — funder: ${proxyAddress}`);
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
        logger.info(`Mercado: ${event.title || slug}`);
        const market = event.markets?.[0];
        if (!market) return null;
        return this._formatMarket({ ...market, question: event.title || market.question,
          endDate: new Date((windowTs + 300) * 1000).toISOString() });
      }
      logger.warn(`Mercado no encontrado: ${slug}`); return null;
    } catch (err) { logger.error(`Error buscando mercados: ${err.message}`); return null; }
  }

  _formatMarket(m) {
    let tokens = m.tokens || [];
    if (!tokens.length && m.clobTokenIds) {
      try { tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; }
      catch(e) { tokens = []; }
    }
    return { conditionId: m.conditionId||m.id, gammaId: m.id, question: m.question,
      endDate: m.endDate, yesTokenId: tokens[0]||null, noTokenId: tokens[1]||null, marketSlug: m.marketSlug };
  }

  async placeLimitOrder({ marketId, tokenId, side, price, size, marketQuestion }) {
    const rec = { timestamp: new Date().toISOString(), marketId, marketQuestion,
      tokenId, side, price, size, usdcValue: (price * size).toFixed(2), status: 'PENDING' };

    if (config.DRY_RUN) {
      rec.status = 'DRY_RUN'; rec.orderId = `DRY_${Date.now()}`;
      this._orderHistory.push(rec);
      logger.info(`[DRY RUN] ${side} ${size} @ $${price}`);
      return { success: true, orderId: rec.orderId, dryRun: true };
    }
    if (!tokenId) { logger.error(`Token ID inválido`); return { success: false, error: 'Token ID no disponible' }; }

    try {
      await this._init();
      const result = await this.clobClient.createAndPostOrder({
        tokenID: tokenId, price, size,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        orderType: OrderType.GTC,
      });

      logger.info(`[LIVE] response: ${JSON.stringify(result)}`);

      if (!result?.success) {
        const errMsg = result?.errorMsg || result?.error || 'Respuesta inesperada';
        logger.error(`[LIVE] ❌ ${errMsg}`);
        rec.status = 'REJECTED'; rec.error = errMsg;
        this._orderHistory.push(rec);
        return { success: false, error: errMsg };
      }

      const orderId = result?.orderID || result?.orderId || result?.id;
      rec.status = 'PLACED'; rec.orderId = orderId;
      this._orderHistory.push(rec);
      logger.info(`[LIVE] ✅ Order ID: ${orderId}`);
      return { success: true, orderId };

    } catch (err) {
      rec.status = 'FAILED'; rec.error = err.message;
      this._orderHistory.push(rec);
      logger.error(`Error colocando orden: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  getOrderHistory() { return this._orderHistory; }
}

module.exports = { PolymarketClient };
