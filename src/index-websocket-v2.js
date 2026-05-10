const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketWebSocketClient } = require('./polymarket-ws');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');
 
const logger = new Logger('MAIN');

/**
 * ✅ MEJORA #2: Calcular en qué minuto (0-4) estamos dentro de la ventana de 5 minutos
 * Solo operamos en minutos 1-3 (evitar volatilidad inicial y rush final)
 */
function getWindowMinute(endDate) {
  const end = new Date(endDate).getTime();
  const windowStart = end - (5 * 60 * 1000); // 5 minutos antes
  const now = Date.now();
  const elapsed = now - windowStart;
  const minute = Math.floor(elapsed / 60000); // Dividir por 60000ms = 1 minuto
  return Math.max(0, Math.min(4, minute)); // Clamp entre 0-4
}
 
async function main() {
  logger.info('='.repeat(60));
  logger.info('🚀 Latency Bot v2.0 - WebSocket + Timing + Liquidez');
  logger.info('='.repeat(60));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING (DRY RUN)' : 'LIVE TRADING'}`);
  logger.info(`Capital por trade: $${config.ORDER_SIZE_USDC}`);
  logger.info(`Max posiciones: ${config.MAX_POSITIONS}`);
  logger.info(`Ventana de entrada: Minutos 1-3`);
  logger.info(`Min liquidez requerida: $${config.ORDER_SIZE_USDC * 3}`);
  logger.info('='.repeat(60));
 
  const signal = new SignalEngine();
  const polyWS = new PolymarketWebSocketClient(); // ✅ WebSocket client
  const binanceWS = new BinanceWS();
  const tracker = new PnLTracker();
 
  let activeMarket = null;
  let lastTradeTime = 0;
  let posicionAbierta = false;
  const COOLDOWN_MS = config.COOLDOWN_SECONDS * 1000;
  const MAX_EDGE_PCT = 50;
  const MIN_LIQUIDITY_USD = config.ORDER_SIZE_USDC * 3; // 3x buffer

  // ✅ MEJORA #1: Configurar callback de WebSocket para updates de precio en tiempo real
  polyWS.onPriceUpdate((prices) => {
    signal.updatePolyPrice(prices.yes, prices.no);
    logger.debug(`[POLY-WS] YES=${prices.yes.toFixed(3)} NO=${prices.no.toFixed(3)} | Spread=${(prices.spread * 100).toFixed(2)}%`);
  });

  // Callback cuando mercado se invalida
  polyWS.onMarketInvalid((reason) => {
    logger.warn(`[POLY-WS] ❌ Mercado invalidado: ${reason}`);
    activeMarket = null;
    posicionAbierta = false;
  });

  // Buscar mercado inicial y suscribirse vía WebSocket
  try {
    const initialMarket = await polyWS.findBTCMarket();
    if (initialMarket) {
      activeMarket = initialMarket;
      logger.info(`[MARKET] ✓ ${activeMarket.question}`);
    } else {
      logger.warn('[MARKET] ⚠️  No se encontró mercado inicial, se buscará en el siguiente ciclo');
    }
  } catch (err) {
    logger.error(`Error buscando mercado inicial: ${err.message}`);
  }
 
  binanceWS.onPrice(async (priceData) => {
    const sig = signal.process(priceData);
    if (!sig) return;
    if (sig.direction === 'NEUTRAL') return;
 
    const now = Date.now();
    if (now - lastTradeTime < COOLDOWN_MS) return;
 
    logger.info(`[SIGNAL] ${sig.direction} | Move: ${sig.movePct.toFixed(3)}% | Z: ${sig.zScore.toFixed(2)} | Conf: ${sig.confidence}/100`);
 
    // Log del edge calculado
    if (sig.edge) {
      const e = sig.edge;
      logger.info(`[EDGE] fairYes=$${e.fairYes} polyYes=$${e.polyYes} edgePct=${e.edgePct}% | ${e.reason}`);
    }
 
    // Solo operar si hay precio Poly válido Y edge real
    if (!sig.edge || sig.edge.reason === 'NO_POLY_PRICE' || sig.edge.reason === 'POLY_PRICE_STALE') {
      logger.info(`[SKIP] Sin precio Poly válido (${sig.edge?.reason})`);
      return;
    }
    if (!sig.edge.hasEdge) {
      logger.info(`[SKIP] Edge insuficiente (${sig.edge?.edgePct}% < ${config.MIN_EDGE_PCT || 5}% minimo)`);
      return;
    }
 
    // Rechazar edges imposibles — indican precio Poly stale del mercado anterior
    if (Math.abs(sig.edge.edgePct) > MAX_EDGE_PCT) {
      logger.warn(`[SKIP] Edge sospechoso (${sig.edge.edgePct}% > ${MAX_EDGE_PCT}% max) — precio stale`);
      return;
    }
 
    // FIX RACE CONDITION: setear flag ANTES del check
    if (posicionAbierta) {
      logger.info(`[SKIP] Posicion ya abierta, esperando cierre`);
      return;
    }
    posicionAbierta = true;
 
    try {
      if (!activeMarket) {
        activeMarket = await polyWS.findBTCMarket();
        if (!activeMarket) {
          logger.warn('No hay mercado BTC activo en Polymarket');
          posicionAbierta = false;
          return;
        }
        logger.info(`[MARKET] ${activeMarket.question}`);
      }

      // ✅ MEJORA #2: Validar timing de entrada (solo minutos 1-3)
      const windowMinute = getWindowMinute(activeMarket.endDate);
      if (windowMinute < 1 || windowMinute > 3) {
        logger.info(`[SKIP] ⏱️  Fuera de ventana óptima (minuto ${windowMinute}/4) - Solo operamos en minutos 1-3`);
        posicionAbierta = false;
        return;
      }
      logger.info(`[TIMING] ✓ Minuto ${windowMinute}/4 - Ventana óptima`);

      // ✅ MEJORA #3: Validar liquidez del orderbook
      const liquidityCheck = polyWS.checkLiquidity(MIN_LIQUIDITY_USD);
      if (!liquidityCheck.valid) {
        logger.warn(`[SKIP] 💧 Liquidez insuficiente: BID=$${liquidityCheck.bidLiquidity} ASK=$${liquidityCheck.askLiquidity} (min: $${MIN_LIQUIDITY_USD})`);
        posicionAbierta = false;
        return;
      }
      logger.info(`[LIQUIDITY] ✓ BID=$${liquidityCheck.bidLiquidity} ASK=$${liquidityCheck.askLiquidity} | Spread=${(liquidityCheck.spread * 100).toFixed(2)}%`);
 
      const order = buildOrder(sig, activeMarket);
      if (!order) {
        posicionAbierta = false;
        return;
      }
 
      logger.info(`[OPEN] ${order.side === 'BUY' ? 'UP' : 'DOWN'} @ $${order.price} | Edge: ${sig.edge?.edgePct ?? 'n/a'}% | Move: ${sig.movePct.toFixed(3)}%`);
      logger.info(`  Exposure: $${(order.price * order.size).toFixed(2)} | Size: ${order.size} contratos`);
 
      tracker.openPosition({
        marketId: activeMarket.conditionId,
        gammaId: activeMarket.gammaId,
        marketQuestion: activeMarket.question,
        side: order.side,
        price: order.price,
        size: order.size,
        endDate: activeMarket.endDate,
      });
 
      lastTradeTime = now;
      // Liberar posición después de 6 minutos como máximo (mercado ya resuelto)
      setTimeout(() => {
        posicionAbierta = false;
        activeMarket = null;
      }, 6 * 60 * 1000);
 
    } catch (err) {
      logger.error(`Error al operar: ${err.message}`);
      posicionAbierta = false;
      activeMarket = null;
    }
  });
 
  binanceWS.onError((err) => logger.error(`WebSocket error: ${err.message}`));
  binanceWS.onReconnect(() => logger.info('WebSocket reconectado'));
 
  logger.info('Conectando a WebSocket Binance...');
  try {
    await binanceWS.connect();
    logger.info('✓ Conectado al WebSocket Binance');
  } catch (err) {
    logger.error(`No se pudo conectar: ${err.message}`);
    await new Promise(r => setTimeout(r, 10000));
    return main();
  }
 
  // Health check + P&L cada 5 minutos
  setInterval(async () => {
    logger.info('─'.repeat(60));
    logger.info('[HEALTH]');
    
    const stats = signal.getStats();
    logger.info(`  Señales: ${stats.signals}`);
    logger.info(`  Active slots: ${posicionAbierta ? '1' : '0'}/${config.MAX_POSITIONS}`);
    logger.info(``);
    
    await tracker.checkClosedPositions();
    tracker.printSummary();
    
    // Buscar mercado fresco cada ciclo
    activeMarket = null;
    
  }, 5 * 60 * 1000);
 
  process.on('SIGTERM', () => {
    logger.info('SIGTERM recibido, cerrando...');
    tracker.printSummary();
    binanceWS.close();
    polyWS.cleanup();
    process.exit(0);
  });
}
 
function buildOrder(sig, market) {
  const isYesMarket = market.question.toLowerCase().includes('higher') ||
                      market.question.toLowerCase().includes('above') ||
                      market.question.toLowerCase().includes('up') ||
                      market.question.toLowerCase().includes('sube') ||
                      market.question.toLowerCase().includes('arriba');
 
  let side;
  if (sig.direction === 'UP') {
    side = isYesMarket ? 'BUY' : 'SELL';
  } else {
    side = isYesMarket ? 'SELL' : 'BUY';
  }
 
  // Usar precio de Polymarket si lo tenemos, sino usar estimado conservador
  let entryPrice;
  if (sig.edge?.polyYes) {
    entryPrice = side === 'BUY' ? sig.edge.polyYes : (1 - sig.edge.polyYes);
  } else {
    const basePrice = isYesMarket
      ? (sig.direction === 'UP' ? 0.62 : 0.35)
      : (sig.direction === 'UP' ? 0.35 : 0.62);
    const strength = Math.min(sig.zScore / 3, 1);
    entryPrice = side === 'BUY'
      ? Math.max(0.01, basePrice - strength * 0.05)
      : Math.min(0.99, basePrice + strength * 0.05);
  }
 
  entryPrice = parseFloat(entryPrice.toFixed(2));
  const size = Math.floor(config.ORDER_SIZE_USDC / entryPrice);
  if (size < 1) return null;
 
  return {
    marketId: market.conditionId,
    tokenId: market.yesTokenId,
    side,
    price: entryPrice,
    size,
    marketQuestion: market.question,
  };
}
 
main().catch((err) => {
  const logger = new (require('./logger').Logger)('MAIN');
  logger.error(`Fatal error: ${err.message}`);
  setTimeout(() => main(), 10000);
});
