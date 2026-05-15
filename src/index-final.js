/**
 * LATENCY BOT - VERSIÓN FINAL
 * ✅ SignalEngine + PnLTracker + Cooldown + Ejecución real
 */

const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('MAIN');

const tracker = new PnLTracker();
const activePositions = new Map();

let lastTradeTime = 0;
const COOLDOWN = 3 * 60 * 1000; // 3 MINUTOS

async function main() {
  logger.info('═'.repeat(70));
  logger.info('🎯 LATENCY BOT - Versión Final');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : 'LIVE 🔴'}`);
  logger.info('Cooldown: 3 minutos entre trades');
  logger.info('');

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();

  let cachedMarket = null;
  let lastPolyLog = ''; // ✅ Evitar logs repetidos de precio

  async function actualizarPrecioPolymarket() {
    if (!cachedMarket?.gammaId) {
      const m = await poly.findBTCMarket();
      if (m) {
        cachedMarket = m;
        logger.info(`[POLY] Mercado: ${m.question}`);
        logger.info(`[POLY] yesToken: ${m.yesTokenId}`);
        logger.info(`[POLY] noToken: ${m.noTokenId}`);
      } else {
        return;
      }
    }
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets/${cachedMarket.gammaId}`);
      if (!res.ok) {
        logger.warn(`[POLY] Gamma API error: ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.outcomePrices) {
        const prices = typeof data.outcomePrices === 'string'
          ? JSON.parse(data.outcomePrices)
          : data.outcomePrices;
        const yes = parseFloat(prices[0]);
        const no = parseFloat(prices[1]);
        if (yes >= 0.05 && yes <= 0.95) {
          signal.updatePolyPrice(yes, no);
          // ✅ Solo loggear si el precio cambió
          const logLine = `YES=${yes.toFixed(3)} NO=${no.toFixed(3)}`;
          if (logLine !== lastPolyLog) {
            logger.info(`[POLY] ${logLine}`);
            lastPolyLog = logLine;
          }
        } else {
          logger.info(`[POLY] Mercado resuelto (YES=${yes}), buscando nuevo...`);
          cachedMarket = null;
          lastPolyLog = '';
        }
      }
    } catch (err) {
      logger.warn(`[POLY] Error actualizando precio: ${err.message}`);
    }
  }

  logger.info('[POLY] Obteniendo precio inicial...');
  await actualizarPrecioPolymarket();

  setInterval(actualizarPrecioPolymarket, 2000);

  setInterval(async () => {
    await tracker.checkClosedPositions();
  }, 60000);

  ws.onPrice(async (priceData) => {
    const sig = signal.process(priceData);
    if (!sig || sig.direction === 'NEUTRAL') return;

    const now = Date.now();

    // ✅ COOLDOWN: bloquea múltiples entradas
    if (now - lastTradeTime < COOLDOWN) return;

    if (!sig.edge || sig.edge.reason !== 'EDGE_FOUND') return;
    if (sig.edge.edgePct < 3 || sig.edge.edgePct > 15) return;

    if (activePositions.size >= 10) return;

    const exposure = 5;
    const totalExposure = Array.from(activePositions.values())
      .reduce((sum, p) => sum + p.exposure, 0);
    if (totalExposure + exposure > 100) return;

    if (!cachedMarket?.gammaId) {
      logger.warn('[SKIP] No hay mercado disponible');
      return;
    }

    const marketEnd = new Date(cachedMarket.endDate).getTime();
    const msRestantes = marketEnd - now;
    const segsRestantes = Math.floor(msRestantes / 1000);

    if (msRestantes <= 0) {
      logger.warn(`[SKIP] ⏱️ Mercado YA CERRADO hace ${Math.abs(segsRestantes)}s`);
      cachedMarket = null;
      return;
    }

    if (segsRestantes < 60) {
      logger.warn(`[SKIP] ⏱️ Solo ${segsRestantes}s restantes — muy tarde`);
      return;
    }

    logger.info(`[TIMING] ✅ ${segsRestantes}s restantes — OK para entrar`);

    const side = sig.direction === 'UP' ? 'BUY' : 'SELL';
    const price = sig.direction === 'UP' ? sig.edge.polyYes : sig.edge.polyNo;
    const tokenId = sig.direction === 'UP' ? cachedMarket.yesTokenId : cachedMarket.noTokenId;
    const size = Math.floor(exposure / price);

    if (size < 1) {
      logger.warn('[SKIP] Size < 1, precio demasiado alto');
      return;
    }

    logger.info(`[OPEN] ${sig.direction} @ $${price.toFixed(3)} | Edge: ${sig.edge.edgePct.toFixed(2)}% | Move: ${sig.movePct.toFixed(3)}%`);
    logger.info(`  Exposure: $${exposure.toFixed(2)} | Size: ${size} contratos | Token: ${tokenId}`);

    // ✅ FIX COOLDOWN: actualizar ANTES de ejecutar
    // Así si la orden falla no reintenta en el mismo segundo
    lastTradeTime = now;
    const posId = `POS_${Date.now()}`;
    activePositions.set(posId, { exposure, openTime: now });

    // Ejecutar orden real en Polymarket (solo en LIVE)
    if (!config.DRY_RUN) {
      try {
        const orderResult = await poly.placeLimitOrder({
          marketId: cachedMarket.conditionId,
          tokenId: tokenId,
          side: 'BUY',
          price: price,
          size: size,
          marketQuestion: cachedMarket.question,
        });

        if (!orderResult.success) {
          logger.error(`[LIVE] ❌ Orden fallida: ${orderResult.error}`);
          activePositions.delete(posId); // Liberar slot
          return;
        }

        logger.info(`[LIVE] ✅ Orden colocada en Polymarket: ${orderResult.orderId}`);

      } catch (err) {
        logger.error(`[LIVE] ❌ Error ejecutando orden: ${err.message}`);
        activePositions.delete(posId);
        return;
      }
    }

    // Registrar en tracker solo si la orden fue exitosa (o es paper trading)
    tracker.openPosition({
      marketId: cachedMarket.conditionId,
      gammaId: cachedMarket.gammaId,
      marketQuestion: cachedMarket.question,
      side: side,
      price: price,
      size: size,
      endDate: cachedMarket.endDate
    });

    // Liberar slot después de 8 minutos
    setTimeout(() => {
      activePositions.delete(posId);
    }, 8 * 60 * 1000);
  });

  ws.onError((err) => logger.error(`WS error: ${err.message}`));

  logger.info('Conectando a Coinbase WebSocket...');
  await ws.connect();
  logger.info('✓ Conectado\n');

  // Health check cada 5 minutos
  setInterval(() => {
    const stats = tracker.getSummary();
    const sigStats = signal.getStats();

    logger.info('─'.repeat(60));
    logger.info('[HEALTH]');
    logger.info(`  Señales: ${sigStats.signals}`);
    logger.info(`  Active slots: ${activePositions.size}/10`);
    logger.info(`  Cooldown restante: ${Math.max(0, Math.ceil((lastTradeTime + COOLDOWN - Date.now()) / 1000))}s`);
    logger.info('');
    logger.info('=== P&L TRACKER (REAL Polymarket) ===');
    logger.info(`  Open: ${stats.openPositions} | Closed: ${stats.closedPositions}`);
    logger.info(`  Wins: ${stats.wins} | Losses: ${stats.losses}`);
    logger.info(`  Win Rate: ${stats.winRate}`);
    logger.info(`  Total P&L: ${stats.totalPnL}`);
    logger.info('─'.repeat(60));
  }, 5 * 60 * 1000);
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
