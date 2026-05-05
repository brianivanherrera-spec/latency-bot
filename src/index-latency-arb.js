/**
 * LATENCY ARBITRAGE BOT - VERSIÓN REAL
 * 
 * Estrategia:
 * 1. Monitorea precio BTC en Coinbase (real-time WebSocket)
 * 2. Monitorea precio implícito en Polymarket (polling cada 2s)
 * 3. Detecta cuando Polymarket está desactualizado
 * 4. Opera SOLO cuando hay desfase temporal (edge real)
 * 5. Cierra consultando resultado real de Polymarket
 */

const { BinanceWS } = require('./binance');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('LATENCY-ARB');

// Estado global
let lastBTCPrice = null;
let lastBTCUpdate = null;
let polymarketPrice = { yes: 0.50, no: 0.50 };
let polymarketUpdate = null;
let currentMarket = null;

// Tracking de posiciones CON PnLTracker (consulta Polymarket real)
const tracker = new PnLTracker();
const activePositions = new Map(); // Solo para límites de risk

const GAMMA_API = 'https://gamma-api.polymarket.com';

// ============================================================================
// CORE: Cálculo de Fair Price basado en movimiento de BTC
// ============================================================================

function calculateFairPrice(btcMovementPct) {
  /**
   * Si BTC sube 0.1%, la probabilidad de "UP" debería aumentar
   * Usamos una función logística para mapear movimiento → probabilidad
   * 
   * Movimiento pequeño (±0.05%) → cerca de 0.50
   * Movimiento grande (+0.5%) → cerca de 0.70-0.80
   * Movimiento grande (-0.5%) → cerca de 0.20-0.30
   */
  
  // Sensibilidad: cuánto afecta el movimiento BTC a la probabilidad
  const sensitivity = 15; // Mayor = más sensible
  
  // Función logística centrada en 0.50
  const fairYes = 1 / (1 + Math.exp(-sensitivity * btcMovementPct));
  
  return {
    yes: Math.max(0.05, Math.min(0.95, fairYes)),
    no: Math.max(0.05, Math.min(0.95, 1 - fairYes))
  };
}

// ============================================================================
// CORE: Detección de Edge Real (Latency Arbitrage)
// ============================================================================

function detectLatencyEdge() {
  if (!lastBTCPrice || !lastBTCUpdate) return null;
  if (!polymarketPrice || !polymarketUpdate) return null;
  
  const now = Date.now();
  
  // Validar frescura de datos
  const btcAge = now - lastBTCUpdate;
  const polyAge = now - polymarketUpdate;
  
  if (btcAge > 5000) return null; // BTC data stale
  if (polyAge > 5000) return null; // Poly data stale
  
  // Calcular movimiento reciente de BTC (últimos 5 segundos)
  const recentWindow = priceHistory.filter(p => now - p.timestamp < 5000);
  if (recentWindow.length < 2) return null;
  
  const oldestPrice = recentWindow[0].price;
  const latestPrice = recentWindow[recentWindow.length - 1].price;
  const movementPct = (latestPrice - oldestPrice) / oldestPrice;
  
  // Calcular precio "justo" basado en movimiento BTC
  const fairPrice = calculateFairPrice(movementPct);
  
  // Polymarket actual
  const polyYes = polymarketPrice.yes;
  const polyNo = polymarketPrice.no;
  
  // EDGE = diferencia entre precio justo y precio Polymarket
  const edgeYes = ((fairPrice.yes - polyYes) / polyYes) * 100;
  const edgeNo = ((fairPrice.no - polyNo) / polyNo) * 100;
  
  // Determinar mejor oportunidad
  let direction = null;
  let edge = 0;
  let fairValue = 0;
  let polyValue = 0;
  
  if (edgeYes > 3 && edgeYes > edgeNo) {
    // Polymarket subvalora YES (BTC subió pero Poly no actualizó)
    direction = 'BUY'; // Comprar YES
    edge = edgeYes;
    fairValue = fairPrice.yes;
    polyValue = polyYes;
  } else if (edgeNo > 3 && edgeNo > edgeYes) {
    // Polymarket subvalora NO (BTC bajó pero Poly no actualizó)
    direction = 'SELL'; // Vender YES = Comprar NO
    edge = edgeNo;
    fairValue = fairPrice.no;
    polyValue = polyNo;
  }
  
  if (!direction) return null;
  
  // Validar que el edge es realista (protección anti-glitches)
  if (edge > 20) {
    logger.warn(`Edge sospechoso: ${edge.toFixed(2)}% - probablemente datos incorrectos`);
    return null;
  }
  
  return {
    direction,
    edge: edge.toFixed(2),
    btcMovement: (movementPct * 100).toFixed(3),
    fairPrice: fairValue.toFixed(3),
    polyPrice: polyValue.toFixed(3),
    latencyMs: polyAge
  };
}

// ============================================================================
// Historial de precios BTC
// ============================================================================

const priceHistory = [];
const MAX_HISTORY = 100;

function addBTCPrice(price) {
  lastBTCPrice = price;
  lastBTCUpdate = Date.now();
  
  priceHistory.push({
    price,
    timestamp: lastBTCUpdate
  });
  
  // Mantener solo últimos 100
  if (priceHistory.length > MAX_HISTORY) {
    priceHistory.shift();
  }
}

// ============================================================================
// Actualización de Polymarket
// ============================================================================

async function updatePolymarketPrice() {
  if (!currentMarket?.gammaId) return;
  
  try {
    const res = await fetch(`${GAMMA_API}/markets/${currentMarket.gammaId}`);
    if (!res.ok) return;
    
    const data = await res.json();
    
    if (data.outcomePrices) {
      const prices = typeof data.outcomePrices === 'string'
        ? JSON.parse(data.outcomePrices)
        : data.outcomePrices;
      
      const yes = parseFloat(prices[0]);
      const no = parseFloat(prices[1]);
      
      // Validar precios razonables
      if (yes >= 0.05 && yes <= 0.95 && no >= 0.05 && no <= 0.95) {
        polymarketPrice = { yes, no };
        polymarketUpdate = Date.now();
      } else {
        // Mercado probablemente resuelto
        logger.info(`Mercado resuelto o precio inválido: YES=${yes} NO=${no}`);
        currentMarket = null;
      }
    }
  } catch (err) {
    // Silent
  }
}

// ============================================================================
// Abrir Posición
// ============================================================================

function openPosition(signal) {
  const posId = `POS_${Date.now()}`;
  const size = 10; // 10 contratos
  const price = signal.direction === 'BUY' ? polymarketPrice.yes : polymarketPrice.no;
  const exposure = price * size;
  
  // Límites de risk
  if (activePositions.size >= 10) return;
  
  const totalExposure = Array.from(activePositions.values()).reduce((sum, p) => sum + p.exposure, 0);
  if (totalExposure + exposure > 100) return;
  
  // Registrar en tracker (consultará Polymarket para resultado real)
  tracker.openPosition({
    marketId: currentMarket.conditionId,
    gammaId: currentMarket.gammaId,
    marketQuestion: currentMarket.question,
    side: signal.direction,
    price: price,
    size: size,
    endDate: currentMarket.endDate
  });
  
  // Mantener en activePositions solo para límites
  activePositions.set(posId, {
    id: posId,
    openTime: Date.now(),
    exposure: exposure
  });
  
  logger.info(`[OPEN] ${signal.direction} @ $${price.toFixed(3)} | Edge: ${signal.edge}% | BTC Δ: ${signal.btcMovement}% | Latency: ${signal.latencyMs}ms`);
  logger.info(`  Fair: $${signal.fairPrice} vs Poly: $${signal.polyPrice}`);
  logger.info(`  Exposure: $${exposure.toFixed(2)} | Total: $${(totalExposure + exposure).toFixed(2)}/100`);
  
  // Programar liberación de slot después de 8 minutos
  setTimeout(() => {
    activePositions.delete(posId);
  }, 8 * 60 * 1000);
}

// ============================================================================
// Verificar Posiciones Cerradas (usa PnLTracker que consulta Polymarket)
// ============================================================================

async function checkClosedPositions() {
  await tracker.checkClosedPositions();
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  logger.info('═'.repeat(70));
  logger.info('🎯 LATENCY ARBITRAGE BOT - Real Strategy');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : 'LIVE'}`);
  logger.info('');
  logger.info('Estrategia: Explotar desfase temporal Coinbase ↔ Polymarket');
  logger.info('');
  
  const poly = new PolymarketClient();
  const ws = new BinanceWS();
  
  // Encontrar mercado inicial
  const market = await poly.findBTCMarket();
  if (market) {
    currentMarket = market;
    logger.info(`[MARKET] ${market.question}`);
  }
  
  // Actualizar mercado cada 5 minutos
  setInterval(async () => {
    const m = await poly.findBTCMarket();
    if (m && m.gammaId !== currentMarket?.gammaId) {
      currentMarket = m;
      logger.info(`[MARKET] Nuevo mercado: ${m.question}`);
    }
  }, 5 * 60 * 1000);
  
  // Actualizar precio Polymarket cada 2 segundos
  setInterval(updatePolymarketPrice, 2000);
  
  // Verificar posiciones cerradas cada minuto (consulta Polymarket real)
  setInterval(checkClosedPositions, 60000);
  
  // WebSocket de Coinbase
  ws.onPrice((data) => {
    addBTCPrice(data.price);
    
    // Intentar detectar edge cada tick
    const signal = detectLatencyEdge();
    
    if (signal) {
      openPosition(signal);
    }
  });
  
  ws.onError((err) => logger.error(`WS error: ${err.message}`));
  
  logger.info('Conectando a Coinbase WebSocket...');
  await ws.connect();
  logger.info('✓ Conectado\n');
  
  // Health check cada 5 min
  setInterval(() => {
    const stats = tracker.getSummary();
    
    logger.info('─'.repeat(60));
    logger.info('[HEALTH]');
    logger.info(`  BTC Price: $${lastBTCPrice?.toFixed(2) || 'N/A'} (${lastBTCUpdate ? Math.floor((Date.now() - lastBTCUpdate) / 1000) : 'N/A'}s ago)`);
    logger.info(`  Poly YES: ${polymarketPrice.yes.toFixed(3)} (${polymarketUpdate ? Math.floor((Date.now() - polymarketUpdate) / 1000) : 'N/A'}s ago)`);
    logger.info(`  Active Positions: ${activePositions.size}/10`);
    logger.info('');
    logger.info('=== P&L TRACKER (REAL Polymarket Results) ===');
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
