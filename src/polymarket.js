/**
 * Polymarket CLOB v8 — POLY_1271 con balance cache update
 *
 * Flujo correcto según docs oficiales:
 * 1. Derivar deposit wallet (determinista)
 * 2. Derivar API creds con EOA
 * 3. Actualizar balance cache: GET /balance-allowance/update?asset_type=COLLATERAL&signature_type=3
 * 4. Órdenes con signatureType=POLY_1271, maker=signer=depositWallet
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

    // Paso 1: Deposit wallet
    let depositWallet = config.POLY_FUNDER_ADDRESS || config.POLY_DEPOSIT_WALLET;
    if (!depositWallet && HAS_RELAYER) {
      depositWallet = deriveDepositWallet(account.address, DEPOSIT_WALLET_FACTORY, DEPOSIT_WALLET_IMPL);
    }
    logger.info(`Deposit wallet: ${depositWallet}`);
    this._depositWalletAddress = depositWallet;

    // Paso 2: API creds via EOA
    let creds;
    if (config.POLY_API_KEY && config.POLY_API_SECRET && config.POLY_PASSPHRASE) {
      creds = { key: config.POLY_API_KEY, secret: config.POLY_API_SECRET, passphrase: config.POLY_PASSPHRASE };
      logger.info(`Creds config: ${creds.key.slice(0,8)}...`);
    } else {
      const tempClient = new ClobClient({ host: CLOB_API_BASE, chain: Chain?.POLYGON ?? 137, signer: walletClient });
      creds = await tempClient.createOrDeriveApiKey();
      logger.info(`Creds derivadas: ${creds.key.slice(0,8)}...`);
    }

    // Paso 3: Cliente con POLY_1271
    this.clobClient = new ClobClient({
      host:          CLOB_API_BASE,
      chain:         Chain?.POLYGON ?? 137,
      signer:        walletClient,
      creds,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: depositWallet,
    });

    // Paso 4: Actualizar balance cache (CRÍTICO — docs oficiales)
    try {
      logger.info('Actualizando balance cache para deposit wallet...');
      await this.clobClient.updateBalanceAllowance({ assetType: 'COLLATERAL', signatureType: 3 });
      logger.info('✓ Balance cache actualizado');
    } catch (e) {
      // Intentar via fetch directo si el SDK no tiene el método
      try {
        const res = await fetch(`${CLOB_API_BASE}/balance-allowance/update?asset_type=COLLATERAL&signature_type=3`, {
          method: 'GET',
          headers: {
            'POLY_ADDRESS': depositWallet,
            'POLY-API-KEY': creds.key,
          },
        });
        const d = await res.json();
        logger.info(`Balance cache update: ${JSON.stringify(d).slice(0,100)}`);
      } catch (e2) {
        logger.warn(`Balance cache update falló (puede estar OK): ${e2.message}`);
      }
    }

    this._initialized = true;
    logger.info(`✅ CLOB V2 listo (POLY_1271) — deposit wallet: ${depositWallet}`);
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
    if (!tokenId) return { success: false, error: 'Token ID no disponible' };

    try {
      await this._init();
      // GTC con timeout — pone orden límite en el book y espera hasta GTC_TIMEOUT_SECONDS
      const GTC_TIMEOUT_MS = (config.GTC_TIMEOUT_SECONDS || 60) * 1000;

      const result = await this.clobClient.createAndPostOrder({
        tokenID: tokenId, price, size,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        orderType: OrderType.GTC, // Good Till Cancelled — espera fill en el book
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
      let orderStatus = result?.status || 'unknown';
      rec.status = 'PLACED'; rec.orderId = orderId;
      this._orderHistory.push(rec);
      logger.info(`[LIVE] ✅ GTC Order ID: ${orderId} | status inicial: ${orderStatus}`);

      // Si ya llenó al instante → retornar inmediatamente
      if (orderStatus === 'matched') {
        return { success: true, orderId, status: 'matched' };
      }

      // Orden en el book ('live') → polling hasta fill o timeout
      if (orderStatus === 'live') {
        logger.info(`[LIVE] 📋 Orden en book — esperando fill (timeout: ${GTC_TIMEOUT_MS/1000}s)`);
        const deadline = Date.now() + GTC_TIMEOUT_MS;
        const POLL_INTERVAL_MS = 5000;

        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          try {
            const orderData = await this.clobClient.getOrder(orderId);
            orderStatus = orderData?.status || orderStatus;
            const sizeFilled = orderData?.size_matched || orderData?.sizeFilled || 0;
            logger.info(`[LIVE] 🔄 Poll: status=${orderStatus} filled=${sizeFilled}/${size}`);

            if (orderStatus === 'matched') {
              logger.info(`[LIVE] ✅ Orden llenada (GTC poll)`);
              return { success: true, orderId, status: 'matched' };
            }
            if (orderStatus === 'cancelled' || orderStatus === 'canceled') {
              logger.warn(`[LIVE] ⚠️ Orden cancelada durante poll`);
              return { success: false, error: 'cancelled', orderId };
            }
          } catch (pollErr) {
            logger.warn(`[LIVE] Poll error: ${pollErr.message}`);
          }
        }

        // Timeout — cancelar la orden para no quedar expuesto
        logger.warn(`[LIVE] ⏱️ Timeout GTC (${GTC_TIMEOUT_MS/1000}s) — cancelando orden ${orderId}`);
        try {
          await this.clobClient.cancelOrder({ orderId });
          logger.info(`[LIVE] 🚫 Orden GTC cancelada por timeout`);
        } catch (cancelErr) {
          logger.error(`[LIVE] Error cancelando orden: ${cancelErr.message}`);
        }
        return { success: false, error: 'gtc_timeout', orderId };
      }

      return { success: true, orderId, status: orderStatus };

    } catch (err) {
      rec.status = 'FAILED'; rec.error = err.message;
      this._orderHistory.push(rec);
      logger.error(`Error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  getOrderHistory() { return this._orderHistory; }

  // Consultar balance USDC real de la deposit wallet en el CLOB
  async getBalance() {
    try {
      await this._init();
      const result = await this.clobClient.getBalanceAllowance({
        asset_type: 'COLLATERAL',
      });
      // El CLOB devuelve el balance en unidades USDC (6 decimales)
      const raw = result?.balance ?? result?.allowance ?? result?.data?.balance;
      if (raw === undefined) return null;
      return parseFloat((parseFloat(raw) / 1e6).toFixed(2));
    } catch (e) {
      // Fallback: consultar via fetch directo
      try {
        const h = await this._buildAuthHeaders();
        const res = await fetch(`${CLOB_API_BASE}/balance-allowance?asset_type=COLLATERAL`, {
          method: 'GET', headers: h,
        });
        const d = await res.json();
        const raw = d?.balance ?? d?.data?.balance;
        if (raw === undefined) return null;
        return parseFloat((parseFloat(raw) / 1e6).toFixed(2));
      } catch (e2) {
        return null;
      }
    }
  }

  // Headers L2 autenticados para llamadas directas
  async _buildAuthHeaders() {
    if (!this.clobClient?.creds) return {};
    const ts = Math.floor(Date.now() / 1000);
    return {
      'POLY_ADDRESS':    this._depositWalletAddress,
      'POLY-API-KEY':    this.clobClient.creds.key,
      'POLY-SECRET':     this.clobClient.creds.secret,
      'POLY-PASSPHRASE': this.clobClient.creds.passphrase,
      'POLY-TIMESTAMP':  String(ts),
    };
  }
}

module.exports = { PolymarketClient };
