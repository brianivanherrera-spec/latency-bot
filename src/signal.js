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
   * Calcular edge de latencia: VERSIÓN CORREGIDA
   * 
   * Estimar precio "justo" de YES/NO según el movimiento RECIENTE de BTC
   * y compararlo con el precio ACTUAL de Polymarket.
   *
   * CAMBIO CRÍTICO: No usar precio base 0.50, sino ajustar INCREMENTALMENTE
   * desde el precio actual de Polymarket. Esto evita edges irreales de 100%+
   * cuando el mercado ya se movió significativamente.
   * 
   * Ejemplo:
   * - Polymarket está en YES=0.25 (BTC bajó mucho)
   * - BTC rebota +0.04% → fairYes = 0.25 + ajuste incremental
   * - Edge realista: 5-10%, NO 135%
   */
  _calcEdge(direction, movePct, absZ) {
    // Si no tenemos precio de Polymarket, no podemos calcular edge
    if (this.polyYesPrice === null) {
      return {
        hasEdge: false,
        fairYes: null,
        fairNo: null,
        polyYes: null,
        polyNo: null,
        edgePct: null,
        side: direction === 'UP' ? 'BUY_YES' : 'BUY_NO',
        reason: 'NO_POLY_PRICE',
      };
    }

    // Staleness check: si el precio de Poly tiene más de MAX_PRICE_AGE_MS, invalidar
    const polyAge = Date.now() - this.polyUpdatedAt;
    const MAX_AGE = config.MAX_PRICE_AGE_MS || 5000; // 5 segundos (antes 3)
    
    if (polyAge > MAX_AGE) {
      return {
        hasEdge: false,
        fairYes: null,
        polyYes: this.polyYesPrice,
        edgePct: null,
        side: direction === 'UP' ? 'BUY_YES' : 'BUY_NO',
        reason: 'POLY_PRICE_STALE',
        age: polyAge,
        maxAge: MAX_AGE,
      };
    }

    // Sensibilidad: cuanto se mueve el precio justo por cada 0.1% de BTC
    // Aumentado de 2.5 a 5.0 para capturar más oportunidades
    const SENSITIVITY = config.POLY_SENSITIVITY || 5.0;

    const absMoveP = Math.abs(movePct);
    // Ajuste en puntos de probabilidad (0-1 scale)
    const adjustment = Math.min((absMoveP / 0.1) * (SENSITIVITY / 100), 0.25); // max 25 puntos

    // ✅ CAMBIO CRÍTICO: Ajustar desde el precio ACTUAL, no desde 0.50
    let fairYes, fairNo;
    
    if (direction === 'UP') {
      // BTC subió → YES debería subir
      fairYes = Math.min(0.90, this.polyYesPrice + adjustment);
      fairNo = 1 - fairYes;
    } else {
      // BTC bajó → YES debería bajar (NO debería subir)
      fairYes = Math.max(0.10, this.polyYesPrice - adjustment);
      fairNo = 1 - fairYes;
    }

    // Calcular edge
    if (direction === 'UP') {
      // Queremos comprar YES: edge = (fairYes - polyYes) / polyYes
      const edgePct = ((fairYes - this.polyYesPrice) / this.polyYesPrice) * 100;
      const hasEdge = edgePct >= (config.MIN_EDGE_PCT || 2.5);
      
      return {
        hasEdge,
        fairYes: parseFloat(fairYes.toFixed(3)),
        polyYes: this.polyYesPrice,
        edgePct: parseFloat(edgePct.toFixed(2)),
        side: 'BUY_YES',
        reason: hasEdge ? 'EDGE_FOUND' : 'EDGE_TOO_SMALL',
      };
    } else {
      // Queremos comprar NO: edge = (fairNo - polyNo) / polyNo
      const edgePct = ((fairNo - this.polyNoPrice) / this.polyNoPrice) * 100;
      const hasEdge = edgePct >= (config.MIN_EDGE_PCT || 2.5);
      
      return {
        hasEdge,
        fairYes: parseFloat(fairYes.toFixed(3)),
        polyYes: this.polyYesPrice,
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
