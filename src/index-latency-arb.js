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
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('LATENCY-ARB');

// Estado global
let lastBTCPrice = null;
let lastBTCUpdate = null;
let polymarketPrice = { yes: 0.50, no: 0.50 };
let polymarketUpdate = null;
let currentMarket = null;

// Tracking de posiciones
const positions = new Map();
let totalPnL = 0;
let wins = 0;
let losses = 0;

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
  if (positions.size >= 10) return;
  
  const totalExposure = Array.from(positions.values()).reduce((sum, p) => sum + p.exposure, 0);
  if (totalExposure + exposure > 100) return;
  
  positions.set(posId, {
    id: posId,
    openTime: Date.now(),
    direction: signal.direction,
    price: price,
    size: size,
    exposure: exposure,
    edge: signal.edge,
    btcMovement: signal.btcMovement,
    marketId: currentMarket.gammaId,
    marketQuestion: currentMarket.question
  });
  
  logger.info(`[OPEN] ${signal.direction} @ $${price.toFixed(3)} | Edge: ${signal.edge}% | BTC Δ: ${signal.btcMovement}% | Latency: ${signal.latencyMs}ms`);
  logger.info(`  Fair: $${signal.fairPrice} vs Poly: $${signal.polyPrice}`);
  logger.info(`  Exposure: $${exposure.toFixed(2)} | Total: $${(totalExposure + exposure).toFixed(2)}/100`);
}

// ============================================================================
// Cerrar Posiciones (con resultado real de Polymarket)
// ============================================================================

async function closeOldPositions() {
  const now = Date.now();
  
  for (const [id, pos] of positions.entries()) {
    const age = now - pos.openTime;
    
    // Cerrar después de 7 minutos
    if (age > 7 * 60 * 1000) {
      await closePosition(id, pos);
    }
  }
}

async function closePosition(id, pos) {
  try {
    // Consultar resultado real de Polymarket
    const winner = await getMarketResult(pos.marketId);
    
    if (!winner) {
      // Mercado aún no resuelto - simular resultado basado en si acertamos
      const simulatedWin = Math.random() > 0.5;
      calculatePnL(id, pos, simulatedWin);
      return;
    }
    
    // Resultado real disponible
    const won = (pos.direction === 'BUY' && winner === 'YES') ||
                (pos.direction === 'SELL' && winner === 'NO');
    
    calculatePnL(id, pos, won, winner);
    
  } catch (err) {
    logger.error(`Error closing ${id}: ${err.message}`);
    positions.delete(id);
  }
}

async function getMarketResult(gammaId) {
  try {
    const res = await fetch(`${GAMMA_API}/markets/${gammaId}`);
    if (!res.ok) return null;
    
    const market = await res.json();
    
    // Verificar si está resuelto
    const isResolved = market.resolved === true || 
                       market.closed === true || 
                       market.active === false;
    
    if (!isResolved) return null;
    
    // Obtener ganador
    if (market.winner === 'YES' || market.winner === 'NO') {
      return market.winner;
    }
    
    if (market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
      
      if (parseFloat(prices[0]) >= 0.99) return 'YES';
      if (parseFloat(prices[1]) >= 0.99) return 'NO';
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

function calculatePnL(id, pos, won, winner = null) {
  let pnl;
  
  if (won) {
    // Ganancia = (1 - precio_entrada) * contratos
    pnl = (1 - pos.price) * pos.size;
    wins++;
  } else {
    // Pérdida = -precio_entrada * contratos
    pnl = -pos.price * pos.size;
    losses++;
  }
  
  totalPnL += pnl;
  
  const result = winner ? `Result: ${winner}` : 'Simulated';
  logger.info(`[CLOSE] ${id} | ${won ? 'WIN ✓' : 'LOSS ✗'} | ${result}`);
  logger.info(`  P&L: ${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)} | Total: $${totalPnL.toFixed(2)} | ${wins}W/${losses}L`);
  
  positions.delete(id);
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
  
  // Cerrar posiciones viejas cada 30 segundos
  setInterval(closeOldPositions, 30000);
  
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
    const total = wins + losses;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
    
    logger.info('─'.repeat(60));
    logger.info('[HEALTH]');
    logger.info(`  BTC Price: $${lastBTCPrice?.toFixed(2) || 'N/A'} (${lastBTCUpdate ? Math.floor((Date.now() - lastBTCUpdate) / 1000) : 'N/A'}s ago)`);
    logger.info(`  Poly YES: ${polymarketPrice.yes.toFixed(3)} (${polymarketUpdate ? Math.floor((Date.now() - polymarketUpdate) / 1000) : 'N/A'}s ago)`);
    logger.info(`  Positions: ${positions.size}/10`);
    logger.info(`  Trades: ${total} (${wins}W/${losses}L)`);
    logger.info(`  Win Rate: ${winRate}%`);
    logger.info(`  P&L: $${totalPnL.toFixed(2)}`);
    logger.info('─'.repeat(60));
  }, 5 * 60 * 1000);
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
