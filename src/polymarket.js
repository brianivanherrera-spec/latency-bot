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

  /**
   * Obtiene la profundidad completa del book via HTTP para un par YES/NO.
   * Usado como fallback cuando el WS no tiene el snapshot todavía.
   */
  async fetchBookDepth(yesTokenId, noTokenId) {
    try {
      await this._init();
      const [yesBook, noBook] = await Promise.all([
        this.clobClient.getOrderBook(yesTokenId).catch(() => null),
        this.clobClient.getOrderBook(noTokenId).catch(() => null),
      ]);
      const parseSize = (l) => parseFloat(l?.size ?? l?.amount ?? 0) || 0;
      const yesBid = (yesBook?.bids || []).reduce((s,l) => s+parseSize(l), 0);
      const yesAsk = (yesBook?.asks || []).reduce((s,l) => s+parseSize(l), 0);
      const noBid  = (noBook?.bids  || []).reduce((s,l) => s+parseSize(l), 0);
      const noAsk  = (noBook?.asks  || []).reduce((s,l) => s+parseSize(l), 0);
      return { yesBid: parseFloat(yesBid.toFixed(2)), yesAsk: parseFloat(yesAsk.toFixed(2)),
               noBid: parseFloat(noBid.toFixed(2)),   noAsk: parseFloat(noAsk.toFixed(2)) };
    } catch (e) {
      logger.warn(`[BOOK] fetchBookDepth falló: ${e.message}`);
      return null;
    }
  }

  /**
   * Best ask del book (para cruzar spread en MARKET/FAK).
   * Devuelve null si no hay book.
   */
  async _getBestAsk(tokenId) {
    try {
      const book = await this.clobClient.getOrderBook(tokenId);
      const asks = book?.asks || [];
      if (!asks.length) return null;
      // Polymarket book: asks suelen venir ordenados; tomar el más bajo
      let best = Infinity;
      for (const a of asks) {
        const px = parseFloat(a.price);
        if (!isNaN(px) && px > 0 && px < best) best = px;
      }
      return best === Infinity ? null : best;
    } catch (e) {
      logger.warn(`[BOOK] getOrderBook falló: ${e.message}`);
      return null;
    }
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
      // ORDER_SPLIT: partir en pedazos más chicos en vez de un solo pedido
      // grande — muchas veces el libro absorbe cantidades chicas aunque no
      // alcance para el total de una. Si el tamaño no alcanza para respetar
      // el mínimo de Polymarket (5 tokens) por pedazo, cae solo a una orden.
      if (process.env.ORDER_SPLIT === 'true') {
        return await this._placeSplitOrders({ rec, tokenId, side, price, size, marketEndTs });
      }
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
        // FAK (Fill And Kill) en vez de FOK (Fill Or Kill):
        // FOK = todo o nada → si no hay suficiente liquidez para el size completo,
        //       la orden muere entera aunque haya 3 de 5 tokens disponibles.
        // FAK = llena lo que haya y cancela el resto → con el tracker de fills
        //       parciales que ya tenemos, 3 de 5 tokens llenados es útil: el
        //       retry-loop pide los 2 restantes. Mismo comportamiento desde
        //       la API pero con más fills aprovechables en libros delgados.
        // Confirmado disponible en clob-client-v2 v1.0.6: OrderType.FAK
        //
        // USE_FAK=true  → activa FAK (default: false para no cambiar comportamiento
        //                  sin validación explícita; activar en Railway cuando listo)
        const useFak = process.env.USE_FAK === 'true';
        const firstOrderType = useFak ? OrderType.FAK : OrderType.FOK;
        const maxAttempts = parseInt(process.env.MARKET_RETRY_ATTEMPTS || '3');
        orderParams.orderType = firstOrderType;

        // Cruzar el spread: precio = max(precio señal, bestAsk + 1 tick),
        // topeado por MAX_BUMP para no regalar el edge.
        const maxBump = parseFloat(process.env.FILL_RETRY_MAX_BUMP || process.env.PRICE_TOLERANCE || '0.05');
        const tick = 0.01;
        const crossBook = async (basePrice) => {
          const ask = await this._getBestAsk(tokenId);
          if (ask == null) return basePrice;
          const cross = parseFloat((ask + tick).toFixed(3));
          const capped = parseFloat(Math.min(basePrice + maxBump, Math.max(basePrice, cross)).toFixed(3));
          // Nunca pagar > 0.99 en token binario
          const finalPx = Math.min(0.99, capped);
          if (finalPx !== basePrice) {
            logger.info(`[LIVE] 📊 Book ask=$${ask.toFixed(3)} → precio cruzado $${finalPx.toFixed(3)} (base $${basePrice.toFixed(3)}, bump max $${maxBump})`);
          }
          return finalPx;
        };
        orderParams.price = await crossBook(price);

        let preFilledFromFak = 0;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const orderLabel = useFak ? 'FAK' : 'FOK';
          // En reintentos, refrescar book (el ask puede haber subido)
          if (attempt > 1) {
            orderParams.price = await crossBook(price);
          }
          logger.info(`[LIVE] 📈 MARKET order (${orderLabel}) intento ${attempt}/${maxAttempts} @ $${orderParams.price}`);
          result = await this.clobClient.createAndPostOrder(orderParams);
          logger.info(`[LIVE] response (${orderLabel} intento ${attempt}): ${JSON.stringify(result)}`);

          const rawStatus = (result?.status || '').toLowerCase();
          const gotFilled = result?.success && rawStatus === 'matched';

          // FAK puede devolver fill parcial: filled < size pero > 0
          if (useFak && result?.success) {
            const rawStatusFak = (result?.status || '').toLowerCase();
            // Si status=matched, llenó el pedido completo de este intento
            if (rawStatusFak === 'matched') {
              preFilledFromFak += orderParams.size;
              break;
            }
            // Fix #2: no usar 'remaining' como fallback — puede contar de más.
            // Solo confiar en size_matched / sizeFilled si vienen explícitamente.
            const fakFilled = parseFloat(result?.size_matched || result?.sizeFilled || 0) || 0;
            if (fakFilled > 0 && fakFilled < orderParams.size) {
              preFilledFromFak += fakFilled;
              const newRemaining = parseFloat((orderParams.size - fakFilled).toFixed(6));
              logger.info(`[LIVE] 🔶 FAK fill parcial: ${fakFilled} tokens — quedan ${newRemaining} por llenar`);
              // Fix #1: si el remanente es < mínimo de Polymarket (5 tokens),
              // aceptar lo ya llenado y salir en vez de mandar una orden inválida
              if (newRemaining < 5) {
                logger.info(`[LIVE] 🔶 Remanente ${newRemaining} < 5 tokens (mínimo Polymarket) — aceptando fill parcial de ${preFilledFromFak} tokens`);
                break;
              }
              orderParams.size = newRemaining;
              continue; // reintentar por el remanente válido
            }
          }

          if (gotFilled) break;
          if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 300));
        }

        // Si FAK llenó algo parcialmente, guardar para sumarlo al resultado final
        if (preFilledFromFak > 0 && result) {
          result._preFilledFromFak = preFilledFromFak;
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
        // FIX CRÍTICO (detectado en el primer log de live, 03/08): un FOK que
        // no llena instantáneo puede volver con status "live" — es decir,
        // Polymarket lo dejó viva en el libro en vez de matarla. Si no la
        // cancelamos acá, el retry-loop de abajo abre una SEGUNDA orden
        // independiente y quedan dos órdenes vivas al mismo tiempo (doble
        // exposición real). Cancelar siempre antes de seguir.
        const staleOrderId = result?.orderID || result?.orderId || result?.id;
        const staleStatus = (result?.status || '').toLowerCase();
        let preFilledSize = 0; // FIX: si el FOK "muerto" ya llenó parcialmente, no lo perdemos
        if (staleOrderId && staleStatus !== 'matched' && staleStatus !== 'cancelled' && staleStatus !== 'canceled') {
          logger.warn(`[LIVE] ⚠️ FOK quedó con estado "${staleStatus}" (no killed) — cancelando orden ${staleOrderId} antes de reintentar`);
          try {
            await this.clobClient.cancelOrder({ orderId: staleOrderId });
            // Verificar que no se haya llenado (total o parcial) en el instante entre el check y el cancel
            const check = await this.clobClient.getOrder(staleOrderId).catch(() => null);
            if ((check?.status || '').toLowerCase() === 'matched') {
              logger.info(`[LIVE] ✅ La orden FOK "muerta" en realidad ya había llenado — usando ese fill, no se abre una segunda`);
              const fillTimeMs = Date.now() - (rec._placedAt || Date.now());
              rec.status = 'PLACED'; rec.orderId = staleOrderId; rec.sizeFilled = size;
              this._orderHistory.push(rec);
              return { success: true, orderId: staleOrderId, status: 'matched', fillTimeMs, sizeFilled: size };
            }
            preFilledSize = parseFloat(check?.size_matched || check?.sizeFilled || 0) || 0;
            if (preFilledSize > 0) {
              logger.info(`[LIVE] 🔶 La orden FOK residual ya había llenado ${preFilledSize} tokens antes de cancelarse — se descuentan del próximo pedido`);
            }
            logger.info(`[LIVE] 🚫 Orden FOK residual ${staleOrderId} cancelada correctamente`);
          } catch (cancelErr) {
            logger.error(`[LIVE] ❌ No se pudo cancelar la orden FOK residual ${staleOrderId}: ${cancelErr.message} — ABORTANDO reintento para no duplicar exposición`);
            rec.status = 'FAILED'; rec.error = 'stale_fok_cancel_failed';
            this._orderHistory.push(rec);
            return { success: false, error: 'stale_fok_cancel_failed', orderId: staleOrderId };
          }
        }

        // Con FILL_RETRY activo, el fallback ya no es una sola orden GTC de
        // 60s quieta — es el retry-loop completo con mejora de precio, que
        // según los datos de NO_FILL es lo único que destraba el fill cuando
        // el libro no tiene contraparte al precio inicial.
        if (process.env.FILL_RETRY === 'true') {
          logger.warn(`[LIVE] 🔁 FAK/FOK sin liquidez suficiente — activando retry-loop GTC con mejora de precio`);
          const preFilledFromFak = result?._preFilledFromFak || 0;
          const remainingAfterFak = size - preFilledSize - preFilledFromFak;

          // Fix #1: si el remanente es < 5 tokens (mínimo Polymarket), no
          // podemos mandarlo al retry-loop — devolver success parcial con lo
          // ya llenado en vez de reportar fallo o quedar en limbo.
          if (remainingAfterFak > 0 && remainingAfterFak < 5 && (preFilledSize + preFilledFromFak) > 0) {
            const totalFilled = preFilledSize + preFilledFromFak;
            logger.info(`[LIVE] 🔶 Remanente ${remainingAfterFak} < 5 tokens — devolviendo fill parcial de ${totalFilled}/${size}`);
            rec.status = 'PARTIAL'; rec.sizeFilled = totalFilled;
            this._orderHistory.push(rec);
            return { success: true, partial: true, sizeFilled: totalFilled, requestedSize: size };
          }

          const retryResult = process.env.ORDER_SPLIT === 'true'
            ? await this._placeSplitOrders({ rec, tokenId, side, price, size: remainingAfterFak, marketEndTs })
            : await this._placeGtcWithRetry({ rec, tokenId, side, price, size: remainingAfterFak, marketEndTs });
          // Sumar lo ya llenado (FOK/FAK residual + fill parcial FAK) al resultado
          const totalPreFilled = preFilledSize + preFilledFromFak;
          if (totalPreFilled > 0 && retryResult) {
            retryResult.sizeFilled = (retryResult.sizeFilled || 0) + totalPreFilled;
            retryResult.success = retryResult.success || totalPreFilled > 0;
            retryResult.partial = retryResult.partial || (retryResult.sizeFilled < size);
          }
          return retryResult;
        }
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

  // Consulta el precio mid actual de un token específico en el book de Polymarket.
  // Usado por el position monitor para saber en qué precio cerrar una posición.
  // Devuelve null si no puede obtener el precio.
  async getTokenMidPrice(tokenId) {
    try {
      await this._init();
      const book = await this.clobClient.getOrderBook(tokenId);
      if (!book) return null;
      const bestBid = parseFloat(book.bids?.[0]?.price || 0);
      const bestAsk = parseFloat(book.asks?.[0]?.price || 1);
      if (!bestBid && !bestAsk) return null;
      // mid price — si no hay bid, usar ask; si no hay ask, usar bid
      if (!bestBid) return bestAsk;
      if (!bestAsk) return bestBid;
      return parseFloat(((bestBid + bestAsk) / 2).toFixed(4));
    } catch (e) {
      logger.warn(`[POLY] getTokenMidPrice error para ${tokenId?.slice(0,16)}...: ${e.message}`);
      return null;
    }
  }

  // Vende tokens de vuelta al mercado (para el SL/TP del position monitor).
  // Para una posición BUY de YES tokens: vendemos YES al mejor bid disponible.
  // Para una posición SELL de NO tokens: recompramos NO al mejor ask disponible.
  async sellPosition({ tokenId, size, side, posId }) {
    try {
      await this._init();
      const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
      const book = await this.clobClient.getOrderBook(tokenId);
      let exitPrice;
      if (exitSide === 'SELL') {
        exitPrice = parseFloat(book?.bids?.[0]?.price || 0);
      } else {
        exitPrice = parseFloat(book?.asks?.[0]?.price || 1);
      }
      if (!exitPrice) return { success: false, error: 'sin liquidez para salir' };

      logger.info(`[POSITION-MONITOR] 🚪 Cerrando ${posId} — ${exitSide} ${size}t @ $${exitPrice.toFixed(3)}`);
      const orderParams = {
        tokenID: tokenId,
        size,
        side: exitSide === 'BUY' ? Side.BUY : Side.SELL,
        // FAK (Fill And Kill) en vez de FOK: llena lo que haya en el book
        // y cancela el resto. Con FOK si no hay tamaño exacto la orden muere
        // y la posición queda abierta hasta resolución — peor que un cierre parcial.
        orderType: OrderType.FAK,
        price: exitPrice,
      };
      const result = await this.clobClient.createAndPostOrder(orderParams);
      const ok = result?.success && (result?.status || '').toLowerCase() === 'matched';
      if (ok) {
        logger.info(`[POSITION-MONITOR] ✅ Posición ${posId} cerrada @ $${exitPrice.toFixed(3)}`);
      } else {
        logger.warn(`[POSITION-MONITOR] ⚠️ No se pudo cerrar ${posId}: ${result?.errorMsg || 'sin fill'}`);
      }
      return { success: ok, price: exitPrice, result };
    } catch (e) {
      logger.error(`[POSITION-MONITOR] Error cerrando ${posId}: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

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
  //   FILL_RETRY_MAX_TOTAL_SECONDS=60 → tope ABSOLUTO de tiempo total de
  //                                    reintento, sin importar cuánto falte
  //                                    para el cierre. Evidencia (04/08):
  //                                    los 4 fills que tardaron 90-199s
  //                                    perdieron los 4 — entrar así de tarde
  //                                    con precio ya movido pierde plata de
  //                                    forma sistemática, no es solo peor
  //                                    precio, es una señal efectivamente
  //                                    vencida.
  // ─── Partir la orden en pedazos más chicos ───────────────────────────────
  // En vez de una sola orden grande, manda ORDER_SPLIT_PIECES pedazos en
  // paralelo (cada uno con su propio retry-loop de mejora de precio). La
  // idea: el libro a veces tiene profundidad para absorber pedidos chicos
  // aunque no alcance para uno grande de una sola vez.
  //   ORDER_SPLIT=true              → activa esto (además de FILL_RETRY=true)
  //   ORDER_SPLIT_PIECES=2          → en cuántos pedazos partir
  // Respeta el mínimo de Polymarket (5 tokens por orden): si el tamaño total
  // no alcanza para partir sin violarlo, cae a una sola orden entera.
  async _placeSplitOrders({ rec, tokenId, side, price, size, marketEndTs }) {
    const MIN_ORDER_SIZE = 5; // mínimo de Polymarket
    const pieces = Math.max(2, parseInt(process.env.ORDER_SPLIT_PIECES || '2'));

    if (size < MIN_ORDER_SIZE * pieces) {
      logger.info(`[SPLIT] Tamaño ${size} no alcanza para ${pieces} pedazos de ${MIN_ORDER_SIZE}+ — mandando entera`);
      return await this._placeGtcWithRetry({ rec, tokenId, side, price, size, marketEndTs });
    }

    const base = Math.floor(size / pieces);
    const sizes = Array(pieces).fill(base);
    sizes[pieces - 1] += parseFloat((size - base * pieces).toFixed(6)); // resto al último pedazo

    logger.info(`[SPLIT] Partiendo orden de ${size} en ${pieces} pedazos: ${sizes.join(' + ')}`);

    const results = await Promise.all(
      sizes.map(s => this._placeGtcWithRetry({ rec: { ...rec }, tokenId, side, price, size: s, marketEndTs }))
    );

    let totalFilled = 0, weightedPriceSum = 0;
    for (const r of results) {
      const filled = r.sizeFilled || 0;
      totalFilled += filled;
      weightedPriceSum += filled * (r.fillPrice || price);
    }
    const avgPrice = totalFilled > 0 ? weightedPriceSum / totalFilled : price;
    const anyFilled = totalFilled > 0;

    logger.info(`[SPLIT] Resultado: ${totalFilled}/${size} llenados (precio promedio $${avgPrice.toFixed(3)})`);

    return {
      success: anyFilled,
      partial: anyFilled && totalFilled < size,
      sizeFilled: totalFilled,
      fillPrice: avgPrice,
      attempts: Math.max(...results.map(r => r.attempts || 0)),
    };
  }

  async _placeGtcWithRetry({ rec, tokenId, side, price, size, marketEndTs }) {
    const ATTEMPT_MS  = parseInt(process.env.FILL_RETRY_ATTEMPT_SECONDS || '15') * 1000;
    const PRICE_STEP  = parseFloat(process.env.FILL_RETRY_PRICE_STEP || '0.01');
    const MAX_BUMP    = parseFloat(process.env.FILL_RETRY_MAX_BUMP || '0.03');
    const CUTOFF_MS   = parseInt(process.env.FILL_RETRY_CUTOFF_SECONDS || '25') * 1000;
    const MAX_TOTAL_MS = parseInt(process.env.FILL_RETRY_MAX_TOTAL_SECONDS || '60') * 1000;
    const POLL_MS     = 3000;

    const startedAt = Date.now();

    // Presupuesto de tiempo: el menor entre (a) el cutoff del mercado, y
    // (b) el tope absoluto desde que arrancó este intento de entrada —
    // lo que se cumpla primero corta el retry-loop.
    const marketDeadline = marketEndTs
      ? marketEndTs - CUTOFF_MS
      : startedAt + (config.GTC_TIMEOUT_SECONDS || 60) * 1000;
    const absoluteDeadline = startedAt + MAX_TOTAL_MS;
    const globalDeadline = Math.min(marketDeadline, absoluteDeadline);

    const isBuy = side === 'BUY';
    let attempt = 0;
    let currentPrice = price;
    let filledSoFar = 0;      // FIX: tokens ya confirmados llenados en intentos previos
    let remainingSize = size; // lo que falta pedir — nunca el tamaño original completo

    try {
      await this._init();

      while (Date.now() < globalDeadline && remainingSize > 0) {
        attempt++;
        const remainingMs = globalDeadline - Date.now();
        const attemptDeadline = Math.min(Date.now() + ATTEMPT_MS, globalDeadline);
        logger.info(`[RETRY] intento ${attempt} @ $${currentPrice.toFixed(3)} | pidiendo ${remainingSize}/${size} (${filledSoFar} ya llenados) | presupuesto restante: ${Math.floor(remainingMs/1000)}s`);

        const orderParams = {
          tokenID: tokenId, size: remainingSize,
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
          filledSoFar += remainingSize; // esta orden llenó completa
          const fillTimeMs = Date.now() - startedAt;
          rec.status = 'PLACED'; rec.orderId = orderId; rec.fillAttempts = attempt;
          rec.fillPrice = currentPrice; rec.sizeFilled = filledSoFar;
          this._orderHistory.push(rec);
          logger.info(`[RETRY] ✅ Fill instantáneo en intento ${attempt} @ $${currentPrice.toFixed(3)} — ${filledSoFar}/${size} (${fillTimeMs}ms total)`);
          return { success: true, orderId, status: 'matched', fillTimeMs, attempts: attempt, fillPrice: currentPrice, sizeFilled: filledSoFar };
        }

        // En el book — poll corto hasta el deadline del intento
        let thisOrderFilled = 0;
        while (Date.now() < attemptDeadline) {
          await new Promise(r => setTimeout(r, POLL_MS));
          try {
            const orderData = await this.clobClient.getOrder(orderId);
            orderStatus = (orderData?.status || orderStatus).toLowerCase();
            thisOrderFilled = parseFloat(orderData?.size_matched || orderData?.sizeFilled || 0) || 0;
            if (thisOrderFilled > 0 && thisOrderFilled < remainingSize) {
              logger.info(`[RETRY] 🔶 Fill parcial detectado: ${thisOrderFilled}/${remainingSize} en esta orden — se sigue esperando el resto`);
            }
            if (orderStatus === 'matched') {
              filledSoFar += remainingSize; // llenó el total pedido en esta orden
              const fillTimeMs = Date.now() - startedAt;
              rec.status = 'PLACED'; rec.orderId = orderId; rec.fillAttempts = attempt;
              rec.fillPrice = currentPrice; rec.sizeFilled = filledSoFar;
              this._orderHistory.push(rec);
              logger.info(`[RETRY] ✅ Fill en intento ${attempt} @ $${currentPrice.toFixed(3)} — ${filledSoFar}/${size} (${fillTimeMs}ms total)`);
              return { success: true, orderId, status: 'matched', fillTimeMs, attempts: attempt, fillPrice: currentPrice, sizeFilled: filledSoFar };
            }
            if (orderStatus === 'cancelled' || orderStatus === 'canceled') break;
          } catch (pollErr) {
            logger.warn(`[RETRY] poll error: ${pollErr.message}`);
          }
        }

        // No llenó del todo en este intento — cancelar el remanente antes de
        // reintentar (crítico: nunca dejar dos órdenes vivas al mismo tiempo)
        if (orderStatus !== 'matched' && orderStatus !== 'cancelled' && orderStatus !== 'canceled') {
          try {
            await this.clobClient.cancelOrder({ orderId });
            logger.info(`[RETRY] 🚫 intento ${attempt} cancelado (sin fill completo en ${ATTEMPT_MS/1000}s)`);
          } catch (cancelErr) {
            logger.error(`[RETRY] error cancelando intento ${attempt}: ${cancelErr.message}`);
            // Si no pudimos confirmar la cancelación, NO reintentar con otra
            // orden — riesgo de doble posición. Cortamos acá, pero si ya
            // sabemos que hay fill parcial confirmado, lo reportamos igual.
            rec.status = 'FAILED'; rec.error = 'cancel_failed'; rec.sizeFilled = filledSoFar + thisOrderFilled;
            this._orderHistory.push(rec);
            return { success: filledSoFar + thisOrderFilled > 0, orderId, attempts: attempt,
              error: 'cancel_failed', sizeFilled: filledSoFar + thisOrderFilled, partial: true };
          }
          // Verificación post-cancel: si justo llenó (total o parcial) entre
          // el poll y el cancel, leer el estado final antes de seguir.
          try {
            const finalCheck = await this.clobClient.getOrder(orderId);
            const finalStatus = (finalCheck?.status || '').toLowerCase();
            const finalFilled = parseFloat(finalCheck?.size_matched || finalCheck?.sizeFilled || 0) || 0;
            if (finalStatus === 'matched') {
              filledSoFar += remainingSize;
              const fillTimeMs = Date.now() - startedAt;
              rec.status = 'PLACED'; rec.orderId = orderId; rec.fillAttempts = attempt;
              rec.fillPrice = currentPrice; rec.sizeFilled = filledSoFar;
              this._orderHistory.push(rec);
              logger.info(`[RETRY] ✅ Fill detectado post-cancel en intento ${attempt} @ $${currentPrice.toFixed(3)} — ${filledSoFar}/${size}`);
              return { success: true, orderId, status: 'matched', fillTimeMs, attempts: attempt, fillPrice: currentPrice, sizeFilled: filledSoFar };
            }
            if (finalFilled > 0) {
              // FIX CENTRAL: la cancelación solo mata el remanente — lo ya
              // llenado queda en la wallet. Sumarlo y descontarlo de lo que
              // se pide en el próximo intento, para no terminar pidiendo el
              // tamaño completo de nuevo y duplicar exposición.
              filledSoFar += finalFilled;
              remainingSize = parseFloat((remainingSize - finalFilled).toFixed(6));
              logger.info(`[RETRY] 🔶 Confirmado fill parcial de ${finalFilled} antes del cancel — acumulado ${filledSoFar}/${size}, quedan ${remainingSize} por pedir`);
            }
          } catch (e) { /* orden ya no existe / cancelada limpia, seguir */ }
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

      if (filledSoFar > 0) {
        logger.warn(`[RETRY] ⏱️ Presupuesto agotado tras ${attempt} intento(s) — fill PARCIAL: ${filledSoFar}/${size} tokens`);
        rec.status = 'PARTIAL'; rec.fillAttempts = attempt; rec.sizeFilled = filledSoFar;
        this._orderHistory.push(rec);
        return { success: true, partial: true, sizeFilled: filledSoFar, requestedSize: size, attempts: attempt };
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
