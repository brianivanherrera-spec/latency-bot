const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
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
  logger.info('Latency Bot iniciando...');
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING (DRY RUN)' : 'LIVE TRADING'}`);

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();
  const tracker = new PnLTracker();

  let activeMarket = null;
  let cachedMarket = null; // persiste entre trades para mantener precio Poly fresco
  let lastTradeTime = 0;
  const COOLDOWN_MS = config.COOLDOWN_SECONDS * 1000;

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
      signal.updatePolyPrice(prices.yes, prices.no);
      logger.info(`[POLY] YES=$${prices.yes} NO=$${prices.no} (mercado: ${cachedMarket.question?.slice(0, 40)})`);
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

    // Solo operar si hay edge real (o si no tenemos precio de Poly todavia → usar señal pura)
    const edgeOk = !sig.edge || sig.edge.hasEdge || sig.edge.reason === 'NO_POLY_PRICE';
    if (!edgeOk) {
      logger.info(`[SKIP] Edge insuficiente (${sig.edge?.edgePct}% < ${config.MIN_EDGE_PCT || 5}% minimo)`);
      return;
    }

    try {
      if (!activeMarket) {
        activeMarket = await poly.findBTCMarket();
        if (!activeMarket) {
          logger.warn('No hay mercado BTC activo en Polymarket');
          return;
        }
        logger.info(`[MARKET] ${activeMarket.question}`);
      }

      const order = buildOrder(sig, activeMarket);
      if (!order) return;

      logger.info(`[ORDER] ${order.side} | Price: $${order.price} | Size: ${order.size} | USDC: $${(order.price * order.size).toFixed(2)} | Edge: ${sig.edge?.edgePct ?? 'n/a'}%`);

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
      setTimeout(() => { activeMarket = null; }, 4 * 60 * 1000);

    } catch (err) {
      logger.error(`Error al operar: ${err.message}`);
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
    logger.info(`[HEALTH] Ticks: ${stats.ticks} | Senales: ${stats.signals} | WS: ${ws.isConnected() ? 'OK' : 'DOWN'} | polyYes: ${stats.polyYes} (${stats.polyAge} ago)`);

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
