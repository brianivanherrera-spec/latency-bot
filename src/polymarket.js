/**
 * Polymarket CLOB API Client - Deposit Wallet Flow v4
 *
 * PROBLEMA DEL SDK: ClobClient.createOrDeriveApiKey() no pasa funderAddress
 * a createL1Headers → creds quedan registradas contra la EOA → al firmar
 * órdenes con POLY_1271 (maker=depositWallet), Polymarket rechaza:
 * "the order signer address has to be the address of the API KEY"
 *
 * SOLUCIÓN: Bypassear SDK para derivar API creds manualmente,
 * pasando depositWalletAddress como `address` en EIP-712 headers.
 */

const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('POLYMARKET');

const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const DEPOSIT_WALLET_IMPL    = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';
const CLOB_API_BASE          = 'https://clob.polymarket.com';
const GAMMA_API_BASE         = 'https://gamma-api.polymarket.com';
const MSG_TO_SIGN            = 'This message attests that I have read and agree to the polymarket.com Terms of Use.';

let ClobClient, SignatureTypeV2, Chain, Side, OrderType;
let createWalletClient, http, privateKeyToAccount;
let deriveDepositWallet;
let HAS_CLOB_V2 = false;
let HAS_RELAYER = false;

try {
  ({ ClobClient, SignatureTypeV2, Chain, Side, OrderType } = require('@polymarket/clob-client-v2'));
  ({ createWalletClient, http } = require('viem'));
  ({ privateKeyToAccount } = require('viem/accounts'));
  HAS_CLOB_V2 = true;
  logger.info('✓ @polymarket/clob-client-v2 disponible');
} catch (e) {
  logger.warn(`CLOB V2 client no instalado: ${e.message}`);
}

try {
  ({ deriveDepositWallet } = require('@polymarket/builder-relayer-client'));
  HAS_RELAYER = true;
  logger.info('✓ @polymarket/builder-relayer-client disponible');
} catch (e) {
  logger.warn(`builder-relayer-client no instalado: ${e.message}`);
}

class PolymarketClient {
  constructor() {
    this.clobClient = null;
    this._initialized = false;
    this._orderHistory = [];
    this._depositWalletAddress = null;
  }

  // Construir L1 auth headers con depositWallet como POLY_ADDRESS
  async _buildL1Headers(walletClient, depositWalletAddress) {
    const ts    = Math.floor(Date.now() / 1000);
    const nonce = 0n; // BigInt — viem es estricto con uint256

    const sig = await walletClient.signTypedData({
      domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 },
      types: {
        ClobAuth: [
          { name: 'address',   type: 'address' },
          { name: 'timestamp', type: 'string'  },
          { name: 'nonce',     type: 'uint256' },
          { name: 'message',   type: 'string'  },
        ],
      },
      primaryType: 'ClobAuth',
      message: {
        address:   depositWalletAddress,
        timestamp: `${ts}`,
        nonce,
        message:   MSG_TO_SIGN,
      },
    });

    return {
      'POLY_ADDRESS':   depositWalletAddress,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': `${ts}`,
      'POLY_NONCE':     '0',
    };
  }

  // Crear o derivar creds registradas contra la deposit wallet (bypass SDK)
  async _deriveCredsForDepositWallet(walletClient, depositWalletAddress) {
    // Intentar crear primero
    try {
      const h = await this._buildL1Headers(walletClient, depositWalletAddress);
      const res = await fetch(`${CLOB_API_BASE}/auth/api-key`, { method: 'POST', headers: h });
      const d = await res.json();
      if (d.apiKey) {
        logger.info('API key creada para deposit wallet');
        return { key: d.apiKey, secret: d.secret, passphrase: d.passphrase };
      }
      logger.info(`Create respondió: ${JSON.stringify(d)} — intentando derive`);
    } catch (e) {
      logger.warn(`POST /auth/api-key: ${e.message}`);
    }

    // Derivar si ya existe
    const h2 = await this._buildL1Headers(walletClient, depositWalletAddress);
    const res2 = await fetch(`${CLOB_API_BASE}/auth/derive-api-key`, { method: 'GET', headers: h2 });
    const d2 = await res2.json();
    if (!d2.apiKey) throw new Error(`derive-api-key falló: ${JSON.stringify(d2)}`);
    logger.info('API key derivada para deposit wallet');
    return { key: d2.apiKey, secret: d2.secret, passphrase: d2.passphrase };
  }

  async _init() {
    if (this._initialized) return;

    if (config.DRY_RUN) {
      logger.info('DRY RUN: modo simulación');
      this._initialized = true;
      return;
    }

    if (!config.POLY_PRIVATE_KEY) throw new Error('POLY_PRIVATE_KEY no configurada');
    if (!HAS_CLOB_V2)             throw new Error('clob-client-v2 no instalado');
    if (!HAS_RELAYER)             throw new Error('builder-relayer-client no instalado');

    const privateKey = config.POLY_PRIVATE_KEY.startsWith('0x')
      ? config.POLY_PRIVATE_KEY : `0x${config.POLY_PRIVATE_KEY}`;

    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({
      account,
      transport: http('https://polygon-rpc.com'),
    });

    logger.info(`EOA: ${account.address}`);

    // Paso 1: Deposit wallet (determinista, sync)
    const depositWalletAddress = config.POLY_DEPOSIT_WALLET ||
      deriveDepositWallet(account.address, DEPOSIT_WALLET_FACTORY, DEPOSIT_WALLET_IMPL);

    logger.info(`Deposit wallet: ${depositWalletAddress}`);
    this._depositWalletAddress = depositWalletAddress;

    // Paso 2: API creds (registradas contra deposit wallet)
    let creds;
    if (config.POLY_API_KEY && config.POLY_API_SECRET && config.POLY_PASSPHRASE) {
      creds = { key: config.POLY_API_KEY, secret: config.POLY_API_SECRET, passphrase: config.POLY_PASSPHRASE };
      logger.info(`API creds desde config: ${creds.key.slice(0, 8)}...`);
    } else {
      logger.info('Derivando API creds para deposit wallet (bypass SDK)...');
      creds = await this._deriveCredsForDepositWallet(walletClient, depositWalletAddress);
      logger.info(`API creds: ${creds.key.slice(0, 8)}...`);
    }

    // Paso 3: ClobClient con POLY_1271 (maker=signer=depositWallet)
    this.clobClient = new ClobClient({
      host:          CLOB_API_BASE,
      chain:         Chain?.POLYGON ?? 137,
      signer:        walletClient,
      creds,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: depositWalletAddress,
    });

    this._initialized = true;
    logger.info(`✅ CLOB V2 inicializado — deposit wallet: ${depositWalletAddress}`);
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
        tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      } catch(e) { tokens = []; }
    }
    return {
      conditionId: m.conditionId || m.id,
      gammaId:     m.id,
      question:    m.question,
      endDate:     m.endDate,
      yesTokenId:  tokens[0] || null,
      noTokenId:   tokens[1] || null,
      marketSlug:  m.marketSlug,
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
      orderRecord.status  = 'DRY_RUN';
      orderRecord.orderId = `DRY_${Date.now()}`;
      this._orderHistory.push(orderRecord);
      logger.info(`[DRY RUN] ${side} ${size} tokens @ $${price}`);
      return { success: true, orderId: orderRecord.orderId, dryRun: true };
    }

    if (!tokenId) {
      logger.error(`Token ID inválido para: ${marketQuestion}`);
      return { success: false, error: 'Token ID no disponible' };
    }

    try {
      await this._init();

      const result = await this.clobClient.createAndPostOrder({
        tokenID:   tokenId,
        price,
        size,
        side:      side === 'BUY' ? Side.BUY : Side.SELL,
        orderType: OrderType.GTC,
      });

      logger.info(`[LIVE] SDK response: ${JSON.stringify(result)}`);

      if (!result?.success) {
        const errMsg = result?.errorMsg || result?.error || 'Respuesta inesperada del SDK';
        logger.error(`[LIVE] ❌ Orden rechazada: ${errMsg}`);
        orderRecord.status = 'REJECTED';
        orderRecord.error  = errMsg;
        this._orderHistory.push(orderRecord);
        return { success: false, error: errMsg };
      }

      const orderId = result?.orderID || result?.orderId || result?.id;
      orderRecord.status  = 'PLACED';
      orderRecord.orderId = orderId;
      this._orderHistory.push(orderRecord);

      logger.info(`[LIVE] ✅ Order ID: ${orderId}`);
      return { success: true, orderId };

    } catch (err) {
      orderRecord.status = 'FAILED';
      orderRecord.error  = err.message;
      this._orderHistory.push(orderRecord);
      logger.error(`Error colocando orden: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  getOrderHistory() { return this._orderHistory; }
}

module.exports = { PolymarketClient };
