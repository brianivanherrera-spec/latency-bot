/**
 * LATENCY BOT - VERSIÓN FINAL
 * 
 * Combina LO MEJOR de todas las versiones:
 * ✅ SignalEngine (detección correcta UP/DOWN)
 * ✅ PnLTracker (P&L real de Polymarket)
 * ✅ Cooldown 3 minutos (evita múltiples entradas)
 * ✅ Límites de risk
 */

const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { TradeFilters } = require('./filters');
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('MAIN');

// Tracking con PnLTracker + límites de risk
const tracker = new PnLTracker();
const activePositions = new Map(); // Solo para límites

// Cooldown y control
let lastTradeTime = 0;
const COOLDOWN = 3 * 60 * 1000; // 3 MINUTOS

async function main() {
  logger.info('═'.repeat(70));
  logger.info('🎯 LATENCY BOT - Versión Final + Filtros Optimizados');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : 'LIVE'}`);
  logger.info('Cooldown: 3 minutos entre trades');
  logger.info('');
  logger.info('🛡️  FILTROS ACTIVOS:');
  logger.info('  • Edge mínimo: 5% (UP) / 6% (DOWN)');
  logger.info('  • Movimiento mínimo: 0.05%');
  logger.info('  • Edge máximo: 15% (anti-anomalías)');
  logger.info('');

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();
  const filters = new TradeFilters();

  let cachedMarket = null;

  // === Actualizar precios Polymarket cada 2 segundos ===
  setInterval(async () => {
    if (!cachedMarket?.gammaId) {
      const m = await poly.findBTCMarket();
      if (m) {
        cachedMarket = m;
        logger.info(`[POLY] Mercado: ${m.question}`);
      }
      return;
    }

    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets/${cachedMarket.gammaId}`);
      const data = await res.json();
      
      if (data.outcomePrices) {
        const prices = typeof data.outcomePrices === 'string'
          ? JSON.parse(data.outcomePrices)
          : data.outcomePrices;
        
        const yes = parseFloat(prices[0]);
        const no = parseFloat(prices[1]);
        
        // Validar precio razonable
        if (yes >= 0.05 && yes <= 0.95) {
          signal.updatePolyPrice(yes, no);
        } else {
          // Mercado resuelto/cerrado
          cachedMarket = null;
        }
      }
    } catch (err) {
      // Silent
    }
  }, 2000);

  // === Verificar posiciones cerradas cada minuto ===
  setInterval(async () => {
    await tracker.checkClosedPositions();
  }, 60000);

  // === WebSocket Coinbase ===
  ws.onPrice(async (priceData) => {
    // Procesar señal con SignalEngine
    const sig = signal.process(priceData);
    if (!sig || sig.direction === 'NEUTRAL') return;

    const now = Date.now();
    
    // COOLDOWN: evitar múltiples entradas
    if (now - lastTradeTime < COOLDOWN) return;

    // Validar edge
    if (!sig.edge || sig.edge.reason !== 'EDGE_FOUND') return;
    if (sig.edge.edgePct < 3 || sig.edge.edgePct > 15) return;

    // === FILTROS DE TRADING ===
    const filterResult = filters.evaluate(sig);
    if (!filterResult.pass) {
      // Trade rechazado por filtros - el filtro ya loggeó la razón
      return;
    }

    // Límites de risk
    if (activePositions.size >= 10) return;
    
    const exposure = 5; // $5 por trade
    const totalExposure = Array.from(activePositions.values())
      .reduce((sum, p) => sum + p.exposure, 0);
    if (totalExposure + exposure > 100) return;

    // Validar que tenemos mercado
    if (!cachedMarket?.gammaId) {
      logger.warn('[SKIP] No hay mercado disponible');
      return;
    }

    // === ABRIR POSICIÓN ===
    const side = sig.direction === 'UP' ? 'BUY' : 'SELL';
    const price = sig.direction === 'UP' ? sig.edge.polyYes : sig.edge.polyNo;
    const size = Math.floor(exposure / price);

    // Registrar en PnLTracker (consultará Polymarket para resultado real)
    tracker.openPosition({
      marketId: cachedMarket.conditionId,
      gammaId: cachedMarket.gammaId,
      marketQuestion: cachedMarket.question,
      side: side,
      price: price,
      size: size,
      endDate: cachedMarket.endDate
    });

    logger.info(`[OPEN] ${sig.direction} @ $${price.toFixed(3)} | Edge: ${sig.edge.edgePct.toFixed(2)}% | Move: ${sig.movePct.toFixed(3)}%`);
    logger.info(`  Exposure: $${exposure.toFixed(2)} | Size: ${size} contratos`);

    // Actualizar control
    const posId = `POS_${Date.now()}`;
    activePositions.set(posId, { exposure, openTime: now });
    lastTradeTime = now;

    // Liberar slot después de 8 minutos
    setTimeout(() => {
      activePositions.delete(posId);
    }, 8 * 60 * 1000);
  });

  ws.onError((err) => logger.error(`WS error: ${err.message}`));

  logger.info('Conectando a Coinbase WebSocket...');
  await ws.connect();
  logger.info('✓ Conectado\n');

  // === Health check cada 5 minutos ===
  setInterval(() => {
    const stats = tracker.getSummary();
    const sigStats = signal.getStats();
    const filterStats = filters.getStats();
    
    logger.info('─'.repeat(60));
    logger.info('[HEALTH]');
    logger.info(`  Señales: ${sigStats.signals}`);
    logger.info(`  Active slots: ${activePositions.size}/10`);
    logger.info('');
    logger.info('=== FILTROS ===');
    logger.info(`  Evaluados: ${filterStats.total}`);
    logger.info(`  Aprobados: ${filterStats.passed} (${filterStats.passRate})`);
    logger.info(`  Rechazados: ${filterStats.rejected}`);
    logger.info(`    - Edge bajo: ${filterStats.rejectionReasons.edge}`);
    logger.info(`    - Move chico: ${filterStats.rejectionReasons.move}`);
    logger.info(`    - Edge alto: ${filterStats.rejectionReasons.edgeMax}`);
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
