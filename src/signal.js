/**
 * Motor de señales - Latencia Coinbase vs Polymarket
 *
 * Estrategia: Polymarket actualiza sus odds con 2-10 segundos de delay
 * respecto al precio real de BTC en Coinbase.
 *
 * Edge: Si BTC sube 0.05% en Coinbase, el mercado "BTC higher in 5min"
 * todavia cotiza como si BTC no se hubiera movido. Compramos YES barato
 * antes de que el mercado actualice.
 */

const config = require('./config');

class SignalEngine {
  constructor() {
    this.prices = [];
    this.timestamps = [];
    this.buyPressure = [];
    this.maxBuffer = config.SIGNAL_WINDOW;

    this.polyYesPrice = null;
    this.polyNoPrice = null;
    this.polyUpdatedAt = null;

    this._totalTicks = 0;
    this._totalSignals = 0;
    this._lastSignalTime = 0;
  }

  updatePolyPrice(yesPrice, noPrice) {
    this.polyYesPrice = yesPrice;
    this.polyNoPrice = noPrice;
    this.polyUpdatedAt = Date.now();
  }

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

    const mean = this.prices.reduce((a, b) => a + b, 0) / n;
    const variance = this.prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return null;

    const zScore = (currentPrice - mean) / stdDev;

    const shortWindow = Math.min(30, Math.floor(n / 3));
    const priceShortAgo = this.prices[n - shortWindow];
    const movePct = ((currentPrice - priceShortAgo) / priceShortAgo) * 100;

    const timeElapsedSec = (currentTimestamp - this.timestamps[n - shortWindow]) / 1000;
    const velocity = timeElapsedSec > 0 ? Math.abs(movePct) / timeElapsedSec : 0;

    const recentPressure = this.buyPressure.slice(-50);
    const buyRatio = recentPressure.reduce((a, b) => a + b, 0) / recentPressure.length;

    const absZ = Math.abs(zScore);
    const absMoveP = Math.abs(movePct);

    if (absZ < config.ZSCORE_THRESHOLD) return null;
    if (absMoveP < config.MOVE_PCT_THRESHOLD) return null;
    if (velocity < config.MIN_VELOCITY) return null;

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
               confidence: 0, timestamp: currentTimestamp, edge: null, bufferSize: this.prices.length };
    }

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
      edge,
      bufferSize: this.prices.length,
    };
  }

_calcEdge(direction, movePct, absZ) {
    if (this.polyYesPrice === null) {
      return { hasEdge: false, edgePct: null, reason: 'NO_POLY_PRICE',
               side: direction === 'UP' ? 'BUY_YES' : 'BUY_NO' };
    }

    const polyAge = Date.now() - this.polyUpdatedAt;
    const MAX_AGE = config.MAX_PRICE_AGE_MS || 3000;
    if (polyAge > MAX_AGE) {
      return { hasEdge: false, edgePct: null, polyYes: this.polyYesPrice,
               reason: 'POLY_PRICE_STALE', age: polyAge, maxAge: MAX_AGE,
               side: direction === 'UP' ? 'BUY_YES' : 'BUY_NO' };
    }

    const SENSITIVITY = config.POLY_SENSITIVITY || 2.5;
    const absMoveP = Math.abs(movePct);
    const adjustment = Math.min((absMoveP / 0.1) * (SENSITIVITY / 100), 0.10);

    let fairYes, fairNo;
    if (direction === 'UP') {
      fairYes = Math.min(0.95, this.polyYesPrice + adjustment);
      fairNo  = 1 - fairYes;
    } else {
      fairYes = Math.max(0.05, this.polyYesPrice - adjustment);
      fairNo  = 1 - fairYes;
    }

    if (direction === 'UP') {
      const edgePct = (fairYes - this.polyYesPrice) * 100;
      const hasEdge = edgePct >= (config.MIN_EDGE_PCT || 2);
      return {
        hasEdge,
        fairYes: parseFloat(fairYes.toFixed(3)),
        polyYes: this.polyYesPrice,
        edgePct: parseFloat(edgePct.toFixed(2)),
        side: 'BUY_YES',
        reason: hasEdge ? 'EDGE_FOUND' : 'EDGE_TOO_SMALL',
      };
    } else {
      const edgePct = (fairNo - this.polyNoPrice) * 100;
      const hasEdge = edgePct >= (config.MIN_EDGE_PCT || 2);
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
