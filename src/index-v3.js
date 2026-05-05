const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { RiskManager } = require('./risk-manager');
const { Logger } = require('./logger');
const config = require('./config');
 
const logger = new Logger('MAIN');
 
// Fetch precio actual de Polymarket para el mercado activo
async function fetchPolyPrice(gammaId) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets/${gammaId}`);
    if (!res.ok) return null;
    const m = await res.json();
 
    // outcomePrices: '["0.62","0.38"]' => [yesPrice, noPrice]
    if (m.outcomePrices) {
      const prices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices;
      return {
        yes: parseFloat(prices[0]),
        no: parseFloat(prices[1]),
      };
    }
 
    // Fallback: tokens array
    if (m.tokens && Array.isArray(m.tokens)) {
      const yes = m.tokens.find(t => t.outcome === 'Yes' || t.outcome === 'YES');
      const no  = m.tokens.find(t => t.outcome === 'No'  || t.outcome === 'NO');
      if (yes && no) {
        return {
          yes: parseFloat(yes.price || yes.lastTradePrice || 0.5),
          no:  parseFloat(no.price  || no.lastTradePrice  || 0.5),
        };
      }
    }
 
    return null;
  } catch (err) {
    logger.warn(`fetchPolyPrice error: ${err.message}`);
    return null;
  }
}
 
async function main() {
  logger.info('═'.repeat(70));
  logger.info('🚀 Latency Bot v3.0 - VERSIÓN ESTABLE');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : '⚠️  LIVE TRADING'}`);
  logger.info('');

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();
  const tracker = new PnLTracker();
  const risk = new RiskManager();
 
  let activeMarket = null;
  let cachedMarket = null; // persiste entre trades para mantener precio Poly fresco
  let lastTradeTime = 0;
  let posicionAbierta = false; // flag para evitar doble entrada simultánea
  const COOLDOWN_MS = config.COOLDOWN_SECONDS * 1000;
  const MAX_EDGE_PCT = 50; // edge máximo realista — si es mayor, el precio Poly es stale
 
  // === Actualizar precio de Polymarket cada 5 segundos ===
  // Usa cachedMarket (persiste entre trades) para no quedar stale
  setInterval(async () => {
    if (!cachedMarket?.gammaId) {
      const m = await poly.findBTCMarket();
      if (m) {
        cachedMarket = m;
        logger.info('[POLY] Mercado cacheado: ' + m.question);
      }
      return;
    }
    const prices = await fetchPolyPrice(cachedMarket.gammaId);
    if (prices) {
      // Si el mercado está resuelto (precios extremos 0/1), invalidar y buscar uno nuevo
      const resuelto = (prices.yes === 0 && prices.no === 1) || (prices.yes === 1 && prices.no === 0);
      if (resuelto) {
        logger.info('[POLY] Mercado resuelto/cerrado, buscando uno nuevo...');
        cachedMarket = null;
        return;
      }
      // Precio válido = entre 0.10 y 0.90 (mercado activo con liquidez real)
      const precioValido = prices.yes >= 0.10 && prices.yes <= 0.90;
      if (!precioValido) {
        logger.warn(`[POLY] Precio dudoso (YES=${prices.yes}), ignorando...`);
        return;
      }
      signal.updatePolyPrice(prices.yes, prices.no);
      logger.info(`[POLY] YES=${prices.yes} NO=${prices.no} (mercado: ${cachedMarket.question?.slice(0, 40)})`);
    }
  }, 5000);
 
  ws.onPrice(async (priceData) => {
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
 
    // Fix: rechazar edges imposibles — indican precio Poly stale del mercado anterior
    const MAX_EDGE = config.MAX_REALISTIC_EDGE || 15;
    if (Math.abs(sig.edge.edgePct) > MAX_EDGE) {
      logger.warn(`[SKIP] Edge sospechoso (${sig.edge.edgePct}% > ${MAX_EDGE}% max) — precio stale`);
      return;
    }

    // Validar con risk manager
    const edgeValidation = risk.validateEdge(sig.edge.edgePct);
    if (!edgeValidation.valid) {
      logger.warn(`[SKIP] ${edgeValidation.reason}: ${edgeValidation.message || ''}`);
      return;
    }

    const canOpen = risk.canOpenPosition(config.ORDER_SIZE_USDC || 5);
    if (!canOpen.allowed) {
      logger.warn(`[SKIP] ${canOpen.reason}`);
      return;
    }
 
    // FIX RACE CONDITION: setear flag ANTES del check, no después
    // Así dos ticks que llegan con milisegundos de diferencia no pasan ambos
    if (posicionAbierta) {
      logger.info(`[SKIP] Posicion ya abierta, esperando cierre`);
      return;
    }
    posicionAbierta = true; // <-- MOVIDO AQUÍ, antes del try
 
    try {
      if (!activeMarket) {
        activeMarket = await poly.findBTCMarket();
        if (!activeMarket) {
          logger.warn('No hay mercado BTC activo en Polymarket');
          posicionAbierta = false; // liberar si no hay mercado
          return;
        }
        logger.info(`[MARKET] ${activeMarket.question}`);
      }
 
      const order = buildOrder(sig, activeMarket);
      if (!order) {
        posicionAbierta = false; // liberar si no hay orden válida
        return;
      }
 
      logger.info(`[ORDER] ${order.side} | Price: $${order.price} | Size: ${order.size} | USDC: $${(order.price * order.size).toFixed(2)} | Edge: ${sig.edge?.edgePct ?? 'n/a'}%`);

      const positionId = `POS_${Date.now()}`;
      const exposure = order.price * order.size;

      // Registrar en tracker (viejo sistema)
      tracker.openPosition({
        id: positionId,
        marketId: activeMarket.conditionId,
        gammaId: activeMarket.gammaId,
        marketQuestion: activeMarket.question,
        side: order.side,
        price: order.price,
        size: order.size,
        endDate: activeMarket.endDate,
      });

      // Registrar en risk manager (nuevo sistema)
      risk.openPosition(positionId, {
        side: order.side,
        size: order.size,
        price: order.price,
        exposure: exposure,
        market: activeMarket.question,
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
 
  ws.onError((err) => logger.error(`WebSocket error: ${err.message}`));
  ws.onReconnect(() => logger.info('WebSocket reconectado'));
 
  logger.info('Conectando a WebSocket Coinbase...');
  try {
    await ws.connect();
    logger.info('Conectado al WebSocket');
  } catch (err) {
    logger.error(`No se pudo conectar: ${err.message}`);
    await new Promise(r => setTimeout(r, 10000));
    return main();
  }
 
  // Health check + P&L cada 5 minutos
  setInterval(async () => {
    activeMarket = null; // forzar mercado fresco cada ciclo
 
    const stats = signal.getStats();
    logger.info('──────────────────────────────────────────────────────────────────────');
    logger.info('[HEALTH CHECK]');
    logger.info(`  WS Coinbase: ${ws.isConnected() ? '✓ OK' : '❌ DOWN'}`);
    logger.info(`  Ticks procesados: ${stats.ticks}`);
    logger.info(`  Señales generadas: ${stats.signals}`);
    logger.info(`  Precio Poly YES: ${stats.polyYes || 'N/A'} (${stats.polyAge || 'never'})`);
    logger.info(`  Último precio BTC: $${priceData?.price || 'N/A'}`);
    logger.info('');
 
    await tracker.checkClosedPositions();
    tracker.printSummary();
    risk.printSummary();
  }, 5 * 60 * 1000);
 
  process.on('SIGTERM', () => {
    logger.info('SIGTERM recibido, cerrando...');
    tracker.printSummary();
    ws.close();
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
