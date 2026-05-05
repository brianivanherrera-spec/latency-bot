/**
 * LATENCY ARBITRAGE BOT - VERSIÓN CORREGIDA
 * 
 * FIX PRINCIPAL: Usar precio BTC al INICIO del mercado como referencia
 * 
 * Estrategia corregida:
 * 1. Detecta nuevo mercado y guarda precio BTC al inicio (startPrice)
 * 2. Calcula movimiento REAL: currentPrice vs startPrice
 * 3. Compara con precio Polymarket
 * 4. Opera solo si Polymarket está desactualizado vs posición real de BTC
 */

const { BinanceWS } = require('./binance');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('LATENCY-ARB-FIXED');

// Estado global
let lastBTCPrice = null;
let lastBTCUpdate = null;
let polymarketPrice = { yes: 0.50, no: 0.50 };
let polymarketUpdate = null;
let currentMarket = null;

// ⭐ NUEVA VARIABLE CRÍTICA: Precio BTC al inicio del mercado
let marketStartPrice = null;
let marketStartTime = null;

const tracker = new PnLTracker();
const activePositions = new Map();

const GAMMA_API = 'https://gamma-api.polymarket.com';

// ============================================================================
// ⭐ NUEVA FUNCIÓN: Parsear horario del mercado
// ============================================================================

function parseMarketTiming(marketQuestion) {
  /**
   * Ejemplo: "Bitcoin Up or Down - May 5, 9:30AM-9:35AM ET"
   * Retorna: { startTime: Date, endTime: Date }
   */
  
  // Regex para capturar horario
  const match = marketQuestion.match(/(\d{1,2}):(\d{2})(AM|PM)-(\d{1,2}):(\d{2})(AM|PM)/i);
  if (!match) return null;
  
  const [_, startHour, startMin, startPeriod, endHour, endMin, endPeriod] = match;
  
  // Convertir a 24h
  let startH = parseInt(startHour);
  let endH = parseInt(endHour);
  
  if (startPeriod.toUpperCase() === 'PM' && startH !== 12) startH += 12;
  if (startPeriod.toUpperCase() === 'AM' && startH === 12) startH = 0;
  if (endPeriod.toUpperCase() === 'PM' && endH !== 12) endH += 12;
  if (endPeriod.toUpperCase() === 'AM' && endH === 12) endH = 0;
  
  // Crear fechas (asumiendo ET = UTC-5 o UTC-4 según DST)
  // Simplificado: usar hora local del servidor
  const now = new Date();
  const startTime = new Date(now);
  startTime.setHours(startH, parseInt(startMin), 0, 0);
  
  const endTime = new Date(now);
  endTime.setHours(endH, parseInt(endMin), 0, 0);
  
  return { startTime, endTime };
}

// ============================================================================
// ⭐ NUEVA FUNCIÓN: Calcular Fair Price basado en INICIO del mercado
// ============================================================================

function calculateFairPriceFromStart(currentPrice, startPrice) {
  /**
   * Calcula probabilidad basándose en movimiento REAL desde inicio
   * 
   * Si BTC subió +0.5% vs inicio → YES debería estar alto (~0.70)
   * Si BTC bajó -0.5% vs inicio → YES debería estar bajo (~0.30)
   */
  
  if (!startPrice || !currentPrice) return { yes: 0.50, no: 0.50 };
  
  const movementPct = (currentPrice - startPrice) / startPrice;
  
  // Sensibilidad ajustada para movimientos acumulados (no micro)
  const sensitivity = 100; // Mucho más alto porque usamos movimiento total
  
  // Función logística
  const fairYes = 1 / (1 + Math.exp(-sensitivity * movementPct));
  
  return {
    yes: Math.max(0.05, Math.min(0.95, fairYes)),
    no: Math.max(0.05, Math.min(0.95, 1 - fairYes))
  };
}

// ============================================================================
// ⭐ FUNCIÓN CORREGIDA: Detectar Edge Real
// ============================================================================

function detectLatencyEdge() {
  if (!lastBTCPrice || !lastBTCUpdate) return null;
  if (!polymarketPrice || !polymarketUpdate) return null;
  if (!marketStartPrice) {
    // Si no tenemos precio de inicio, no podemos calcular edge correcto
    return null;
  }
  
  const now = Date.now();
  
  // Validar frescura de datos
  const btcAge = now - lastBTCUpdate;
  const polyAge = now - polymarketUpdate;
  
  if (btcAge > 5000) return null;
  if (polyAge > 5000) return null;
  
  // ⭐ CAMBIO PRINCIPAL: Calcular movimiento desde INICIO del mercado
  const movementFromStart = (lastBTCPrice - marketStartPrice) / marketStartPrice;
  
  // Calcular precio "justo" basado en posición vs inicio
  const fairPrice = calculateFairPriceFromStart(lastBTCPrice, marketStartPrice);
  
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
  
  // ⭐ THRESHOLD MÁS ALTO: Necesitamos edge claro para compensar fees
  const MIN_EDGE = 5; // 5% mínimo (antes era 3%)
  
  if (edgeYes > MIN_EDGE && edgeYes > edgeNo) {
    // BTC está arriba vs inicio, pero Polymarket no refleja esto
    direction = 'BUY'; // Comprar YES
    edge = edgeYes;
    fairValue = fairPrice.yes;
    polyValue = polyYes;
  } else if (edgeNo > MIN_EDGE && edgeNo > edgeYes) {
    // BTC está abajo vs inicio, pero Polymarket no refleja esto
    direction = 'SELL'; // Vender YES = Comprar NO
    edge = edgeNo;
    fairValue = fairPrice.no;
    polyValue = polyNo;
  }
  
  if (!direction) return null;
  
  // Validar que el edge es realista
  if (edge > 50) {
    logger.warn(`Edge sospechoso: ${edge.toFixed(2)}% - probablemente datos incorrectos`);
    return null;
  }
  
  return {
    direction,
    edge: edge.toFixed(2),
    btcMovementFromStart: (movementFromStart * 100).toFixed(3),
    currentPrice: lastBTCPrice.toFixed(2),
    startPrice: marketStartPrice.toFixed(2),
    fairPrice: fairValue.toFixed(3),
    polyPrice: polyValue.toFixed(3),
    latencyMs: polyAge
  };
}

// ============================================================================
// ⭐ NUEVA FUNCIÓN: Inicializar mercado y guardar precio de inicio
// ============================================================================

async function initializeMarket(market) {
  currentMarket = market;
  
  // Parsear timing del mercado
  const timing = parseMarketTiming(market.question);
  
  if (timing) {
    marketStartTime = timing.startTime;
    logger.info(`⏰ Mercado inicia a las: ${marketStartTime.toLocaleTimeString()}`);
    
    // Si el mercado ya empezó, usar precio actual como inicio
    const now = new Date();
    if (now >= marketStartTime) {
      marketStartPrice = lastBTCPrice;
      logger.info(`📊 Precio BTC al inicio: $${marketStartPrice?.toFixed(2) || 'N/A'}`);
    } else {
      // Esperar a que empiece el mercado
      logger.info(`⏳ Esperando inicio del mercado...`);
      marketStartPrice = null;
    }
  } else {
    // Fallback: usar precio actual
    logger.warn(`⚠️  No se pudo parsear horario, usando precio actual como inicio`);
    marketStartPrice = lastBTCPrice;
  }
  
  logger.info(`[MARKET] ${market.question}`);
}

// ============================================================================
// Actualización de Polymarket (sin cambios)
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
      
      if (yes >= 0.05 && yes <= 0.95 && no >= 0.05 && no <= 0.95) {
        polymarketPrice = { yes, no };
        polymarketUpdate = Date.now();
      } else {
        logger.info(`Mercado resuelto o precio inválido: YES=${yes} NO=${no}`);
        currentMarket = null;
        marketStartPrice = null;
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
  const size = 10;
  const price = signal.direction === 'BUY' ? polymarketPrice.yes : polymarketPrice.no;
  const exposure = price * size;
  
  // Límites de risk
  if (activePositions.size >= 10) return;
  
  const totalExposure = Array.from(activePositions.values()).reduce((sum, p) => sum + p.exposure, 0);
  if (totalExposure + exposure > 100) return;
  
  // Registrar en tracker
  tracker.openPosition({
    marketId: currentMarket.conditionId,
    gammaId: currentMarket.gammaId,
    marketQuestion: currentMarket.question,
    side: signal.direction,
    price: price,
    size: size,
    endDate: currentMarket.endDate
  });
  
  activePositions.set(posId, {
    id: posId,
    openTime: Date.now(),
    exposure: exposure
  });
  
  logger.info(`[OPEN] ${signal.direction} @ $${price.toFixed(3)} | Edge: ${signal.edge}%`);
  logger.info(`  BTC: $${signal.currentPrice} (${signal.btcMovementFromStart > 0 ? '+' : ''}${signal.btcMovementFromStart}% vs inicio $${signal.startPrice})`);
  logger.info(`  Fair: $${signal.fairPrice} vs Poly: $${signal.polyPrice} | Latency: ${signal.latencyMs}ms`);
  
  setTimeout(() => {
    activePositions.delete(posId);
  }, 8 * 60 * 1000);
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  logger.info('═'.repeat(70));
  logger.info('🎯 LATENCY ARBITRAGE BOT - VERSIÓN CORREGIDA');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : 'LIVE'}`);
  logger.info('');
  logger.info('FIX: Ahora usa precio BTC al INICIO del mercado como referencia');
  logger.info('');
  
  const poly = new PolymarketClient();
  const ws = new BinanceWS();
  
  // Encontrar mercado inicial
  const market = await poly.findBTCMarket();
  if (market) {
    await initializeMarket(market);
  }
  
  // Actualizar mercado cada 5 minutos
  setInterval(async () => {
    const m = await poly.findBTCMarket();
    if (m && m.gammaId !== currentMarket?.gammaId) {
      await initializeMarket(m);
    }
  }, 5 * 60 * 1000);
  
  // Actualizar precio Polymarket cada 2 segundos
  setInterval(updatePolymarketPrice, 2000);
  
  // Verificar posiciones cerradas cada minuto
  setInterval(() => tracker.checkClosedPositions(), 60000);
  
  // WebSocket de Coinbase
  ws.onPrice((data) => {
    lastBTCPrice = data.price;
    lastBTCUpdate = Date.now();
    
    // ⭐ NUEVA LÓGICA: Si el mercado acaba de empezar y no tenemos startPrice, guardarlo
    if (currentMarket && !marketStartPrice && marketStartTime) {
      const now = new Date();
      if (now >= marketStartTime) {
        marketStartPrice = data.price;
        logger.info(`📊 Precio BTC al inicio del mercado: $${marketStartPrice.toFixed(2)}`);
      }
    }
    
    // Intentar detectar edge
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
    logger.info(`  BTC Current: $${lastBTCPrice?.toFixed(2) || 'N/A'}`);
    logger.info(`  BTC Start: $${marketStartPrice?.toFixed(2) || 'N/A'}`);
    if (marketStartPrice && lastBTCPrice) {
      const move = ((lastBTCPrice - marketStartPrice) / marketStartPrice * 100).toFixed(3);
      logger.info(`  Movement: ${move > 0 ? '+' : ''}${move}%`);
    }
    logger.info(`  Poly YES: ${polymarketPrice.yes.toFixed(3)}`);
    logger.info(`  Active Positions: ${activePositions.size}/10`);
    logger.info('');
    logger.info('=== P&L TRACKER ===');
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
