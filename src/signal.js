/**
 * Motor de señales - Latencia Coinbase vs Polymarket
 *
 * Estrategia: Polymarket actualiza sus odds con 2-10 segundos de delay
 * respecto al precio real de BTC en Coinbase.
 *
 * Edge: Si BTC sube 0.05% en Coinbase, el mercado "BTC higher in 5min"
 * todavia cotiza como si BTC no se hubiera movido. Compramos YES barato
 * antes de que el mercado actualice.
 *
 * Logica:
 * 1. Detectar movimiento brusco de BTC en Coinbase (Z-score + momentum)
 * 2. Estimar el precio "justo" de YES segun el movimiento
 * 3. Si el precio de Polymarket < precio justo → hay edge → operar
 */

const config = require('./config');

class SignalEngine {
  constructor() {
    this.prices = [];
    this.timestamps = [];
    this.buyPressure = [];
    this.maxBuffer = config.SIGNAL_WINDOW;

    // Precio actual de Polymarket (se actualiza desde index.js)
    this.polyYesPrice = null;
    this.polyNoPrice = null;
    this.polyUpdatedAt = null;

    this._totalTicks = 0;
    this._totalSignals = 0;
    this._lastSignalTime = 0;
  }

  /**
   * Actualizar precio de Polymarket desde afuera
   * Llamar periodicamente desde index.js
   */
  updatePolyPrice(yesPrice, noPrice) {
    this.polyYesPrice = yesPrice;
    this.polyNoPrice = noPrice;
    this.polyUpdatedAt = Date.now();
  }

  /**
   * Procesar nuevo tick de precio Coinbase
   */
  process({ price, timestamp, isBuyerMaker }) {
    this._totalTicks++;

    this.prices.push(price);
    this.timestamps.push(timestamp);
    this.buyPressure.push(isBuyerMaker ? 0 : 1);

    if (this.prices.length > this.maxBuffer) {
      this.prices.shift();
      this.timestamps.shift();
      this.buyPressure.shift();
    }

    if (this.prices.length < config.MIN_TICKS_REQUIRED) return null;

    return this._evaluate(price, timestamp);
  }

  _evaluate(currentPrice, currentTimestamp) {
    const n = this.prices.length;

    // === Estadisticas de precio ===
    const mean = this.prices.reduce((a, b) => a + b, 0) / n;
    const variance = this.prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return null;

    const zScore = (currentPrice - mean) / stdDev;

    // === Momentum ventana corta ===
    const shortWindow = Math.min(30, Math.floor(n / 3));
    const priceShortAgo = this.prices[n - shortWindow];
    const movePct = ((currentPrice - priceShortAgo) / priceShortAgo) * 100;

    // === Velocidad (%/segundo) ===
    const timeElapsedSec = (currentTimestamp - this.timestamps[n - shortWindow]) / 1000;
    const velocity = timeElapsedSec > 0 ? Math.abs(movePct) / timeElapsedSec : 0;

    // === Presion de compra/venta ===
    const recentPressure = this.buyPressure.slice(-50);
    const buyRatio = recentPressure.reduce((a, b) => a + b, 0) / recentPressure.length;

    // === Filtros basicos ===
    const absZ = Math.abs(zScore);
    const absMoveP = Math.abs(movePct);

    if (absZ < config.ZSCORE_THRESHOLD) return null;
    if (absMoveP < config.MOVE_PCT_THRESHOLD) return null;
    if (velocity < config.MIN_VELOCITY) return null;

    // === Direccion ===
    let direction;
    if (zScore > 0 && movePct > 0 && buyRatio > 0.55) {
      direction = 'UP';
    } else if (zScore < 0 && movePct < 0 && buyRatio < 0.45) {
      direction = 'DOWN';
    } else {
      direction = 'NEUTRAL';
    }

    if (direction === 'NEUTRAL') {
      this._totalSignals++;
      return { direction, zScore, movePct, velocity, buyRatio, currentPrice, mean, stdDev,
               confidence: 0, timestamp: currentTimestamp, edge: null };
    }

    // === Calculo de edge vs Polymarket ===
    const edge = this._calcEdge(direction, movePct, absZ);

    this._totalSignals++;
    this._lastSignalTime = currentTimestamp;

    return {
      direction,
      zScore,
      movePct,
      velocity,
      buyRatio,
      currentPrice,
      mean,
      stdDev,
      confidence: this._calcConfidence(absZ, absMoveP, velocity, buyRatio, direction),
      timestamp: currentTimestamp,
      edge, // { hasEdge, fairPrice, polyPrice, edgePct, side }
    };
  }

  /**
   * Calcular edge de latencia:
   * Estimar precio "justo" de YES segun el movimiento de BTC
   * y compararlo con el precio actual de Polymarket.
   *
   * Modelo simple: precio base + ajuste por movimiento
   * - BTC +0.05% en 30seg → YES deberia cotizar ~0.60-0.65
   * - BTC -0.05% en 30seg → YES deberia cotizar ~0.35-0.40
   * - El mercado "5 min" tiene mucha incertidumbre → rango estrecho
   */
  _calcEdge(direction, movePct, absZ) {
    // Precio base neutral (mercado 50/50 si BTC no se mueve)
    const BASE_YES = 0.50;

    // Sensibilidad: cuanto se mueve el precio justo por cada 0.1% de BTC
    // Conservador porque el mercado es de 5 minutos (mucho tiempo aun)
    const SENSITIVITY = config.POLY_SENSITIVITY || 2.5; // puntos de probabilidad por 0.1% de BTC

    const absMoveP = Math.abs(movePct);
    const adjustment = Math.min((absMoveP / 0.1) * SENSITIVITY / 100, 0.20); // max 20 puntos

    // Precio justo estimado
    const fairYes = direction === 'UP'
      ? Math.min(0.85, BASE_YES + adjustment)
      : Math.max(0.15, BASE_YES - adjustment);

    const fairNo = 1 - fairYes;

    // Si no tenemos precio de Polymarket, no podemos calcular edge
    // Pero igual devolvemos estimado para logging
    if (this.polyYesPrice === null) {
      return {
        hasEdge: false,
        fairYes: parseFloat(fairYes.toFixed(3)),
        fairNo: parseFloat(fairNo.toFixed(3)),
        polyYes: null,
        polyNo: null,
        edgePct: null,
        side: direction === 'UP' ? 'BUY_YES' : 'BUY_NO',
        reason: 'NO_POLY_PRICE',
      };
    }

    // Staleness check: si el precio de Poly tiene mas de 30 segundos, ignorar
    const polyAge = Date.now() - this.polyUpdatedAt;
    if (polyAge > 30000) {
      return {
        hasEdge: false,
        fairYes: parseFloat(fairYes.toFixed(3)),
        polyYes: this.polyYesPrice,
        edgePct: null,
        side: direction === 'UP' ? 'BUY_YES' : 'BUY_NO',
        reason: 'POLY_PRICE_STALE',
      };
    }

    // Calcular edge
    if (direction === 'UP') {
      // Queremos comprar YES: edge = fairYes - polyYes
      const edgePct = ((fairYes - this.polyYesPrice) / this.polyYesPrice) * 100;
      const hasEdge = edgePct >= (config.MIN_EDGE_PCT || 5); // minimo 5% de edge
      return {
        hasEdge,
        fairYes: parseFloat(fairYes.toFixed(3)),
        polyYes: this.polyYesPrice,
        edgePct: parseFloat(edgePct.toFixed(2)),
        side: 'BUY_YES',
        reason: hasEdge ? 'EDGE_FOUND' : 'EDGE_TOO_SMALL',
      };
    } else {
      // Queremos comprar NO: edge = fairNo - polyNo
      const edgePct = ((fairNo - this.polyNoPrice) / this.polyNoPrice) * 100;
      const hasEdge = edgePct >= (config.MIN_EDGE_PCT || 5);
      return {
        hasEdge,
        fairNo: parseFloat(fairNo.toFixed(3)),
        polyNo: this.polyNoPrice,
        edgePct: parseFloat(edgePct.toFixed(2)),
        side: 'BUY_NO',
        reason: hasEdge ? 'EDGE_FOUND' : 'EDGE_TOO_SMALL',
      };
    }
  }

  _calcConfidence(absZ, absMoveP, velocity, buyRatio, direction) {
    let score = 0;
    score += Math.min(absZ / config.ZSCORE_THRESHOLD, 3) * (40 / 3);
    score += Math.min(absMoveP / config.MOVE_PCT_THRESHOLD, 3) * (30 / 3);
    const pressureStrength = direction === 'UP'
      ? (buyRatio - 0.5) * 2
      : (0.5 - buyRatio) * 2;
    score += Math.max(0, pressureStrength) * 20;
    score += Math.min(velocity / config.MIN_VELOCITY, 2) * 5;
    return Math.min(100, Math.round(score));
  }

  getStats() {
    return {
      ticks: this._totalTicks,
      signals: this._totalSignals,
      bufferSize: this.prices.length,
      lastPrice: this.prices[this.prices.length - 1] || null,
      polyYes: this.polyYesPrice,
      polyAge: this.polyUpdatedAt ? Math.round((Date.now() - this.polyUpdatedAt) / 1000) + 's' : 'never',
    };
  }
}

module.exports = { SignalEngine };
