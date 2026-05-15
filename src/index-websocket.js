/**
 * LATENCY BOT - VERSIÓN WEBSOCKET
 * 
 * ✅ WebSocket de Polymarket CLOB (latencia <100ms vs 2-5 segundos HTTP)
 * ✅ Bloqueo estricto de mercados resueltos (precios 0 o 1)
 * ✅ Validación de precios stale (máx 3 segundos)
 * ✅ SignalEngine + PnLTracker
 * ✅ Cooldown 3 minutos
 */

const { BinanceWS } = require('./binance');
const { SignalEngine } = require('./signal');
const { PolymarketWebSocketClient } = require('./polymarket-ws');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('MAIN');

// Tracking
const tracker = new PnLTracker();
const activePositions = new Map();

// Cooldown
let lastTradeTime = 0;
const COOLDOWN = config.COOLDOWN_SECONDS * 1000 || 180000; // 3 minutos default

async function main() {
  logger.info('═'.repeat(70));
  logger.info('🎯 LATENCY BOT - WebSocket Edition');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : 'LIVE'}`);
  logger.info(`Cooldown: ${COOLDOWN / 1000}s entre trades`);
  logger.info('');

  const signal = new SignalEngine();
  const polyWs = new PolymarketWebSocketClient();
  const btcWs = new BinanceWS();

  let currentMarket = null;
  let polyPriceValid = false;

  // === Callback: Actualización de precio en tiempo real ===
  polyWs.onPriceUpdate((priceData) => {
    const { yes, no, timestamp, spread } = priceData;
    
    // CRÍTICO: Bloquear precios resueltos (0 o 1)
    if (yes === 0 || yes === 1 || no === 0 || no === 1) {
      logger.warn(`⚠️  Precio resuelto detectado: YES=${yes} NO=${no} - BLOQUEANDO`);
      polyPriceValid = false;
      currentMarket = null; // Invalidar mercado
      return;
    }
    
    // Validar rango razonable
    if (yes < 0.05 || yes > 0.95) {
      logger.warn(`⚠️  Precio fuera de rango: YES=${yes} - BLOQUEANDO`);
      polyPriceValid = false;
      return;
    }
    
    // Actualizar signal engine
    signal.updatePolyPrice(yes, no);
    polyPriceValid = true;
    
    logger.debug(`📊 Poly WS: YES=${yes.toFixed(3)} NO=${no.toFixed(3)} | Spread=${(spread * 100).toFixed(2)}%`);
  });

  // === Callback: Mercado invalidado ===
  polyWs.onMarketInvalid((reason) => {
    logger.warn(`❌ Mercado invalidado: ${reason}`);
    polyPriceValid = false;
    currentMarket = null;
  });

  // === Buscar mercado inicial ===
  logger.info('Buscando mercado BTC activo...');
  currentMarket = await polyWs.findBTCMarket();
  
  if (currentMarket) {
    logger.info(`✓ Mercado encontrado: ${currentMarket.question}`);
    logger.info(`  Token ID: ${currentMarket.yesTokenId}`);
  } else {
    logger.warn('⚠️  No se encontró mercado activo');
  }

  // === Renovar mercado cada 4 minutos (antes de que cierre a los 5 min) ===
  setInterval(async () => {
    logger.info('🔄 Renovando mercado...');
    const newMarket = await polyWs.findBTCMarket();
    
    if (newMarket && newMarket.conditionId !== currentMarket?.conditionId) {
      logger.info(`✓ Nuevo mercado: ${newMarket.question}`);
      currentMarket = newMarket;
      polyPriceValid = false; // Esperar primer precio válido
    }
  }, 4 * 60 * 1000);

  // === Verificar posiciones cerradas ===
  setInterval(async () => {
    await tracker.checkClosedPositions();
  }, 60000);

  // === WebSocket BTC: Procesar señales ===
  btcWs.onPrice(async (priceData) => {
    // Procesar señal
    const sig = signal.process(priceData);
    if (!sig || sig.direction === 'NEUTRAL') return;

    const now = Date.now();
    
    // VALIDACIONES PRE-TRADE
    
    // 1. Cooldown
    if (now - lastTradeTime < COOLDOWN) return;

    // 2. Validar que tenemos mercado activo
    if (!currentMarket?.gammaId) {
      logger.warn('[SKIP] No hay mercado disponible');
      return;
    }

    // 3. Validar precio Polymarket válido y fresco
    if (!polyPriceValid) {
      logger.warn('[SKIP] Sin precio Poly válido');
      return;
    }
    
    const polyPrice = polyWs.getCurrentPrice();
    if (!polyPrice.valid) {
      logger.warn(`[SKIP] Precio Poly stale: ${polyPrice.reason}`);
      return;
    }

    // 4. Validar edge
    if (!sig.edge || sig.edge.reason !== 'EDGE_FOUND') return;
    
    const minEdge = config.MIN_EDGE_PCT || 3;
    if (sig.edge.edgePct < minEdge || sig.edge.edgePct > 15) {
      logger.debug(`[SKIP] Edge fuera de rango: ${sig.edge.edgePct.toFixed(2)}%`);
      return;
    }

    // 5. Validar liquidez del orderbook
    const liquidity = polyWs.checkLiquidity(15); // Mínimo $15
    if (!liquidity.valid) {
      logger.warn(`[SKIP] Liquidez insuficiente: ${liquidity.reason}`);
      return;
    }

    // 6. Límites de risk
    if (activePositions.size >= 10) {
      logger.warn('[SKIP] Max posiciones activas (10)');
      return;
    }
    
    const exposure = 5; // $5 por trade
    const totalExposure = Array.from(activePositions.values())
      .reduce((sum, p) => sum + p.exposure, 0);
    
    if (totalExposure + exposure > 100) {
      logger.warn('[SKIP] Límite de exposición ($100)');
      return;
    }

    // === ABRIR POSICIÓN ===
    
    logger.info(`[SIGNAL] ${sig.direction} | Move: ${sig.movePct.toFixed(3)}% | Z: ${sig.zscore.toFixed(2)} | Conf: ${sig.confidence}/100`);
    logger.info(`[EDGE] fairYes=$${sig.edge.fairYes.toFixed(3)} polyYes=$${sig.edge.polyYes.toFixed(3)} edgePct=${sig.edge.edgePct.toFixed(2)}% | ${sig.edge.reason}`);
    
    const side = sig.direction === 'UP' ? 'BUY' : 'SELL';
    const price = sig.direction === 'UP' ? sig.edge.polyYes : sig.edge.polyNo;
    const size = Math.floor(exposure / price);

    // Registrar en PnLTracker
    tracker.openPosition({
      marketId: currentMarket.conditionId,
      gammaId: currentMarket.gammaId,
      marketQuestion: currentMarket.question,
      side: side,
      price: price,
      size: size,
      endDate: currentMarket.endDate
    });

    logger.info(`[OPEN] ${sig.direction} @ $${price.toFixed(3)} | Edge: ${sig.edge.edgePct.toFixed(2)}% | Move: ${sig.movePct.toFixed(3)}%`);
    logger.info(`  Exposure: $${exposure.toFixed(2)} | Size: ${size} contratos`);
    logger.info(`  Liquidez: BID=$${liquidity.bidLiquidity} ASK=$${liquidity.askLiquidity}`);

    // Actualizar tracking
    const posId = `POS_${Date.now()}`;
    activePositions.set(posId, { exposure, openTime: now });
    lastTradeTime = now;

    // Liberar slot después de 8 minutos
    setTimeout(() => {
      activePositions.delete(posId);
    }, 8 * 60 * 1000);
  });

  btcWs.onError((err) => logger.error(`BTC WS error: ${err.message}`));

  // === Conectar BTC WebSocket ===
  logger.info('Conectando a Coinbase WebSocket...');
  await btcWs.connect();
  logger.info('✓ Conectado\n');

  // === Health check cada 5 minutos ===
  setInterval(() => {
    const stats = tracker.getSummary();
    const sigStats = signal.getStats();
    
    logger.info('─'.repeat(60));
    logger.info('[HEALTH]');
    logger.info(`  Señales: ${sigStats.signals}`);
    logger.info(`  Active slots: ${activePositions.size}/10`);
    logger.info(`  Mercado actual: ${currentMarket?.question || 'N/A'}`);
    logger.info(`  Poly precio válido: ${polyPriceValid ? '✓' : '✗'}`);
    
    if (polyPriceValid) {
      const price = polyWs.getCurrentPrice();
      logger.info(`  Último precio: YES=${price.yes?.toFixed(3)} (age: ${price.age}ms)`);
    }
    
    logger.info('');
    logger.info('=== P&L TRACKER (REAL Polymarket) ===');
    logger.info(`  Open: ${stats.openPositions} | Closed: ${stats.closedPositions}`);
    logger.info(`  Wins: ${stats.wins} | Losses: ${stats.losses}`);
    logger.info(`  Win Rate: ${stats.winRate}`);
    logger.info(`  Total P&L: ${stats.totalPnL}`);
    logger.info('─'.repeat(60));
  }, 5 * 60 * 1000);

  // === Cleanup al cerrar ===
  process.on('SIGTERM', () => {
    logger.info('Cerrando...');
    polyWs.cleanup();
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    logger.info('Cerrando...');
    polyWs.cleanup();
    process.exit(0);
  });
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
