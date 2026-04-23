const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('MAIN');

async function main() {
  logger.info('🚀 Latency Bot iniciando...');
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING (DRY RUN)' : '⚠️  LIVE TRADING'}`);

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();
  const tracker = new PnLTracker();

  let activeMarket = null;
  let lastTradeTime = 0;
  const COOLDOWN_MS = config.COOLDOWN_SECONDS * 1000;

  ws.onPrice(async (priceData) => {
    const sig = signal.process(priceData);
    if (!sig) return;

    const now = Date.now();
    if (now - lastTradeTime < COOLDOWN_MS) return;

    if (sig.direction !== 'NEUTRAL') {
      logger.info(`📊 Señal: ${sig.direction} | Move: ${sig.movePct.toFixed(3)}% | Z: ${sig.zScore.toFixed(2)} | Confianza: ${sig.confidence}/100`);

      try {
        if (!activeMarket) {
          activeMarket = await poly.findBTCMarket();
          if (!activeMarket) {
            logger.warn('No hay mercado BTC activo en Polymarket');
            return;
          }
          logger.info(`🎯 Mercado: ${activeMarket.question}`);
        }

        const order = buildOrder(sig, activeMarket);
        if (!order) return;

        logger.info(`📝 Orden simulada: ${order.side} | Price: $${order.price} | Size: ${order.size} | USDC: $${(order.price * order.size).toFixed(2)}`);

        // Registrar en tracker
        tracker.openPosition({
          marketId: activeMarket.conditionId,
          marketQuestion: activeMarket.question,
          side: order.side,
          price: order.price,
          size: order.size,
          endDate: activeMarket.endDate,
        });

        lastTradeTime = now;
        setTimeout(() => { activeMarket = null; }, 4 * 60 * 1000);

      } catch (err) {
        logger.error(`Error al operar: ${err.message}`);
        activeMarket = null;
      }
    }
  });

  ws.onError((err) => {
    logger.error(`WebSocket error: ${err.message}`);
  });

  ws.onReconnect(() => {
    logger.info('🔄 WebSocket reconectado');
  });

  logger.info('Conectando a WebSocket...');

  try {
    await ws.connect();
    logger.info('✅ Conectado al WebSocket');
  } catch (err) {
    logger.error(`No se pudo conectar: ${err.message}`);
    logger.info('Reintentando en 10 segundos...');
    await new Promise(r => setTimeout(r, 10000));
    return main();
  }

  // Health check + P&L cada 5 minutos
  setInterval(async () => {
    activeMarket = null; // forzar búsqueda de mercado fresco cada ciclo
    const stats = signal.getStats();
    logger.info(`💓 Health | Ticks: ${stats.ticks} | Señales: ${stats.signals} | WS: ${ws.isConnected() ? 'OK' : 'DOWN'}`);

    // Chequear si hay posiciones cerradas para calcular P&L
    await tracker.checkClosedPositions();
    tracker.printSummary();
  }, 5 * 60 * 1000);

  process.on('SIGTERM', () => {
    logger.info('SIGTERM recibido, cerrando...');
    tracker.printSummary();
    ws.close();
    process.exit(0);
  });
}

function buildOrder(signal, market) {
const isYesMarket = market.question.toLowerCase().includes('higher') ||
                    market.question.toLowerCase().includes('above') ||
                    market.question.toLowerCase().includes('up') ||
                    market.question.toLowerCase().includes('sube') ||
                    market.question.toLowerCase().includes('arriba');

  let side;
  if (signal.direction === 'UP') {
    side = isYesMarket ? 'BUY' : 'SELL';
  } else {
    side = isYesMarket ? 'SELL' : 'BUY';
  }

  const basePrice = isYesMarket
    ? (signal.direction === 'UP' ? 0.62 : 0.35)
    : (signal.direction === 'UP' ? 0.35 : 0.62);

  const strength = Math.min(signal.zScore / 3, 1);
  const priceAdj = strength * 0.05;
  const finalPrice = side === 'BUY'
    ? Math.max(0.01, basePrice - priceAdj)
    : Math.min(0.99, basePrice + priceAdj);

  const size = Math.floor(config.ORDER_SIZE_USDC / finalPrice);
  if (size < 1) return null;

  return {
    marketId: market.conditionId,
    tokenId: market.yesTokenId,
    side,
    price: parseFloat(finalPrice.toFixed(2)),
    size,
    marketQuestion: market.question,
  };
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  setTimeout(() => main(), 10000);
});
