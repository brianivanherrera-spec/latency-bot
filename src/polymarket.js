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
// Timeouts HTTP: un request colgado dejaba el slot tomado. fetch propios (Gamma, libro,
// saldo): 3 s. El cliente CLOB usa axios sin timeout: se fija uno global más largo
// (CLOB_HTTP_TIMEOUT_MS, default 10 s) porque cortar un POST de orden que sí se ejecutó
// dejaría el estado de la orden desconocido.
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '3000');
try { require('axios').defaults.timeout = parseInt(process.env.CLOB_HTTP_TIMEOUT_MS || '10000'); } catch (_) {}
// tickSize/negRisk de los mercados BTC Up/Down 5m. Pasarlos siempre evita que el cliente los
// consulte por red antes de cada orden. (El tipo de orden va como 3er argumento de
// createAndPost*: dentro del objeto la librería lo ignora y la orden sale GTC.)
const ORDER_OPTS = { tickSize: process.env.TICK_SIZE || '0.01', negRisk: process.env.NEG_RISK === 'true' };
// Estados finales de una orden (live/delayed todavía pueden llenar)
const FINAL_STATUSES = new Set(['matched', 'canceled', 'cancelled', 'unmatched', 'expired']);
const r2 = (v) => parseFloat((Math.round(v * 100) / 100).toFixed(2));

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
    this._polyWs = null; // referencia al WS para obtener bestAsk en tiempo real
    // Acciones propias por token (suma de fills de esta sesión + posiciones restauradas):
    // sirve para saber cuánto de un saldo de token viene de la orden en curso
    this._heldShares = new Map();
  }

  // Registrar acciones ya en poder (posiciones restauradas al arrancar)
  noteHeldShares(tokenId, shares) {
    if (!tokenId || !(shares > 0)) return;
    this._heldShares.set(tokenId, (this._heldShares.get(tokenId) || 0) + shares);
  }

  // getOrder sin lanzar: null si falló (la librería devuelve { error } en vez de lanzar)
  async _getOrderSafe(orderId) {
    try {
      const o = await this.clobClient.getOrder(orderId);
      return (!o || o.error) ? null : o;
    } catch (_) { return null; }
  }

  // Sigue una orden hasta un estado final o el timeout. matched = último size_matched
  // conocido (una consulta fallida no lo vuelve a 0).
  async _waitOrderFinal(orderId, timeoutMs, pollMs = 300) {
    const until = Date.now() + timeoutMs;
    let status = null, matched = 0;
    while (true) {
      const o = await this._getOrderSafe(orderId);
      if (o) {
        status = String(o.status || '').toLowerCase();
        const m = parseFloat(o.size_matched || 0);
        if (m > matched) matched = m;
        if (FINAL_STATUSES.has(status)) return { final: true, status, matched, order: o };
      }
      if (Date.now() >= until) return { final: false, status, matched };
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  // Cancelación verificada. cancelOrder no lanza: devuelve { error } o
  // { canceled: [ids], not_canceled: { id: motivo } }. Solo es OK si no hay error y el id
  // está en canceled, o si la orden ya estaba en un estado final (matched/canceled).
  async _cancelChecked(orderId) {
    let res;
    try { res = await this.clobClient.cancelOrder({ orderID: orderId }); }
    catch (e) { res = { error: e.message }; }
    const canceled = Array.isArray(res?.canceled) ? res.canceled : [];
    if (!res?.error && canceled.includes(orderId)) return { ok: true, res };
    const fin = await this._getOrderSafe(orderId);
    const st = String(fin?.status || '').toLowerCase();
    if (fin && FINAL_STATUSES.has(st)) return { ok: true, res, finalStatus: st, matched: parseFloat(fin.size_matched || 0) || 0 };
    const why = res?.error ? JSON.stringify(res.error).slice(0, 120) : (res?.not_canceled?.[orderId] || 'orderID ausente en canceled');
    return { ok: false, res, error: why };
  }

  // Saldo del token (acciones) de la deposit wallet; null si no se pudo leer
  async _tokenBalance(tokenId) {
    try {
      await this.clobClient.updateBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId }).catch(() => null);
      const r = await this.clobClient.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId });
      if (!r || r.error || r.balance === undefined) return null;
      return parseFloat(r.balance) / 1e6;
    } catch (_) { return null; }
  }

  // Conectar el WS para obtener bestAsk sin REST call (~0ms latencia)
  setPolyWs(polyWs) {
    this._polyWs = polyWs;
    logger.info('[POLYMARKET] ✅ WS conectado para bestAsk en tiempo real');
  }

  async _init() {
    if (this._initialized) return;
    if (config.DRY_RUN) {
      logger.info('DRY RUN');
      // Crear cliente de solo lectura para DRY_RUN — permite getSpread, getTrades, etc.
      // sin necesitar credenciales de trading
      if (HAS_CLOB_V2 && !this.clobClient) {
        try {
          this.clobClient = new ClobClient({
            host:  CLOB_API_BASE,
            chain: Chain?.POLYGON ?? 137,
            useServerTime: false,
          });
          logger.info('[DRY_RUN] CLOB client de solo lectura inicializado');
        } catch (e) {
          logger.warn(`[DRY_RUN] CLOB client no disponible: ${e.message}`);
        }
      }
      this._initialized = true;
      return;
    }

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
      const tempClient = new ClobClient({ host: CLOB_API_BASE, chain: Chain?.POLYGON ?? 137, signer: walletClient, useServerTime: false });
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
      // Con true, cada orden/consulta hacía antes un GET /time extra
      useServerTime: false,
    });

    // Paso 4: Actualizar balance cache (CRÍTICO — docs oficiales)
    try {
      logger.info('Actualizando balance cache para deposit wallet...');
      await this.clobClient.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
      logger.info('✓ Balance cache actualizado');
    } catch (e) {
      // Intentar via fetch directo si el SDK no tiene el método
      try {
        const res = await fetch(`${CLOB_API_BASE}/balance-allowance/update?asset_type=COLLATERAL&signature_type=3`, {
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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
      const response = await fetch(`${GAMMA_API_BASE}/events?slug=${slug}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
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
      const response = await fetch(`${GAMMA_API_BASE}/events?slug=${slug}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
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

    let yesTokenId = tokens[0] || null;
    let noTokenId = tokens[1] || null;

    if (tokens.length >= 2 && m.outcomes && Array.isArray(m.outcomes)) {
      for (let i = 0; i < m.outcomes.length; i++) {
        const outcome = (m.outcomes[i] || '').toLowerCase();
        if (outcome.includes('yes')) {
          yesTokenId = tokens[i];
        } else if (outcome.includes('no')) {
          noTokenId = tokens[i];
        }
      }
    }

    // CÓMO POLYMARKET FIJA LOS PRECIOS INICIALES DE MERCADOS BINARIOS:
    // ═════════════════════════════════════════════════════════════════
    //
    // 1. MERCADOS CON STRIKE EXPLÍCITO (ej: "Will BTC be above $78,325?")
    //    → Polymarket fija precio inicial en función de probabilidades
    //    → Extraemos el strike price de la descripción
    //
    // 2. MERCADOS SIN STRIKE (ej: "Bitcoin Up or Down - 2:20-2:25PM ET")
    //    → Polymarket fija precio inicial EN 0.50 (50% YES / 50% NO) — sin sesgo
    //    → PERO: necesitamos capturar el precio de BTC EN BINANCE al momento de apertura
    //       como BASELINE para analizar si subió/bajó durante esos 5 minutos
    //    → El bot captura este precio después (en index-final.js)
    //
    // Extraer el strike price solo si hay patrón claro "Will BTC be above/below $XX,XXX"
    // Para mercados "Bitcoin Up or Down" sin strike explícito, dejar como null
    let strikePrice = null;
    const desc = m.description || '';
    const question = m.question || '';
    const fullText = `${desc} ${question}`;

    // Solo capturar si hay patrón claro: "Will BTC be above/below $78,325"
    const strikeMatch = fullText.match(/(?:Will BTC be|above|below)?\s*(?:\$)?([0-9]{4,}[0-9,]*)(?:\s|$|[;.,])/i);
    if (strikeMatch) {
      const priceStr = strikeMatch[1].replace(/,/g, '').trim();
      strikePrice = parseFloat(priceStr);
      if (isNaN(strikePrice) || strikePrice < 100) strikePrice = null;  // BTC prices are usually >$100
      if (strikePrice) {
        logger.info(`[POLY] Strike price BTC: $${strikePrice.toLocaleString()}`);
      }
    }

    return { conditionId: m.conditionId||m.id, gammaId: m.id, question: m.question,
      endDate: m.endDate, yesTokenId, noTokenId,
      marketSlug: m.marketSlug, strikePrice, description: desc };
  }

  /**
   * Obtiene la profundidad completa del book via HTTP para un par YES/NO.
   * Usado como fallback cuando el WS no tiene el snapshot todavía.
   */
  async fetchBookDepth(yesTokenId, noTokenId) {
    try {
      // Usar la API pública REST de Polymarket — no requiere autenticación,
      // funciona tanto en paper como en live.
      const BASE = 'https://clob.polymarket.com';
      const headers = { 'Content-Type': 'application/json' };
      const [yesRes, noRes] = await Promise.all([
        fetch(`${BASE}/book?token_id=${yesTokenId}`, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }).catch(() => null),
        fetch(`${BASE}/book?token_id=${noTokenId}`,  { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }).catch(() => null),
      ]);
      const yesBook = yesRes?.ok ? await yesRes.json().catch(() => null) : null;
      const noBook  = noRes?.ok  ? await noRes.json().catch(() => null)  : null;

      const { parseSize, bestOfBook } = require('./book-utils');

      // Mejores precios = max(bids) / min(asks). Antes se tomaba el primer nivel del
      // array, que en el REST del CLOB es el PEOR (bids ascendentes, asks descendentes).
      const yesTop = bestOfBook(yesBook), noTop = bestOfBook(noBook);
      const yesBestPrice = yesTop.crossed ? null : yesTop.bestBid;
      const yesAskPrice = yesTop.crossed ? null : yesTop.bestAsk;
      const noBestPrice = noTop.crossed ? null : noTop.bestBid;
      const noAskPrice = noTop.crossed ? null : noTop.bestAsk;

      // TOTAL depth (suma de todos los levels) — para compatibilidad
      const yesBid = (yesBook?.bids || []).reduce((s,l) => s+parseSize(l), 0);
      const yesAsk = (yesBook?.asks || []).reduce((s,l) => s+parseSize(l), 0);
      const noBid  = (noBook?.bids  || []).reduce((s,l) => s+parseSize(l), 0);
      const noAsk  = (noBook?.asks  || []).reduce((s,l) => s+parseSize(l), 0);

      if (yesBid === 0 && yesAsk === 0 && noBid === 0 && noAsk === 0) return null;
      return {
        // Best prices (para BOOK_FILTER imbalance calculation)
        yesBestBid: yesBestPrice || null,
        yesAskPrice: yesAskPrice || null,
        noBestBid: noBestPrice || null,
        noAskPrice: noAskPrice || null,
        // Total depth (para compatibilidad con código existente)
        yesBid: parseFloat(yesBid.toFixed(2)),
        yesAsk: parseFloat(yesAsk.toFixed(2)),
        noBid:  parseFloat(noBid.toFixed(2)),
        noAsk:  parseFloat(noAsk.toFixed(2)),
      };
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
    // SIEMPRE desde el WS (síncrono, 0 I/O, < 1ms)
    // Si null o stale → null. NUNCA REST en el hot path de la señal.
    if (this._polyWs && typeof this._polyWs.getBestAskForToken === 'function') {
      return this._polyWs.getBestAskForToken(tokenId);
    }
    return null;
  }

  // Envoltorio: todo resultado con acciones llenadas trae sizeFilled, fillPrice (promedio
  // ponderado) y usdcSpent. Si algo lanza o falla después de un fill, se devuelve el fill
  // (antes se perdía y la posición no se registraba).
  async placeLimitOrder(args) {
    const ctx = { filledShares: 0, filledUsdc: 0 };
    let res;
    try { res = await this._placeLimitOrderInner(args, ctx); }
    catch (e) { res = { success: false, error: e.message }; }
    res = res || { success: false, error: 'sin respuesta' };
    if (res.dryRun) return res;
    if (!(res.sizeFilled > 0) && ctx.filledShares > 0) {
      logger.warn(`[LIVE] ⚠️ El flujo terminó con "${res.error || res.status}" pero ya había ${ctx.filledShares} acciones llenadas — se registran`);
      res = { ...res, success: true, partial: true, status: 'matched',
        sizeFilled: ctx.filledShares, usdcSpent: r2(ctx.filledUsdc) };
    }
    const st = String(res.status || '').toLowerCase();
    if (res.success && st === 'matched' && !(res.sizeFilled > 0)) res.sizeFilled = args.size;
    if (res.sizeFilled > 0) {
      res.success = true;
      if (!(res.fillPrice > 0 && res.fillPrice < 1)) {
        res.fillPrice = res.usdcSpent > 0 ? parseFloat((res.usdcSpent / res.sizeFilled).toFixed(4)) : args.price;
      }
      if (!(res.usdcSpent > 0)) res.usdcSpent = r2(res.fillPrice * res.sizeFilled);
      if (args.side === 'BUY') this.noteHeldShares(args.tokenId, res.sizeFilled);
    }
    return res;
  }

  async _placeLimitOrderInner({ marketId, tokenId, side, price, size, marketQuestion, marketEndTs, forcedOrderType }, ctx = { filledShares: 0, filledUsdc: 0 }) {

    const usdcValue = parseFloat((Math.round(price * size * 100) / 100).toFixed(2));
    const rec = { timestamp: new Date().toISOString(), marketId, marketQuestion,
      tokenId, side, price, size, usdcValue, status: 'PENDING' };
    Object.defineProperty(rec, 'ctx', { value: ctx, enumerable: false }); // para los retry-loops

    // Helper para parsear fill de BUY correctamente
    // En CLOB BUY: makingAmount = USDC gastado, takingAmount = shares recibidas
    // fillPrice = USDC / shares (no al revés)
    const parseBuyFill = (res, fallbackPrice, fallbackSize) => {
      const usdc   = parseFloat(res?.makingAmount || 0);
      const shares = parseFloat(res?.takingAmount  || 0);
      if (shares > 0 && usdc > 0) {
        return { fillPrice: parseFloat((usdc / shares).toFixed(4)), sizeFilled: shares, usdcSpent: usdc };
      }
      return { fillPrice: fallbackPrice, sizeFilled: fallbackSize, usdcSpent: fallbackPrice * fallbackSize };
    };

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
        const useFak = process.env.USE_FAK === 'true';
        const firstOrderType = useFak ? OrderType.FAK : OrderType.FOK;
        const maxAttempts = parseInt(process.env.MARKET_RETRY_ATTEMPTS || '3');
        const tick = 0.01;

        // Si viene forcedOrderType (FAK/GTC/GTD), ir directo a ese camino
        // sin mandar TRIPLE ORDER — cada entrada usa un tipo diferente
        if (forcedOrderType && forcedOrderType !== 'FAK') {
          const worstPriceForced = await (async () => {
            const ask = await this._getBestAsk(tokenId);
            if (ask == null) return price;
            const MAX_PRICE_LIMIT_F = parseFloat(process.env.MAX_PRICE_LIMIT || '0.97');
            const MAX_GTC_ENTRY_ASK_F = config.MAX_GTC_ENTRY_ASK;
            if (ask > MAX_GTC_ENTRY_ASK_F) {
              logger.warn(`[LIVE] ❌ ${forcedOrderType}: bestAsk=$${ask.toFixed(2)} > MAX_GTC_ENTRY_ASK=$${MAX_GTC_ENTRY_ASK_F} — NO_FILL`);
              return null;
            }
            return Math.min(MAX_PRICE_LIMIT_F, Math.round((ask + tick) * 100) / 100);
          })();

          if (worstPriceForced === null) return { success: false, error: 'ask_too_high', noFill: true };

          if (forcedOrderType === 'GTC') {
            logger.info(`[LIVE] 📋 Entrada GTC directa @ $${worstPriceForced.toFixed(2)}`);
            return await this._placeGtcWithRetry({ rec, tokenId, side, price: worstPriceForced, size, marketEndTs });
          }

          if (forcedOrderType === 'GTD') {
            const minExpiry = Math.floor((Date.now() + 181 * 1000) / 1000);
            const marketExpiry = marketEndTs ? Math.floor(marketEndTs / 1000) : minExpiry;
            const gtdExpiry = Math.max(minExpiry, marketExpiry);
            logger.info(`[LIVE] 📋 Entrada GTD directa @ $${worstPriceForced.toFixed(2)} (exp=${gtdExpiry})`);
            try {
              const gtdOrder = await this.clobClient.createAndPostOrder(
                { tokenID: tokenId, side: side === 'BUY' ? Side.BUY : Side.SELL,
                  price: worstPriceForced, size, expiration: gtdExpiry },
                ORDER_OPTS, OrderType.GTD);
              const gtdStatus = (String(gtdOrder?.status || '')).toLowerCase();
              const gtdFilled = gtdStatus === 'matched';
              logger.info(`[LIVE] GTD response: status=${gtdStatus} filled=${gtdFilled}`);
              if (gtdOrder?.error && !gtdOrder?.orderID) return { success: false, error: String(gtdOrder.errorMsg || gtdOrder.error) };
              if (gtdFilled) {
                // BUY: makingAmount = USDC, takingAmount = acciones (antes invertido)
                const { fillPrice, sizeFilled, usdcSpent } = parseBuyFill(gtdOrder, worstPriceForced, size);
                return { success: true, fillPrice, sizeFilled, usdcSpent, status: 'matched' };
              }
              // Queda en el libro: el polling de abajo la sigue hasta el cierre
              result = { success: true, status: gtdStatus || 'live', orderID: gtdOrder?.orderID,
                _restingGtd: true, _restDeadlineMs: marketEndTs || null, _restSize: size,
                _restPrice: worstPriceForced, _preFilledShares: 0, _preFilledUsdc: 0 };
            } catch (gtdErr) {
              logger.warn(`[LIVE] GTD error: ${gtdErr.message}`);
              return { success: false, error: gtdErr.message };
            }
          }
        }

        // La GTD forzada que quedó en el libro va directo al seguimiento de abajo
        if (!result) {
        // PRECIO REAL: usar bestAsk directamente (no priceRaw + tolerance fijo)
        // bestAsk + 1 tick = cruzar el spread real garantizado
        const MAX_PRICE_LIMIT = parseFloat(process.env.MAX_PRICE_LIMIT || '0.85');
        const getBestPrice = async () => {
          const ask = await this._getBestAsk(tokenId);
          if (ask == null) return price;
          const worstPrice = Math.min(MAX_PRICE_LIMIT, Math.round((ask + tick) * 100) / 100);
          logger.info(`[LIVE] 📊 bestAsk=$${ask.toFixed(2)} → worstPrice=$${worstPrice.toFixed(2)} orderType=${useFak ? 'FAK' : 'FOK'}`);
          return worstPrice;
        };

        const worstPrice = await getBestPrice();
        orderParams.price = worstPrice;

        let preFilledFromFak = 0;
        const hasMarketOrderMethod = typeof this.clobClient?.createAndPostMarketOrder === 'function';

        // FAK AGRESIVO: reintenta subiendo el precio de a $0.01 hasta MAX_GTC_ENTRY_ASK
        // Objetivo: maximizar ganancia real — solo entrar cuando el token cuesta ≤ MAX_GTC_ENTRY_ASK
        // Con $3 de inversión y token a $0.60 → ganancia $0.40 × 5 tokens = $2
        // Con $3 de inversión y token a $0.55 → ganancia $0.45 × 5 tokens = $2.25 ✅
        const MAX_FAK_PRICE = config.MAX_GTC_ENTRY_ASK;
        const FAK_RETRY_MS = parseInt(process.env.FAK_RETRY_MS || '1500');
        const FAK_MAX_ATTEMPTS = parseInt(process.env.FAK_MAX_ATTEMPTS || '10');

        if (!process.env.DUAL_FILL_ORDER || process.env.DUAL_FILL_ORDER !== 'true') {
          // Camino FAK agresivo con reintentos. Un fill parcial se acumula y el siguiente
          // intento pide solo el remanente (antes se ignoraba y se volvía a pedir el total).
          let fakPrice = worstPrice;
          let accShares = 0, accUsdc = 0;
          const done = () => ({ success: true, status: 'matched', partial: accShares < size - 0.01,
            fillPrice: parseFloat((accUsdc / accShares).toFixed(4)), sizeFilled: accShares, usdcSpent: r2(accUsdc) });

          for (let fakAttempt = 1; fakAttempt <= FAK_MAX_ATTEMPTS; fakAttempt++) {
            const remaining = parseFloat((size - accShares).toFixed(4));
            if (accShares > 0 && remaining < 5) return done(); // remanente bajo el mínimo de 5
            if (fakPrice > MAX_FAK_PRICE) {
              logger.warn(`[LIVE] ❌ FAK precio $${fakPrice.toFixed(2)} > MAX_GTC_ENTRY_ASK=$${MAX_FAK_PRICE} — ganancia insuficiente → ${accShares > 0 ? 'fill parcial' : 'NO_FILL'}`);
              return accShares > 0 ? done() : { success: false, error: 'ask_too_high', noFill: true };
            }

            logger.info(`[LIVE] ⚡ FAK intento ${fakAttempt}/${FAK_MAX_ATTEMPTS} @ $${fakPrice.toFixed(2)} (${remaining} acciones)`);
            try {
              const fakAmount = r2(remaining * fakPrice); // USDC con 2 decimales
              const fakRes = await this.clobClient.createAndPostMarketOrder(
                { tokenID: tokenId, side: side === 'BUY' ? Side.BUY : Side.SELL, amount: fakAmount, price: fakPrice },
                ORDER_OPTS, OrderType.FAK);
              const fakStatus = (String(fakRes?.status || '')).toLowerCase();
              let shares = parseFloat(fakRes?.takingAmount || 0), usdc = parseFloat(fakRes?.makingAmount || 0);
              const fakId = fakRes?.orderID;
              if (fakId && !FINAL_STATUSES.has(fakStatus) && !(shares > 0)) {
                // delayed/live: seguirla hasta su estado final antes de mandar otra
                const fin = await this._waitOrderFinal(fakId, 5000);
                if (!fin.final) {
                  logger.warn(`[LIVE] ⚠️ FAK ${fakId} sin estado final en 5 s — no se reintenta para no duplicar`);
                  return accShares > 0 ? done() : { success: false, error: 'fak_state_unknown', noFill: true, orderId: fakId };
                }
                if (fin.matched > 0) { shares = fin.matched; usdc = fin.matched * fakPrice; }
              }
              if (shares > 0 && usdc > 0) {
                accShares += shares; accUsdc += usdc;
                ctx.filledShares = accShares; ctx.filledUsdc = accUsdc;
                logger.info(`[LIVE] ✅ FAK llenó ${shares} acciones @ $${(usdc / shares).toFixed(4)} (acumulado ${accShares}/${size})`);
                if (size - accShares < 5) return done();
              }

              // Esperar y refrescar el bestAsk para el siguiente intento
              await new Promise(r => setTimeout(r, FAK_RETRY_MS));
              const newAsk = await this._getBestAsk(tokenId);
              if (newAsk != null) {
                fakPrice = Math.min(MAX_FAK_PRICE, Math.round((newAsk + 0.01) * 100) / 100);
                logger.info(`[LIVE] 🔄 FAK reintento: bestAsk=$${newAsk.toFixed(2)} → nuevo precio $${fakPrice.toFixed(2)}`);
              } else {
                fakPrice = parseFloat(Math.min(MAX_FAK_PRICE, fakPrice + 0.01).toFixed(2));
              }
            } catch (fakErr) {
              logger.warn(`[LIVE] FAK intento ${fakAttempt} error: ${fakErr.message}`);
              await new Promise(r => setTimeout(r, FAK_RETRY_MS));
            }
          }

          if (accShares > 0) return done();
          logger.warn(`[LIVE] FAK agresivo agotó ${FAK_MAX_ATTEMPTS} intentos → NO_FILL`);
          return { success: false, error: 'fak_exhausted', noFill: true };
        }

        // DUAL ORDER: FAK instantáneo + GTC como backup
        // La primera que llena cancela la otra — una sola posición por señal
        const DUAL_ORDER = process.env.DUAL_FILL_ORDER === 'true';

        if (DUAL_ORDER) {
          // Asegurar el fill sin duplicar la posición. Antes se mandaban FAK + GTC + GTD juntas
          // al mismo precio: las tres cruzaban el libro y podían llenarse dos o tres a la vez
          // (el bot registraba una), y si ninguna llenaba al instante la GTC se cancelaba pero
          // la GTD quedaba viva sin seguimiento mientras arrancaba otro retry-loop. Ahora:
          //   1) FAK a worstPrice: toma lo que haya en el libro en ese momento.
          //   2) Si falta, UNA sola GTD por el remanente al mismo precio, que vence al cierre
          //      del mercado. El polling de abajo la sigue hasta que llena o llega el cierre;
          //      ahí se cancela y se suma lo que haya llenado.
          const minExpiry = Math.floor((Date.now() + 181 * 1000) / 1000);
          const marketExpiry = marketEndTs ? Math.floor(marketEndTs / 1000) : minExpiry;
          const gtdExpiry = Math.max(minExpiry, marketExpiry);
          // makerAmount (USDC) con 2 decimales como máximo
          const safeSize = Math.floor(parseFloat((size * worstPrice).toFixed(2)) / worstPrice);
          const orderSize = safeSize > 0 ? safeSize : size;
          const sideEnum = side === 'BUY' ? Side.BUY : Side.SELL;
          const opts = ORDER_OPTS;

          // Acciones de este token que ya teníamos antes de esta orden (otras entradas del
          // mismo mercado): el saldo real menos esto es lo que llenó esta orden
          const heldBefore = this._heldShares.get(tokenId) || 0;
          let fakShares = 0, fakUsdc = 0, fakUnresolved = false;
          try {
            logger.info(`[LIVE] 🔀 FAK + GTD de respaldo @ $${worstPrice} (${orderSize} tokens)`);
            const fakAmount = r2(orderSize * worstPrice);
            const fakRes = await this.clobClient.createAndPostMarketOrder(
              { tokenID: tokenId, side: sideEnum, amount: fakAmount, price: worstPrice },
              opts, OrderType.FAK);
            logger.info(`[LIVE] FAK response: ${JSON.stringify(fakRes)}`);
            const fakErr = String(fakRes?.error || fakRes?.errorMsg || '').toLowerCase();
            if (fakErr.includes('trading is disabled')) {
              logger.warn(`[LIVE] ⛔ trading disabled → NO_FILL inmediato`);
              return { success: false, error: 'trading_disabled', noFill: true };
            }
            const usdc = parseFloat(fakRes?.makingAmount || 0);
            const shares = parseFloat(fakRes?.takingAmount || 0);
            if (shares > 0 && usdc > 0) { fakShares = shares; fakUsdc = usdc; }
            const fakStatus = String(fakRes?.status || '').toLowerCase();
            const fakId = fakRes?.orderID;
            if (fakId && !FINAL_STATUSES.has(fakStatus)) {
              // delayed (retención de ~150 ms de Polymarket) / live: antes quedaba fakShares = 0
              // y se mandaba una GTD por el total → doble exposición posible
              logger.info(`[LIVE] ⏳ FAK status="${fakStatus}" — esperando estado final (${fakId})`);
              const fin = await this._waitOrderFinal(fakId, 5000);
              if (fin.final) {
                if (fin.matched > fakShares) { fakShares = fin.matched; fakUsdc = fin.matched * worstPrice; }
              } else fakUnresolved = true;
            }
          } catch (fakErr) {
            logger.warn(`[LIVE] FAK error: ${fakErr.message}`);
            fakUnresolved = true; // pudo haber llenado
          }
          ctx.filledShares = fakShares; ctx.filledUsdc = fakUsdc;

          // Saldo real del token antes de la GTD: pedir solo lo que falta
          const bal = await this._tokenBalance(tokenId);
          if (bal != null) {
            const viaBal = Math.max(0, parseFloat((bal - heldBefore).toFixed(4)));
            if (viaBal > fakShares + 0.01) {
              logger.warn(`[LIVE] 🔎 Saldo del token muestra ${viaBal} acciones de esta orden (FAK informó ${fakShares}) — se usa el saldo`);
              fakUsdc += (viaBal - fakShares) * worstPrice;
              fakShares = viaBal;
              ctx.filledShares = fakShares; ctx.filledUsdc = fakUsdc;
            }
            fakUnresolved = false;
          }
          const fakFillPrice = fakShares > 0 ? parseFloat((fakUsdc / fakShares).toFixed(4)) : worstPrice;
          const fakOnly = () => ({ success: true, status: 'matched', fillPrice: fakFillPrice, sizeFilled: fakShares,
            usdcSpent: r2(fakUsdc), partial: fakShares < orderSize - 0.01, requestedSize: orderSize });
          if (fakUnresolved) {
            logger.warn(`[LIVE] ⚠️ Estado de la FAK desconocido y sin saldo del token — no se manda la GTD (evita doble exposición)`);
            return fakShares > 0 ? fakOnly() : { success: false, error: 'fak_state_unknown', noFill: true };
          }

          const remaining = Math.floor(orderSize - fakShares);
          if (fakShares > 0 && remaining < 5) {
            // Llenó todo, o lo que falta está por debajo del mínimo de Polymarket (5 tokens)
            logger.info(`[LIVE] ✅ FAK llenó ${fakShares} tokens @ $${fakFillPrice}${remaining > 0 ? ` (remanente ${remaining} < 5, se acepta parcial)` : ''}`);
            return fakOnly();
          }
          if (remaining < 5) return { success: false, error: 'size_below_min', noFill: true };

          try {
            const gtdRes = await this.clobClient.createAndPostOrder(
              { tokenID: tokenId, side: sideEnum, price: worstPrice, size: remaining, expiration: gtdExpiry },
              opts, OrderType.GTD);
            logger.info(`[LIVE] GTD response: ${JSON.stringify(gtdRes)}`);
            const gtdId = gtdRes?.orderID || gtdRes?.orderId;
            const gtdStatus = String(gtdRes?.status || '').toLowerCase();
            if (gtdRes?.success !== false && !gtdRes?.error && gtdId) {
              logger.info(`[LIVE] 📋 GTD ${remaining} tokens @ $${worstPrice} en el libro hasta el cierre (status=${gtdStatus})${fakShares > 0 ? ` | FAK ya llenó ${fakShares}` : ''}`);
              result = {
                success: true, status: gtdStatus || 'live', orderID: gtdId,
                _restingGtd: true,
                _restDeadlineMs: marketEndTs || null,
                _restSize: remaining,
                _restPrice: worstPrice,
                _preFilledShares: fakShares,
                _preFilledUsdc: fakUsdc,
              };
            } else {
              logger.warn(`[LIVE] GTD rechazada: ${gtdRes?.errorMsg || JSON.stringify(gtdRes?.error || '') || 'sin orderID'}`);
            }
          } catch (gtdErr) {
            logger.warn(`[LIVE] GTD error: ${gtdErr.message}`);
          }

          if (!result) {
            // Desde DUAL nunca se cae al loop FOK ni a MARKET_RETRY (abrían órdenes extra)
            return fakShares > 0 ? fakOnly() : { success: false, error: 'dual_no_fill', noFill: true };
          }
        }
        // Camino normal FAK/FOK si no hay DUAL o falló
        if (!result) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const orderLabel = useFak ? 'FAK' : 'FOK';
          if (attempt > 1) {
            orderParams.price = await getBestPrice();
          }
          logger.info(`[LIVE] 📈 MARKET order (${orderLabel}) intento ${attempt}/${maxAttempts} @ $${orderParams.price} size=${orderParams.size}`);

          if (hasMarketOrderMethod) {
            // Cambio 1 CRÍTICO: usar el path correcto createAndPostMarketOrder
            // amount = size * price para BUY (USDC gastado), size para SELL (shares)
            // Precision fix: ensure exactly 2 decimals for CLOB validation
            const marketAmt = side === 'BUY'
              ? parseFloat((Math.round(orderParams.size * orderParams.price * 100) / 100).toFixed(2))
              : orderParams.size;
            result = await this.clobClient.createAndPostMarketOrder(
              {
                tokenID: tokenId,
                side: side === 'BUY' ? Side.BUY : Side.SELL,
                amount: marketAmt,
                price: orderParams.price,
              },
              ORDER_OPTS,
              firstOrderType
            );
          } else {
            // Fallback al método anterior si la versión del cliente no tiene createAndPostMarketOrder
            result = await this.clobClient.createAndPostOrder({ ...orderParams }, ORDER_OPTS, firstOrderType);
          }
          logger.info(`[LIVE] response (${orderLabel} intento ${attempt}): ${JSON.stringify(result)}`);

          // Si Polymarket está en mantenimiento → NO_FILL inmediato
          const errMsgFak = result?.error || result?.errorMsg || '';
          if (errMsgFak.toLowerCase().includes('trading is disabled') || result?.status === 503) {
            logger.warn(`[LIVE] ⛔ "trading is disabled" — NO_FILL inmediato, no reintentar`);
            return { success: false, error: 'trading_disabled', noFill: true };
          }

          // Auto-refresh allowance si detecta balance insuficiente
          if (errMsgFak.toLowerCase().includes('not enough balance') || errMsgFak.toLowerCase().includes('allowance')) {
            logger.warn(`[LIVE] ⚡ Balance insuficiente detectado — refrescando allowance...`);
            try {
              await this.clobClient.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
              logger.info(`[LIVE] ✅ Allowance actualizado`);
            } catch (e) { logger.warn(`[LIVE] Error actualizando allowance: ${e.message}`); }
          }

          const rawStatus = (String(result?.status || '')).toLowerCase();
          const gotFilled = result?.success && rawStatus === 'matched';

          // Cambio 2: status "live" o "delayed" = taker delay de ~250ms en crypto markets
          // NO cancelar inmediatamente — esperar 450ms y reconsultar
          // IMPORTANTE: no cancelar si es un ID del TRIPLE ORDER (GTC/GTD que deben quedar vivos)
          const delayedOrderId = result?.orderID || result?.orderId || result?.id;
          const isTripleOrderId = delayedOrderId && (
            delayedOrderId === rec._tripleGtcId || delayedOrderId === rec._tripleGtdId
          );
          if (result?.success && (rawStatus === 'live' || rawStatus === 'delayed') && !isTripleOrderId) {
            logger.info(`[LIVE] ⏳ ${orderLabel} status="${rawStatus}" — esperando 450ms por taker delay antes de cancelar (orderId=${delayedOrderId})`);
            await new Promise(r => setTimeout(r, 450));
            if (delayedOrderId) {
              try {
                const recheck = await this._getOrderSafe(delayedOrderId);
                const recheckStatus = (String(recheck?.status || '')).toLowerCase();
                if (recheckStatus === 'matched') {
                  logger.info(`[LIVE] ✅ ${orderLabel} llenó durante el taker delay (450ms) — usando ese fill`);
                  const fillTimeMs = Date.now() - (rec._placedAt || Date.now());
                  rec.status = 'PLACED'; rec.orderId = delayedOrderId; rec.sizeFilled = orderParams.size;
                  this._orderHistory.push(rec);
                  return { success: true, orderId: delayedOrderId, status: 'matched', fillTimeMs, sizeFilled: orderParams.size };
                }
                logger.info(`[LIVE] ${orderLabel} sigue sin fill tras 450ms (status=${recheckStatus}) — procediendo a cancelar`);
              } catch (recheckErr) {
                logger.warn(`[LIVE] recheck error tras delay: ${recheckErr.message}`);
              }
            }
          } else if (isTripleOrderId && (rawStatus === 'live' || rawStatus === 'delayed')) {
            logger.info(`[LIVE] 🔀 ${orderLabel} ID=${delayedOrderId?.slice(0,10)} es del TRIPLE ORDER — dejando vivo en el libro`);
          }

          // FAK puede devolver fill parcial
          if (useFak && result?.success) {
            if (rawStatus === 'matched') {
              preFilledFromFak += orderParams.size;
              break;
            }
            const fakFilled = parseFloat(result?.size_matched || result?.sizeFilled || 0) || 0;
            if (fakFilled > 0 && fakFilled < orderParams.size) {
              preFilledFromFak += fakFilled;
              const newRemaining = parseFloat((orderParams.size - fakFilled).toFixed(6));
              logger.info(`[LIVE] 🔶 FAK fill parcial: ${fakFilled} tokens — quedan ${newRemaining} por llenar`);
              if (newRemaining < 5) {
                logger.info(`[LIVE] 🔶 Remanente ${newRemaining} < 5 tokens (mínimo Polymarket) — aceptando fill parcial de ${preFilledFromFak} tokens`);
                break;
              }
              orderParams.size = newRemaining;
              continue;
            }
          }

          if (gotFilled) break;
          if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 300));
        }

        // Si FAK llenó algo parcialmente, guardar para sumarlo al resultado final
        if (preFilledFromFak > 0 && result) {
          result._preFilledFromFak = preFilledFromFak;
        }
        } // end if (!result) — cierre del camino FAK normal
        } // end if (!result) — GTD forzada
      } else {
        // GTC — orden límite con tolerancia de precio
        orderParams.price = price;
        result = await this.clobClient.createAndPostOrder(orderParams, ORDER_OPTS, OrderType.GTC);
        logger.info(`[LIVE] response: ${JSON.stringify(result)}`);
      }

      // MARKET_RETRY: si los N intentos de FOK fallaron, caer a GTC como red de seguridad
      const fokConfirmedMatch = result?.success && (String(result?.status || '')).toLowerCase() === 'matched';
      // La GTD de respaldo (DUAL_FILL_ORDER) queda en el libro a propósito: no cancelarla
      // ni abrir otro retry-loop; la sigue el polling de abajo hasta el cierre.
      if (!fokConfirmedMatch && isMarket && marketRetryEnabled && !result?._restingGtd) {
        // FIX CRÍTICO (detectado en el primer log de live, 03/08): un FOK que
        // no llena instantáneo puede volver con status "live" — es decir,
        // Polymarket lo dejó viva en el libro en vez de matarla. Si no la
        // cancelamos acá, el retry-loop de abajo abre una SEGUNDA orden
        // independiente y quedan dos órdenes vivas al mismo tiempo (doble
        // exposición real). Cancelar siempre antes de seguir.
        const staleOrderId = result?.orderID || result?.orderId || result?.id;
        const staleStatus = (String(result?.status || '')).toLowerCase();
        let preFilledSize = 0; // FIX: si el FOK "muerto" ya llenó parcialmente, no lo perdemos
        if (staleOrderId && staleStatus !== 'matched' && staleStatus !== 'cancelled' && staleStatus !== 'canceled') {
          logger.warn(`[LIVE] ⚠️ FOK quedó con estado "${staleStatus}" (no killed) — cancelando orden ${staleOrderId} antes de reintentar`);
          try {
            // cancelOrder no lanza: devuelve { error }. Sin confirmación → abortar
            const c = await this._cancelChecked(staleOrderId);
            if (!c.ok) throw new Error(c.error);
            // Verificar que no se haya llenado (total o parcial) en el instante entre el check y el cancel
            const check = await this._getOrderSafe(staleOrderId);
            if ((String(check?.status || '')).toLowerCase() === 'matched') {
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
            try { require('./alerts').alertOperational('Cancelación de orden sin confirmar', `FOK residual ${staleOrderId}: ${cancelErr.message}`); } catch (_) {}
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
        const retryParams = { ...orderParams };
        result = await this.clobClient.createAndPostOrder(retryParams, ORDER_OPTS, OrderType.GTC);
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
      let orderStatus = (String(result?.status || 'unknown')).toLowerCase(); // normalizar
      rec.status = 'PLACED'; rec.orderId = orderId;
      this._orderHistory.push(rec);
      logger.info(`[LIVE] ✅ ${isMarket ? 'MARKET' : 'GTC'} Order ID: ${orderId} | status inicial: ${orderStatus}`);

      const orderPlacedAt = Date.now(); // para calcular fill_time_ms

      // Si ya llenó al instante → retornar con fill_time_ms
      if (orderStatus === 'matched') {
        const fillTimeMs = Date.now() - orderPlacedAt;
        logger.info(`[LIVE] ⚡ Fill instantáneo: ${fillTimeMs}ms`);
        if (result?._restingGtd) {
          const sh = result._restSize, us = (result._preFilledUsdc || 0) + sh * result._restPrice;
          const tot = (result._preFilledShares || 0) + sh;
          return { success: true, orderId, status: 'matched', fillTimeMs, sizeFilled: tot,
            usdcSpent: r2(us), fillPrice: parseFloat((us / tot).toFixed(4)) };
        }
        return { success: true, orderId, status: 'matched', fillTimeMs,
          ...parseBuyFill(result, orderParams.price ?? price, orderParams.size ?? size) };
      }

      // Orden en el book ('live', o 'delayed' por la retención de Polymarket) → polling
      // hasta fill o timeout. Antes 'delayed' salía como "sin fill" y la orden quedaba viva.
      if (orderStatus === 'live' || orderStatus === 'delayed' || result?._restingGtd) {
        // GTD de respaldo (DUAL_FILL_ORDER): se sigue hasta el cierre del mercado, no 60 s
        const resting = !!result?._restingGtd;
        const preShares = resting ? (result._preFilledShares || 0) : 0;
        const preUsdc = resting ? (result._preFilledUsdc || 0) : 0;
        const restPrice = resting ? result._restPrice : price;
        const deadline = resting && result._restDeadlineMs ? result._restDeadlineMs : Date.now() + GTC_TIMEOUT_MS;
        const POLL_INTERVAL_MS = resting ? 2000 : 5000;
        logger.info(`[LIVE] 📋 Orden en book — esperando fill (hasta ${Math.round((deadline - Date.now()) / 1000)}s)`);

        // Fill total = lo que llenó la FAK + lo que llenó esta orden
        const withPreFill = (shares) => {
          const total = preShares + shares;
          const usdc = preUsdc + shares * restPrice;
          return { sizeFilled: total, usdcSpent: parseFloat(usdc.toFixed(2)),
            fillPrice: total > 0 ? parseFloat((usdc / total).toFixed(4)) : restPrice };
        };

        let lastMatched = 0;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
          try {
            const orderData = await this._getOrderSafe(orderId);
            if (!orderData) { logger.warn(`[LIVE] Poll: getOrder falló — se mantiene filled=${lastMatched}`); continue; }
            const rawStatus = orderData?.status || orderStatus;
            orderStatus = String(rawStatus).toLowerCase(); // normalizar a minúsculas
            // Una consulta fallida antes devolvía {error} y ponía lastMatched en 0
            lastMatched = Math.max(lastMatched, parseFloat(orderData?.size_matched || 0) || 0);
            if (resting) { ctx.filledShares = preShares + lastMatched; ctx.filledUsdc = preUsdc + lastMatched * restPrice; }
            logger.info(`[LIVE] 🔄 Poll: status=${rawStatus} filled=${lastMatched}/${resting ? result._restSize : size}`);

            if (orderStatus === 'matched') {
              const fillTimeMs = Date.now() - orderPlacedAt;
              logger.info(`[LIVE] ✅ Orden llenada (poll) en ${fillTimeMs}ms`);
              if (resting) {
                const restSize = lastMatched > 0 ? lastMatched : result._restSize;
                return { success: true, orderId, status: 'matched', fillTimeMs, ...withPreFill(restSize) };
              }
              return { success: true, orderId, status: 'matched', fillTimeMs };
            }
            if (FINAL_STATUSES.has(orderStatus)) {
              logger.warn(`[LIVE] ⚠️ Orden ${orderStatus} durante poll (llenado ${lastMatched})`);
              break;
            }
          } catch (pollErr) {
            logger.warn(`[LIVE] Poll error: ${pollErr.message}`);
          }
        }

        // Cierre o timeout: cancelar lo que quede y contar lo que haya llenado (total o parcial)
        if (!FINAL_STATUSES.has(orderStatus)) {
          logger.warn(`[LIVE] ⏱️ ${resting ? 'Cierre del mercado' : `Timeout GTC (${GTC_TIMEOUT_MS/1000}s)`} — cancelando orden ${orderId}`);
          const c = await this._cancelChecked(orderId);
          if (c.ok) logger.info(`[LIVE] 🚫 Orden cancelada${c.finalStatus ? ` (ya estaba ${c.finalStatus})` : ''}`);
          else {
            logger.error(`[LIVE] ❌ No se pudo confirmar la cancelación de ${orderId}: ${c.error} — puede seguir viva en el libro`);
            try { require('./alerts').alertOperational?.('Cancelación de orden sin confirmar', `orderID ${orderId}: ${c.error}`); } catch (_) {}
          }
        }
        const finalData = await this._getOrderSafe(orderId);
        if (finalData) lastMatched = Math.max(lastMatched, parseFloat(finalData.size_matched || 0) || 0);

        const fill = withPreFill(lastMatched);
        if (fill.sizeFilled > 0) {
          logger.info(`[LIVE] 🔶 Fill parcial: ${fill.sizeFilled} tokens @ $${fill.fillPrice}`);
          return { success: true, orderId, status: 'matched', partial: true, ...fill };
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
      const top = require('./book-utils').bestOfBook(book);
      if (top.crossed) return null;
      const bestBid = top.bestBid || 0;
      const bestAsk = top.bestAsk || 0;
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
      // El bot SIEMPRE COMPRA tokens: NO para DOWN, YES para UP.
      // El campo side de la posición es la dirección de la apuesta,
      // NO el lado de la orden. Para cerrar cualquier posición hay que
      // VENDER los tokens que tenemos en mano — siempre SELL.
      // (Bug anterior: side='SELL' en posiciones DOWN hacía exitSide='BUY',
      //  comprando MÁS tokens a $0.99 en vez de vender los existentes.)
      const exitSide = 'SELL';
      const book = await this.clobClient.getOrderBook(tokenId);
      // Vendemos al best bid (el mejor precio que alguien paga por nuestro token)
      const exitPrice = require('./book-utils').bestOfBook(book).bestBid || 0; // max(bids)
      if (!exitPrice) return { success: false, error: 'sin liquidez para salir' };

      // Vender floor(saldo real del token): Math.round del tamaño registrado podía pedir más
      // acciones de las que hay y la orden se rechazaba
      const bal = await this._tokenBalance(tokenId);
      const shares = Math.floor(bal != null ? Math.min(size, bal) : size);
      if (!(shares > 0)) return { success: false, error: `sin acciones para vender (saldo ${bal})` };
      logger.info(`[POSITION-MONITOR] 🚪 Cerrando ${posId} — ${exitSide} ${shares}t @ $${exitPrice.toFixed(3)} (saldo ${bal ?? 'n/a'})`);
      // FAK (llena lo que haya y cancela el resto) como 3er argumento: dentro del objeto la
      // librería lo ignoraba y la venta salía GTC (quedaba en el libro). SELL: amount = acciones.
      const result = await this.clobClient.createAndPostMarketOrder(
        { tokenID: tokenId, side: Side.SELL, amount: shares, price: exitPrice },
        ORDER_OPTS, OrderType.FAK);
      // SELL: makingAmount = acciones entregadas, takingAmount = USDC recibido
      const soldShares = parseFloat(result?.makingAmount || 0) || 0;
      const usdcIn = parseFloat(result?.takingAmount || 0) || 0;
      const ok = !result?.error && result?.success !== false && soldShares > 0;
      const avg = ok && usdcIn > 0 ? parseFloat((usdcIn / soldShares).toFixed(4)) : exitPrice;
      if (ok) {
        logger.info(`[POSITION-MONITOR] ✅ Posición ${posId}: vendidas ${soldShares}/${shares} @ $${avg.toFixed(3)}`);
      } else {
        logger.warn(`[POSITION-MONITOR] ⚠️ No se pudo cerrar ${posId}: ${result?.errorMsg || JSON.stringify(result?.error || '') || 'sin fill'}`);
      }
      return { success: ok, price: avg, soldShares, partial: ok && soldShares < shares, result };
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
  // Feature avanzado: parte ORDER_SPLIT_PIECES pedazos en paralelo, cada uno con
  // retry independiente. Útil cuando el libro tiene profundidad limitada.
  // SE ACTIVA cuando: ORDER_SPLIT=true + balance suficiente para múltiples órdenes
  // Actual: ORDER_SPLIT=false (default) + capital=$0.03 < $5+ mínimo → no activo
  // Respeta mínimo Polymarket (5 tokens/orden): si total < 5*pieces, manda entera.
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
    // Cambio 3: MAX_BUMP unificado a 0.05 (antes había inconsistencia 0.03 vs 0.05)
    const MAX_BUMP    = parseFloat(process.env.FILL_RETRY_MAX_BUMP || '0.05');
    const CUTOFF_MS   = parseInt(process.env.FILL_RETRY_CUTOFF_SECONDS || '25') * 1000;
    const MAX_TOTAL_MS = parseInt(process.env.FILL_RETRY_MAX_TOTAL_SECONDS || '60') * 1000;
    // Cambio 3: presupuesto mínimo garantizado de 30s aunque el mercado esté por cerrar
    const MIN_BUDGET_MS = 30000;
    const POLL_MS     = 3000;

    const startedAt = Date.now();

    const marketDeadline = marketEndTs
      ? marketEndTs - CUTOFF_MS
      : startedAt + (config.GTC_TIMEOUT_SECONDS || 60) * 1000;
    const absoluteDeadline = startedAt + MAX_TOTAL_MS;
    // Cambio 3: nunca bajar del presupuesto mínimo garantizado
    const globalDeadline = Math.max(
      Math.min(marketDeadline, absoluteDeadline),
      startedAt + MIN_BUDGET_MS
    );

    const isBuy = side === 'BUY';
    // Arrancar desde bestAsk real si está disponible — no desde priceRaw + offset
    let startPrice = price;
    try {
      const bestAsk = await this._getBestAsk(tokenId);
      logger.info(`[RETRY] _getBestAsk resultado: ${bestAsk != null ? '$'+bestAsk.toFixed(2) : 'null/undefined'} para token ${tokenId?.slice(0,12)}`);
      if (bestAsk != null) {
        const MAX_PRICE_LIMIT_GTC = parseFloat(process.env.MAX_PRICE_LIMIT || '0.97');
        // MAX_GTC_ENTRY_ASK: si el bestAsk supera este umbral, el GTC retry
        // arrancaría tan caro que la ganancia sería mínima y el riesgo alto.
        // Por ejemplo: bestAsk=$0.97 → ganancia máxima=$0.03/token vs riesgo=$0.97/token
        // Default: 0.85 — si el ask ya está en $0.85+ no vale la pena entrar por GTC
        const MAX_GTC_ENTRY_ASK = config.MAX_GTC_ENTRY_ASK;
        if (bestAsk > MAX_GTC_ENTRY_ASK) {
          logger.warn(`[RETRY] ❌ bestAsk=$${bestAsk.toFixed(2)} > MAX_GTC_ENTRY_ASK=$${MAX_GTC_ENTRY_ASK} — ratio riesgo/recompensa malo, cancelando GTC retry → NO_FILL`);
          return { success: false, error: 'ask_too_high', bestAsk, noFill: true };
        }
        startPrice = Math.min(MAX_PRICE_LIMIT_GTC, Math.round((bestAsk + 0.01) * 100) / 100);
        logger.info(`[RETRY] bestAsk=$${bestAsk.toFixed(2)} → GTC arranca @ $${startPrice.toFixed(2)} (MAX_PRICE_LIMIT=${MAX_PRICE_LIMIT_GTC}, precio base=$${price.toFixed(2)})`);
      } else {
        logger.warn(`[RETRY] bestAsk null — GTC arranca desde precio base $${price.toFixed(2)}`);
      }
    } catch (e) {
      logger.warn(`[RETRY] _getBestAsk error: ${e.message} — usando precio base $${price.toFixed(2)}`);
    }
    let currentPrice = parseFloat(startPrice.toFixed(2));
    let attempt = 0;
    let filledSoFar = 0;
    let remainingSize = size;

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
          price: currentPrice,
        };

        let result;
        try {
          result = await this.clobClient.createAndPostOrder(orderParams, ORDER_OPTS, OrderType.GTC);
        } catch (e) {
          logger.warn(`[RETRY] error al postear intento ${attempt}: ${e.message}`);
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }

        if (!result?.success || result?.error) {
          const errMsg = String(result?.errorMsg || result?.error || '');
          logger.warn(`[RETRY] intento ${attempt} rechazado: ${errMsg || 'sin detalle'}`);

          // Si Polymarket está en mantenimiento → NO_FILL inmediato, no reintentar
          if (errMsg.toLowerCase().includes('trading is disabled') || result?.status === 503) {
            logger.warn(`[RETRY] ⛔ "trading is disabled" — Polymarket en mantenimiento → NO_FILL inmediato`);
            return { success: false, error: 'trading_disabled', noFill: true };
          }
          // Auto-refresh allowance si el error es de balance insuficiente
          if (errMsg.toLowerCase().includes('not enough balance') || errMsg.toLowerCase().includes('allowance')) {
            logger.warn(`[RETRY] ⚡ Detectado error de allowance — refrescando balance cache...`);
            try {
              await this.clobClient.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
              logger.info(`[RETRY] ✅ Balance allowance actualizado — reintentando`);
            } catch (updateErr) {
              logger.warn(`[RETRY] Error al actualizar allowance: ${updateErr.message}`);
            }
          }
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }

        const orderId = result?.orderID || result?.orderId || result?.id;
        let orderStatus = (String(result?.status || 'unknown')).toLowerCase();

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
            const orderData = await this._getOrderSafe(orderId);
            if (!orderData) continue; // consulta fallida: no se pisa lo ya llenado
            orderStatus = (String(orderData?.status || orderStatus)).toLowerCase();
            thisOrderFilled = Math.max(thisOrderFilled, parseFloat(orderData?.size_matched || 0) || 0);
            if (rec.ctx) { rec.ctx.filledShares = filledSoFar + thisOrderFilled; rec.ctx.filledUsdc = (filledSoFar + thisOrderFilled) * currentPrice; }
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
            if (FINAL_STATUSES.has(orderStatus)) break;
          } catch (pollErr) {
            logger.warn(`[RETRY] poll error: ${pollErr.message}`);
          }
        }

        // No llenó del todo en este intento — cancelar el remanente antes de
        // reintentar (crítico: nunca dejar dos órdenes vivas al mismo tiempo)
        if (!FINAL_STATUSES.has(orderStatus)) {
          // cancelOrder no lanza (devuelve { error }): validar la respuesta
          const c = await this._cancelChecked(orderId);
          if (c.ok) {
            logger.info(`[RETRY] 🚫 intento ${attempt} cancelado (sin fill completo en ${ATTEMPT_MS/1000}s)`);
          } else {
            logger.error(`[RETRY] error cancelando intento ${attempt}: ${c.error}`);
            try { require('./alerts').alertOperational('Cancelación de orden sin confirmar', `orderID ${orderId}: ${c.error}`); } catch (_) {}
            // Si no pudimos confirmar la cancelación, NO reintentar con otra
            // orden — riesgo de doble posición. Cortamos acá, pero si ya
            // sabemos que hay fill parcial confirmado, lo reportamos igual.
            rec.status = 'FAILED'; rec.error = 'cancel_failed'; rec.sizeFilled = filledSoFar + thisOrderFilled;
            this._orderHistory.push(rec);
            return { success: filledSoFar + thisOrderFilled > 0, orderId, attempts: attempt,
              error: 'cancel_failed', sizeFilled: filledSoFar + thisOrderFilled, partial: true,
              fillPrice: currentPrice };
          }
          // Verificación post-cancel: si justo llenó (total o parcial) entre
          // el poll y el cancel, leer el estado final antes de seguir.
          try {
            const finalCheck = await this._getOrderSafe(orderId);
            const finalStatus = (String(finalCheck?.status || '')).toLowerCase();
            const finalFilled = Math.max(thisOrderFilled, parseFloat(finalCheck?.size_matched || 0) || 0);
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
        currentPrice = parseFloat(capped.toFixed(2));
      }

      if (filledSoFar > 0) {
        logger.warn(`[RETRY] ⏱️ Presupuesto agotado tras ${attempt} intento(s) — fill PARCIAL: ${filledSoFar}/${size} tokens`);
        rec.status = 'PARTIAL'; rec.fillAttempts = attempt; rec.sizeFilled = filledSoFar;
        this._orderHistory.push(rec);
        return { success: true, partial: true, sizeFilled: filledSoFar, requestedSize: size, attempts: attempt, fillPrice: currentPrice };
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
      if (result?.error) throw new Error(JSON.stringify(result.error).slice(0, 120));
      // El CLOB devuelve el balance en unidades USDC (6 decimales)
      const raw = result?.balance ?? result?.allowance ?? result?.data?.balance;
      if (raw === undefined) return null;
      return parseFloat((parseFloat(raw) / 1e6).toFixed(2));
    } catch (e) {
      // (Se eliminó el respaldo por fetch directo: mandaba el secret de la API en texto
      // plano en un header en vez de la firma HMAC)
      logger.warn(`[BALANCE] getBalanceAllowance falló: ${e.message}`);
      return null;
    }
  }

  // Cancela todas las órdenes abiertas de la cuenta (arranque y apagado en real)
  async cancelAllOrders() {
    if (config.DRY_RUN) return { ok: true, dryRun: true };
    try {
      await this._init();
      const res = await this.clobClient.cancelAll();
      if (res?.error) return { ok: false, error: JSON.stringify(res.error).slice(0, 150) };
      return { ok: true, canceled: Array.isArray(res?.canceled) ? res.canceled.length : 0 };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // Saldo de un token (acciones) — para reconciliar posiciones restauradas
  async getTokenBalance(tokenId) {
    if (config.DRY_RUN) return null;
    try { await this._init(); } catch (_) { return null; }
    return this._tokenBalance(tokenId);
  }
}

module.exports = { PolymarketClient };
