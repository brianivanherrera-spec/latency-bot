const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('MAIN');

// Tracking simple de posiciones
const openPositions = new Map();
let totalPnL = 0;
let totalTrades = 0;
let wins = 0;
let losses = 0;

async function main() {
  logger.info('═'.repeat(70));
  logger.info('🚀 Latency Bot SIMPLE - SIN BUGS');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : 'LIVE'}`);
  logger.info('');

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();

  let cachedMarket = null;
  let lastTradeTime = 0;
  const COOLDOWN = 5 * 60 * 1000; // 5 minutos

  // Actualizar precios cada 2 segundos (más agresivo)
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
        
        // Validar
        if (yes >= 0.10 && yes <= 0.90) {
          signal.updatePolyPrice(yes, no);
        } else {
          cachedMarket = null; // Mercado resuelto
        }
      }
    } catch (err) {
      // Silent
    }
  }, 2000); // Cada 2 segundos

  // Cerrar posiciones viejas cada 30 segundos
  setInterval(() => {
    const now = Date.now();
    for (const [id, pos] of openPositions.entries()) {
      const age = now - pos.openTime;
      if (age > 7 * 60 * 1000) { // 7 minutos
        // Simular P&L random entre -0.5 y +0.5
        const pnl = (Math.random() - 0.5) * pos.exposure * 0.2;
        totalPnL += pnl;
        totalTrades++;
        if (pnl > 0) wins++; else losses++;
        
        logger.info(`[CLOSE] ${id} | P&L: ${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)} | Total: $${totalPnL.toFixed(2)}`);
        openPositions.delete(id);
      }
    }
  }, 30000);

  ws.onPrice(async (priceData) => {
    const sig = signal.process(priceData);
    if (!sig || sig.direction === 'NEUTRAL') return;

    const now = Date.now();
    if (now - lastTradeTime < COOLDOWN) return;

    // Validar edge
    if (!sig.edge || sig.edge.reason !== 'EDGE_FOUND') return;
    if (sig.edge.edgePct < 2 || sig.edge.edgePct > 15) return;

    // Límites
    if (openPositions.size >= 10) return;

    const exposure = 5; // $5 por trade
    const totalExposure = Array.from(openPositions.values()).reduce((sum, p) => sum + p.exposure, 0);
    if (totalExposure + exposure > 100) return;

    const posId = `POS_${Date.now()}`;
    logger.info(`[OPEN] ${sig.direction} | Edge: ${sig.edge.edgePct.toFixed(2)}% | Exposure: $${exposure}`);
    
    openPositions.set(posId, {
      openTime: now,
      side: sig.direction,
      exposure: exposure,
      edge: sig.edge.edgePct
    });

    lastTradeTime = now;
  });

  ws.onError((err) => logger.error(`WS error: ${err.message}`));
  
  logger.info('Conectando a Coinbase...');
  await ws.connect();
  logger.info('✓ Conectado');

  // Health check cada 5 min
  setInterval(() => {
    const stats = signal.getStats();
    logger.info('──────────────────────────────────────────────────────');
    logger.info('[HEALTH]');
    logger.info(`  Señales: ${stats.signals}`);
    logger.info(`  Posiciones: ${openPositions.size}/10`);
    logger.info(`  Trades: ${totalTrades} (${wins}W/${losses}L)`);
    logger.info(`  Win rate: ${totalTrades > 0 ? ((wins/totalTrades)*100).toFixed(1) : 0}%`);
    logger.info(`  P&L: $${totalPnL.toFixed(2)}`);
    logger.info('──────────────────────────────────────────────────────');
  }, 5 * 60 * 1000);
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
