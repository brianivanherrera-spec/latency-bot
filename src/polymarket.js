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

  // Pre-fetch del próximo mercado por timestamp conocido
  async findNextBTCMarket(nextWindowTs) {
    try {
      const slug = `btc-updown-5m-${nextWindowTs}`;
      const response = await fetch(`${GAMMA_API_BASE}/events?slug=${slug}`);
      if (!response.ok) return null;
      const data = await response.json();
      const events = Array.isArray(data) ? data : (data.events || data.data || []);
      if (events.length > 0) {
        const event = events[0];
        const market = event.markets?.[0];
        if (!market) return null;
        return this._formatMarket({ ...market,
          question: event.title || market.question,
          endDate: new Date((nextWindowTs + 300) * 1000).toISOString() });
      }
      return null;
    } catch (err) {
      logger.warn(`[POLY] Pre-fetch failed: ${err.message}`);
      return null;
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

  async placeLimitOrder({ marketId, tokenId, side, price, size, marketQuestion, marketEndTs }) {
    const rec = { timestamp: new Date().toISOString(), marketId, marketQuestion,
      tokenId, side, price, size, usdcValue: (price * size).toFixed(2), status: 'PENDING' };

    if (config.DRY_RUN) {
      rec.status = 'DRY_RUN'; rec.orderId = `DRY_${Date.now()}`;
      this._orderHistory.push(rec);
      logger.info(`[DRY RUN] ${side} ${size} @ $${price}`);
      return { success: true, orderId: rec.orderId, dryRun: true };
    }
    if (!tokenId) return { success: false, error: 'Token ID no disponible' };

    // ─── FILL_RETRY: retry-loop con ajuste de precio ─────────────────────
    // Evidencia (análisis de 277 NO_FILLs de julio): en el 100% de los casos
    // el precio de Polymarket se mantuvo constante durante los 60s de espera
    // — el problema es profundidad de libro, no velocidad. Reintentar al
    // MISMO precio no sirve; cada reintento debe mejorar el precio un tick.
    // Activar con FILL_RETRY=true. Solo aplica al camino GTC (no MARKET/FOK).
    const fillRetryEnabled = process.env.FILL_RETRY === 'true';
    const orderModePre = (config.ORDER_TYPE || 'GTC').toUpperCase();
    if (fillRetryEnabled && orderModePre !== 'MARKET') {
      return await this._placeGtcWithRetry({ rec, tokenId, side, price, size, marketEndTs });
    }

    try {
      await this._init();
      // GTC con timeout — pone orden límite en el book y espera hasta GTC_TIMEOUT_SECONDS
      const GTC_TIMEOUT_MS = (config.GTC_TIMEOUT_SECONDS || 60) * 1000;

      const orderMode = (config.ORDER_TYPE || 'GTC').toUpperCase();
      const isMarket = orderMode === 'MARKET';
      // MARKET_RETRY: si el FOK falla por falta de liquidez instantánea,
      // reintenta automáticamente como GTC con timeout corto — mejora
      // mucho el fill rate sin perder la velocidad del intento MARKET inicial.
      const marketRetryEnabled = process.env.MARKET_RETRY === 'true';

      const orderParams = {
        tokenID: tokenId, size,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
      };

      let result;

      if (isMarket) {
        // MARKET_RETRY_ATTEMPTS: cuántas veces intentar FOK antes de caer a GTC.
        // Cada intento fallido es prácticamente instantáneo (FOK no espera),
        // así que 3 intentos rápidos cuestan poco tiempo real pero mejoran
        // bastante la chance de encontrar liquidez en ese instante.
        const maxAttempts = parseInt(process.env.MARKET_RETRY_ATTEMPTS || '3');
        orderParams.orderType = OrderType.FOK;
        orderParams.price = price;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          logger.info(`[LIVE] 📈 MARKET order (FOK) intento ${attempt}/${maxAttempts}`);
          result = await this.clobClient.createAndPostOrder(orderParams);
          logger.info(`[LIVE] response (FOK intento ${attempt}): ${JSON.stringify(result)}`);

          const gotFilled = result?.success && (result?.status || '').toLowerCase() === 'matched';
          if (gotFilled) break; // fill instantáneo confirmado, no seguir intentando

          if (attempt < maxAttempts) {
            // Pequeña espera entre intentos para dar tiempo a que cambie el book
            await new Promise(r => setTimeout(r, 300));
          }
        }
      } else {
        // GTC — orden límite con tolerancia de precio
        orderParams.orderType = OrderType.GTC;
        orderParams.price = price;
        result = await this.clobClient.createAndPostOrder(orderParams);
        logger.info(`[LIVE] response: ${JSON.stringify(result)}`);
      }

      // MARKET_RETRY: si los N intentos de FOK fallaron, caer a GTC como red de seguridad
      const fokConfirmedMatch = result?.success && (result?.status || '').toLowerCase() === 'matched';
      if (!fokConfirmedMatch && isMarket && marketRetryEnabled) {
        logger.warn(`[LIVE] 🔁 FOK sin liquidez tras varios intentos — reintentando como GTC (timeout corto)`);
        const retryParams = { ...orderParams, orderType: OrderType.GTC };
        result = await this.clobClient.createAndPostOrder(retryParams);
        logger.info(`[LIVE] response (retry GTC): ${JSON.stringify(result)}`);
      }

      if (!result?.success) {
        const errMsg = result?.errorMsg || result?.error || 'Respuesta inesperada';
        logger.error(`[LIVE] ❌ ${errMsg}`);
        rec.status = 'REJECTED'; rec.error = errMsg;
        this._orderHistory.push(rec);
        return { success: false, error: errMsg };
      }

      const orderId = result?.orderID || result?.orderId || result?.id;
      let orderStatus = (result?.status || 'unknown').toLowerCase(); // normalizar
      rec.status = 'PLACED'; rec.orderId = orderId;
      this._orderHistory.push(rec);
      logger.info(`[LIVE] ✅ ${isMarket ? 'MARKET' : 'GTC'} Order ID: ${orderId} | status inicial: ${orderStatus}`);

      const orderPlacedAt = Date.now(); // para calcular fill_time_ms

      // Si ya llenó al instante → retornar con fill_time_ms
      if (orderStatus === 'matched') {
        const fillTimeMs = Date.now() - orderPlacedAt;
        logger.info(`[LIVE] ⚡ Fill instantáneo: ${fillTimeMs}ms`);
        return { success: true, orderId, status: 'matched', fillTimeMs };
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
            const rawStatus = orderData?.status || orderStatus;
            orderStatus = rawStatus.toLowerCase(); // normalizar a minúsculas
            const sizeFilled = orderData?.size_matched || orderData?.sizeFilled || 0;
            logger.info(`[LIVE] 🔄 Poll: status=${rawStatus} filled=${sizeFilled}/${size}`);

            if (orderStatus === 'matched') {
              const fillTimeMs = Date.now() - orderPlacedAt;
              logger.info(`[LIVE] ✅ Orden llenada (GTC poll) en ${fillTimeMs}ms`);
              return { success: true, orderId, status: 'matched', fillTimeMs };
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

  // ─── Retry-loop GTC con ajuste de precio ─────────────────────────────────
  // Reemplaza la espera única de 60s por intentos cortos con precio cada vez
  // un poco mejor. Config por env vars (todas con default razonable):
  //   FILL_RETRY=true                → activa este camino
  //   FILL_RETRY_ATTEMPT_SECONDS=15  → cuánto espera cada intento antes de
  //                                    cancelar y reintentar con mejor precio
  //   FILL_RETRY_PRICE_STEP=0.01     → cuánto mejora el precio por reintento
  //   FILL_RETRY_MAX_BUMP=0.03       → tope total de mejora (protege el edge:
  //                                    a +3 ticks el trade pierde su gracia)
  //   FILL_RETRY_CUTOFF_SECONDS=25   → no iniciar un intento nuevo si al
  //                                    mercado le quedan menos de esto
  async _placeGtcWithRetry({ rec, tokenId, side, price, size, marketEndTs }) {
    const ATTEMPT_MS  = parseInt(process.env.FILL_RETRY_ATTEMPT_SECONDS || '15') * 1000;
    const PRICE_STEP  = parseFloat(process.env.FILL_RETRY_PRICE_STEP || '0.01');
    const MAX_BUMP    = parseFloat(process.env.FILL_RETRY_MAX_BUMP || '0.03');
    const CUTOFF_MS   = parseInt(process.env.FILL_RETRY_CUTOFF_SECONDS || '25') * 1000;
    const POLL_MS     = 3000;

    // Presupuesto de tiempo: hasta el cutoff del mercado si lo conocemos,
    // si no, el GTC_TIMEOUT clásico como techo global.
    const globalDeadline = marketEndTs
      ? marketEndTs - CUTOFF_MS
      : Date.now() + (config.GTC_TIMEOUT_SECONDS || 60) * 1000;

    const isBuy = side === 'BUY';
    const startedAt = Date.now();
    let attempt = 0;
    let currentPrice = price;

    try {
      await this._init();

      while (Date.now() < globalDeadline) {
        attempt++;
        const remainingMs = globalDeadline - Date.now();
        const attemptDeadline = Math.min(Date.now() + ATTEMPT_MS, globalDeadline);
        logger.info(`[RETRY] intento ${attempt} @ $${currentPrice.toFixed(3)} | presupuesto restante: ${Math.floor(remainingMs/1000)}s`);

        const orderParams = {
          tokenID: tokenId, size,
          side: isBuy ? Side.BUY : Side.SELL,
          orderType: OrderType.GTC,
          price: currentPrice,
        };

        let result;
        try {
          result = await this.clobClient.createAndPostOrder(orderParams);
        } catch (e) {
          logger.warn(`[RETRY] error al postear intento ${attempt}: ${e.message}`);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }

        if (!result?.success) {
          logger.warn(`[RETRY] intento ${attempt} rechazado: ${result?.errorMsg || result?.error || 'sin detalle'}`);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }

        const orderId = result?.orderID || result?.orderId || result?.id;
        let orderStatus = (result?.status || 'unknown').toLowerCase();

        if (orderStatus === 'matched') {
          const fillTimeMs = Date.now() - startedAt;
          rec.status = 'PLACED'; rec.orderId = orderId; rec.fillAttempts = attempt;
          rec.fillPrice = currentPrice;
          this._orderHistory.push(rec);
          logger.info(`[RETRY] ✅ Fill instantáneo en intento ${attempt} @ $${currentPrice.toFixed(3)} (${fillTimeMs}ms total)`);
          return { success: true, orderId, status: 'matched', fillTimeMs, attempts: attempt, fillPrice: currentPrice };
        }

        // En el book — poll corto hasta el deadline del intento
        while (Date.now() < attemptDeadline) {
          await new Promise(r => setTimeout(r, POLL_MS));
          try {
            const orderData = await this.clobClient.getOrder(orderId);
            orderStatus = (orderData?.status || orderStatus).toLowerCase();
            if (orderStatus === 'matched') {
              const fillTimeMs = Date.now() - startedAt;
              rec.status = 'PLACED'; rec.orderId = orderId; rec.fillAttempts = attempt;
              rec.fillPrice = currentPrice;
              this._orderHistory.push(rec);
              logger.info(`[RETRY] ✅ Fill en intento ${attempt} @ $${currentPrice.toFixed(3)} (${fillTimeMs}ms total)`);
              return { success: true, orderId, status: 'matched', fillTimeMs, attempts: attempt, fillPrice: currentPrice };
            }
            if (orderStatus === 'cancelled' || orderStatus === 'canceled') break;
          } catch (pollErr) {
            logger.warn(`[RETRY] poll error: ${pollErr.message}`);
          }
        }

        // No llenó en este intento — cancelar antes de reintentar (crítico:
        // nunca dejar dos órdenes vivas al mismo tiempo)
        if (orderStatus !== 'matched' && orderStatus !== 'cancelled' && orderStatus !== 'canceled') {
          try {
            await this.clobClient.cancelOrder({ orderId });
            logger.info(`[RETRY] 🚫 intento ${attempt} cancelado (sin fill en ${ATTEMPT_MS/1000}s)`);
          } catch (cancelErr) {
            logger.error(`[RETRY] error cancelando intento ${attempt}: ${cancelErr.message}`);
            // Si no pudimos confirmar la cancelación, NO reintentar con otra
            // orden — riesgo de doble posición. Cortamos acá.
            rec.status = 'FAILED'; rec.error = 'cancel_failed';
            this._orderHistory.push(rec);
            return { success: false, error: 'cancel_failed', orderId, attempts: attempt };
          }
          // Verificación post-cancel: si justo llenó entre el poll y el cancel,
          // el cancel falla o el estado queda matched — chequear una vez más.
          try {
            const finalCheck = await this.clobClient.getOrder(orderId);
            if ((finalCheck?.status || '').toLowerCase() === 'matched') {
              const fillTimeMs = Date.now() - startedAt;
              rec.status = 'PLACED'; rec.orderId = orderId; rec.fillAttempts = attempt;
              rec.fillPrice = currentPrice;
              this._orderHistory.push(rec);
              logger.info(`[RETRY] ✅ Fill detectado post-cancel en intento ${attempt} @ $${currentPrice.toFixed(3)}`);
              return { success: true, orderId, status: 'matched', fillTimeMs, attempts: attempt, fillPrice: currentPrice };
            }
          } catch (e) { /* orden cancelada, seguir */ }
        }

        // Mejorar precio para el próximo intento, respetando el tope
        const bumped = isBuy ? currentPrice + PRICE_STEP : currentPrice - PRICE_STEP;
        const maxPrice = price + MAX_BUMP;
        const minPrice = price - MAX_BUMP;
        const capped = isBuy ? Math.min(bumped, maxPrice, 0.97) : Math.max(bumped, minPrice, 0.03);
        if (capped === currentPrice) {
          logger.warn(`[RETRY] tope de precio alcanzado ($${currentPrice.toFixed(3)}) — no hay más margen de mejora, esperando con este precio`);
        }
        currentPrice = parseFloat(capped.toFixed(3));
      }

      logger.warn(`[RETRY] ⏱️ Presupuesto agotado tras ${attempt} intento(s) — NO_FILL definitivo`);
      rec.status = 'REJECTED'; rec.error = 'retry_budget_exhausted'; rec.fillAttempts = attempt;
      this._orderHistory.push(rec);
      return { success: false, error: 'gtc_timeout', attempts: attempt };

    } catch (err) {
      rec.status = 'FAILED'; rec.error = err.message;
      this._orderHistory.push(rec);
      logger.error(`[RETRY] Error fatal: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

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
