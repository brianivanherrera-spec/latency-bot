/**
 * LATENCY BOT - BTC 5min Polymarket
 * Estrategia: Binance WebSocket → señal matemática → limit orders Polymarket
 * Sin Claude API = costo $0 en inferencia
 */

const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('MAIN');

async function main() {
  logger.info('🚀 Latency Bot iniciando...');
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING (DRY RUN)' : '⚠️  LIVE TRADING'}`);

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();

  // Estado del bot
  let activeMarket = null;
  let lastTradeTime = 0;
  const COOLDOWN_MS = config.COOLDOWN_SECONDS * 1000;

  // Callback: cada tick de precio BTC
  ws.onPrice(async (priceData) => {
    const sig = signal.process(priceData);

    if (!sig) return; // sin señal todavía

    const now = Date.now();
    if (now - lastTradeTime < COOLDOWN_MS) return; // cooldown activo

    if (sig.direction !== 'NEUTRAL') {
      logger.info(`📊 Señal: ${sig.direction} | Move: ${sig.movePct.toFixed(3)}% | Z: ${sig.zScore.toFixed(2)}`);

      try {
        // Buscar mercado BTC 5min activo en Polymarket
        if (!activeMarket) {
          activeMarket = await poly.findBTCMarket();
          if (!activeMarket) {
            logger.warn('No hay mercado BTC 5min activo en Polymarket');
            return;
          }
          logger.info(`🎯 Mercado: ${activeMarket.question}`);
        }

        // Calcular precio limite basado en señal
        const order = buildOrder(sig, activeMarket);
        if (!order) return;

        logger.info(`📝 Orden: ${order.side} | Price: ${order.price} | Size: ${order.size}`);

        const result = await poly.placeLimitOrder(order);
        if (result.success) {
          logger.info(`✅ Orden colocada: ${result.orderId}`);
          lastTradeTime = now;
          // Resetear mercado para próxima búsqueda (expira cada 5min)
          setTimeout(() => { activeMarket = null; }, 5 * 60 * 1000);
        }
      } catch (err) {
        logger.error(`Error al operar: ${err.message}`);
        activeMarket = null; // resetear en error
      }
    }
  });

  ws.onError((err) => {
    logger.error(`WebSocket error: ${err.message}`);
  });

  ws.onReconnect(() => {
    logger.info('🔄 WebSocket reconectado');
  });

  // Iniciar WebSocket
  await ws.connect();
  logger.info('✅ Conectado a Binance WebSocket');

  // Health check log cada 5 min
  setInterval(() => {
    const stats = signal.getStats();
    logger.info(`💓 Health | Ticks: ${stats.ticks} | Señales: ${stats.signals} | WS: ${ws.isConnected() ? 'OK' : 'DOWN'}`);
  }, 5 * 60 * 1000);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM recibido, cerrando...');
    ws.close();
    process.exit(0);
  });
}

function buildOrder(signal, market) {
  // Mapear dirección de señal a lado de apuesta en Polymarket
  // Si BTC sube fuerte → apostar YES en "Will BTC be higher in 5min?"
  const isYesMarket = market.question.toLowerCase().includes('higher') ||
                      market.question.toLowerCase().includes('above') ||
                      market.question.toLowerCase().includes('up');

  let side;
  if (signal.direction === 'UP') {
    side = isYesMarket ? 'BUY' : 'SELL'; // YES token
  } else {
    side = isYesMarket ? 'SELL' : 'BUY'; // NO token
  }

  // Precio limit con ventaja basada en fuerza de señal
  const basePrice = isYesMarket
    ? (signal.direction === 'UP' ? 0.62 : 0.35)
    : (signal.direction === 'UP' ? 0.35 : 0.62);

  // Ajustar por fuerza de señal (z-score)
  const strength = Math.min(signal.zScore / 3, 1); // normalizar 0-1
  const priceAdj = strength * 0.05; // hasta 5 centavos de ajuste
  const finalPrice = side === 'BUY'
    ? Math.max(0.01, basePrice - priceAdj) // comprar más barato
    : Math.min(0.99, basePrice + priceAdj); // vender más caro

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
  console.error('Fatal error:', err);
  process.exit(1);
});
