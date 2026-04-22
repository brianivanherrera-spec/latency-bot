/**
 * Motor de señales matemáticas - COSTO $0
 * 
 * Estrategia: Detectar movimientos bruscos de BTC usando:
 * 1. Momentum (precio actual vs media móvil)
 * 2. Z-Score (cuántas desviaciones estándar del movimiento)
 * 3. Presión de compra/venta (isBuyerMaker ratio)
 * 4. Velocidad del movimiento (cambio por segundo)
 */

const config = require('./config');

class SignalEngine {
  constructor() {
    this.prices = [];           // últimos N precios
    this.timestamps = [];       // timestamps correspondientes
    this.buyPressure = [];      // ratio de compra (0-1)
    this.maxBuffer = config.SIGNAL_WINDOW; // ej: 300 ticks (~30 segundos en aggTrade)

    this._totalTicks = 0;
    this._totalSignals = 0;
    this._lastSignalTime = 0;
  }

  /**
   * Procesar nuevo tick de precio
   * Retorna señal o null si no hay suficiente data / señal débil
   */
  process({ price, timestamp, isBuyerMaker }) {
    this._totalTicks++;

    this.prices.push(price);
    this.timestamps.push(timestamp);
    this.buyPressure.push(isBuyerMaker ? 0 : 1); // 1 = compra, 0 = venta

    // Mantener buffer
    if (this.prices.length > this.maxBuffer) {
      this.prices.shift();
      this.timestamps.shift();
      this.buyPressure.shift();
    }

    // Necesitamos mínimo N ticks para calcular
    if (this.prices.length < config.MIN_TICKS_REQUIRED) return null;

    return this._evaluate(price, timestamp);
  }

  _evaluate(currentPrice, currentTimestamp) {
    const n = this.prices.length;

    // === 1. Estadísticas de precios ===
    const mean = this.prices.reduce((a, b) => a + b, 0) / n;
    const variance = this.prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return null; // precio completamente plano

    // === 2. Z-Score del precio actual ===
    const zScore = (currentPrice - mean) / stdDev;

    // === 3. Momentum - cambio % en ventana corta ===
    const shortWindow = Math.min(30, Math.floor(n / 3));
    const priceShortAgo = this.prices[n - shortWindow];
    const movePct = ((currentPrice - priceShortAgo) / priceShortAgo) * 100;

    // === 4. Velocidad del movimiento (pct/segundo) ===
    const timeElapsedSec = (currentTimestamp - this.timestamps[n - shortWindow]) / 1000;
    const velocity = timeElapsedSec > 0 ? Math.abs(movePct) / timeElapsedSec : 0;

    // === 5. Presión de compra/venta (últimos 50 ticks) ===
    const recentPressure = this.buyPressure.slice(-50);
    const buyRatio = recentPressure.reduce((a, b) => a + b, 0) / recentPressure.length;

    // === 6. Confirmación de dirección ===
    // Señal fuerte: Z-score alto + movimiento % significativo + presión consistente
    const absZ = Math.abs(zScore);
    const absMoveP = Math.abs(movePct);

    if (absZ < config.ZSCORE_THRESHOLD) return null;      // movimiento no significativo
    if (absMoveP < config.MOVE_PCT_THRESHOLD) return null; // movimiento demasiado pequeño
    if (velocity < config.MIN_VELOCITY) return null;        // movimiento demasiado lento

    // Determinar dirección
    let direction;
    if (zScore > 0 && movePct > 0 && buyRatio > 0.55) {
      direction = 'UP';
    } else if (zScore < 0 && movePct < 0 && buyRatio < 0.45) {
      direction = 'DOWN';
    } else {
      direction = 'NEUTRAL'; // señal mixta, no operar
    }

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
    };
  }

  /**
   * Confianza de la señal: 0-100
   * Usada para ajustar tamaño de orden o filtrar señales débiles
   */
  _calcConfidence(absZ, absMoveP, velocity, buyRatio, direction) {
    let score = 0;

    // Z-score contribuye hasta 40 puntos
    score += Math.min(absZ / config.ZSCORE_THRESHOLD, 3) * (40 / 3);

    // Move% contribuye hasta 30 puntos
    score += Math.min(absMoveP / config.MOVE_PCT_THRESHOLD, 3) * (30 / 3);

    // Presión de compra contribuye hasta 20 puntos
    const pressureStrength = direction === 'UP'
      ? (buyRatio - 0.5) * 2
      : (0.5 - buyRatio) * 2;
    score += Math.max(0, pressureStrength) * 20;

    // Velocidad contribuye hasta 10 puntos
    score += Math.min(velocity / config.MIN_VELOCITY, 2) * 5;

    return Math.min(100, Math.round(score));
  }

  getStats() {
    return {
      ticks: this._totalTicks,
      signals: this._totalSignals,
      bufferSize: this.prices.length,
      lastPrice: this.prices[this.prices.length - 1] || null,
    };
  }
}

module.exports = { SignalEngine };
