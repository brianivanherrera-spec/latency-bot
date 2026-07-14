/**
 * Market Research Logger — registra el ciclo completo de cada mercado
 * de 5 minutos, independientemente de si el bot entra o no.
 *
 * Objetivo: acumular datos para validar la estrategia de "entrada tardía
 * con confirmación" — ver cómo se mueve BTC dentro de cada ventana,
 * dónde están los picos, y cómo resuelve el mercado al final.
 *
 * Se activa con RESEARCH_MODE=true — no afecta el trading normal.
 */

const fs = require('fs');
const { Logger } = require('./logger');

const logger = new Logger('RESEARCH');
const RESEARCH_FILE = process.env.RESEARCH_FILE || '/data/market-research.jsonl';

// Estado del mercado actual en observación
let currentMarket = null;

/**
 * Llamar cuando se activa un nuevo mercado (cada 5 minutos)
 * priceAtOpen: precio de BTC al momento de abrir el mercado (el "precio a superar")
 */
function startMarket({ marketId, question, endDate, priceAtOpen }) {
  // Si había un mercado anterior sin cerrar, descartarlo (no debería pasar)
  currentMarket = {
    marketId,
    question,
    startedAt: Date.now(),
    endDate: new Date(endDate).getTime(),
    priceAtOpen,
    ticks: [],       // [{t: msDesdeInicio, btcPrice, polyYes, polyNo}]
    maxPrice: priceAtOpen,
    minPrice: priceAtOpen,
    maxPriceAtMs: 0,
    minPriceAtMs: 0,
  };
}

/**
 * Llamar en cada tick de precio (BTC y/o Polymarket) mientras el mercado está activo
 */
function recordTick({ btcPrice, polyYes, polyNo }) {
  if (!currentMarket) return;
  const elapsedMs = Date.now() - currentMarket.startedAt;
  // Solo grabar dentro de la ventana de 5 minutos
  if (elapsedMs < 0 || elapsedMs > 300000) return;

  currentMarket.ticks.push({
    t: elapsedMs,
    btcPrice,
    polyYes: polyYes ?? null,
    polyNo: polyNo ?? null,
  });

  if (btcPrice !== undefined && btcPrice !== null) {
    if (btcPrice > currentMarket.maxPrice) {
      currentMarket.maxPrice = btcPrice;
      currentMarket.maxPriceAtMs = elapsedMs;
    }
    if (btcPrice < currentMarket.minPrice) {
      currentMarket.minPrice = btcPrice;
      currentMarket.minPriceAtMs = elapsedMs;
    }
  }
}

/**
 * Llamar cuando el mercado resuelve (se detecta YES=0.99+ o NO=0.99+, o cierra por tiempo)
 */
function closeMarket({ finalPrice, winner }) {
  if (!currentMarket) return;

  const record = {
    marketId: currentMarket.marketId,
    question: currentMarket.question,
    timestamp: new Date(currentMarket.startedAt).toISOString(),
    priceAtOpen: currentMarket.priceAtOpen,
    finalPrice: finalPrice ?? null,
    winner: winner ?? (finalPrice > currentMarket.priceAtOpen ? 'UP' : 'DOWN'),
    maxPrice: currentMarket.maxPrice,
    minPrice: currentMarket.minPrice,
    maxPriceAtMs: currentMarket.maxPriceAtMs,
    minPriceAtMs: currentMarket.minPriceAtMs,
    range: currentMarket.maxPrice - currentMarket.minPrice,
    tickCount: currentMarket.ticks.length,
    // Guardar una muestra reducida de ticks (cada 5s) para no inflar el archivo
    ticksSample: currentMarket.ticks.filter((_, i) => i % 5 === 0),
  };

  try {
    fs.appendFileSync(RESEARCH_FILE, JSON.stringify(record) + '\n');
    logger.info(`Mercado registrado: ${record.winner} | rango $${record.range.toFixed(2)} | ${record.tickCount} ticks`);
  } catch (e) {
    logger.warn(`No se pudo guardar research: ${e.message}`);
  }

  currentMarket = null;
}

function isActive() {
  return currentMarket !== null;
}

module.exports = { startMarket, recordTick, closeMarket, isActive };
