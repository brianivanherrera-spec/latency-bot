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

    // Orderbook imbalance buffer
    this.imbalances = [];   // (bidQty - askQty) / (bidQty + askQty)
    this.spreads = [];      // best_ask - best_bid
    this.tickFrequency = []; // timestamps para calcular frecuencia
  }

  updatePolyPrice(yesPrice, noPrice) {
    this.polyYesPrice = yesPrice;
    this.polyNoPrice = noPrice;
    this.polyUpdatedAt = Date.now();
  }

  process({ price, timestamp, isBuyerMaker, bidQty = 0, askQty = 0, spread = 0 }) {
    this._totalTicks++;

    this.prices.push(price);
    this.timestamps.push(timestamp);
    this.buyPressure.push(isBuyerMaker ? 0 : 1);
    this.tickFrequency.push(timestamp);

    // Orderbook imbalance: +1 = todo bids, -1 = todo asks
    const totalQty = bidQty + askQty;
    const imbalance = totalQty > 0 ? (bidQty - askQty) / totalQty : 0;
    this.imbalances.push(imbalance);
    this.spreads.push(spread);

    if (this.prices.length > this.maxBuffer) {
      this.prices.shift();
      this.timestamps.shift();
      this.buyPressure.shift();
      this.imbalances.shift();
      this.spreads.shift();
    }
    // Mantener solo los últimos 60 timestamps para frecuencia
    if (this.tickFrequency.length > 60) this.tickFrequency.shift();

    if (this.prices.length < config.MIN_TICKS_REQUIRED) return null;

    return this._evaluate(price, timestamp);
  }

  // ─── Orderbook imbalance promedio (últimos N ticks) ─────────────────
  _avgImbalance(window = 20) {
    const recent = this.imbalances.slice(-window);
    if (!recent.length) return 0;
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  // ─── Spread promedio vs spread actual ────────────────────────────────
  _spreadSignal(window = 20) {
    const recent = this.spreads.slice(-window);
    if (!recent.length) return 1;
    const avgSpread = recent.reduce((a, b) => a + b, 0) / recent.length;
    const currentSpread = this.spreads[this.spreads.length - 1] || avgSpread;
    return currentSpread / (avgSpread || 1); // >1 = spread amplio = más volátil
  }

  // ─── Frecuencia de ticks (últimos 10 segundos) ───────────────────────
  _tickFrequency() {
    const now = Date.now();
    const last10s = this.tickFrequency.filter(t => now - t < 10000);
    return last10s.length; // ticks en los últimos 10 segundos
  }

  // ─── RSI sobre el buffer de precios ──────────────────────────────────
  _rsi(period = 14) {
    if (this.prices.length < period + 1) return 50;
    const recent = this.prices.slice(-(period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i < recent.length; i++) {
      const diff = recent[i] - recent[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // ─── Tendencia macro: precio hace N ticks vs ahora ─────────────────
  // Retorna 'UP', 'DOWN' o 'FLAT' según la dirección dominante
  _macroTrend(currentPrice, windowTicks = 150) {
    const n = this.prices.length;
    if (n < windowTicks) return 'FLAT';
    const priceThen = this.prices[n - windowTicks];
    const changePct = ((currentPrice - priceThen) / priceThen) * 100;
    if (changePct > 0.04) return 'UP';
    if (changePct < -0.04) return 'DOWN';
    return 'FLAT';
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

    // ─── Filtro de tendencia macro ────────────────────────────────────
    if (direction !== 'NEUTRAL') {
      const macro = this._macroTrend(currentPrice);
      if (macro === 'UP' && direction === 'DOWN') return null;
      if (macro === 'DOWN' && direction === 'UP') return null;
    }

    // ─── Filtro orderbook imbalance ───────────────────────────────────
    // Datos reales: imbalance >0.3 (buyers dominan fuerte) = 42% WR — bloquear
    const imbalance = this._avgImbalance(20);
    if (Math.abs(imbalance) > config.IMBALANCE_MAX) return null;

    const spreadRatio = this._spreadSignal(20);
    const tickFreq = this._tickFrequency();
    const rsi = this._rsi(14);

    // ─── Filtro RSI (125 trades reales) ──────────────────────────────────
    // RSI 40-80: 17-43% WR → no entrar
    // RSI <40 o >80: 52-83% WR → señales confiables
    if (rsi >= 40 && rsi <= 80) return null;

    if (direction === 'NEUTRAL') {
      this._totalSignals++;
      return { direction, zScore, movePct, velocity, buyRatio, currentPrice, mean, stdDev,
               confidence: 0, timestamp: currentTimestamp, edge: null, bufferSize: this.prices.length,
               imbalance, spreadRatio, tickFreq, rsi, signalScore: 0 };
    }

    // ─── Signal Score (calibrado con 125 trades reales) ───────────────────
    // Gate mínimo: score >= 55 → 77.1% WR sobre 48 trades
    // Sin hora en el score (las horas las maneja TRADING_HOURS_BLOCKED_UTC)
    const signalScore = this._calcSignalScore(rsi, absZ, imbalance, direction);
    const MIN_SCORE = config.MIN_SIGNAL_SCORE || 60;
    const MAX_SCORE = config.MAX_SIGNAL_SCORE || 89;
    // Score 90-99: 53% WR — señales en momentos extremos donde el mercado ya se movió
    if (signalScore < MIN_SCORE || signalScore > MAX_SCORE) return null;

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
      imbalance,      // orderbook imbalance [-1, +1]
      spreadRatio,    // spread actual vs promedio (>1 = más volátil)
      tickFreq,       // ticks en últimos 10s (volumen proxy)
      rsi,            // RSI sobre buffer de precios
      signalScore,    // score de calidad 0-100
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

  // ─── Signal Score — calibrado con 125 trades reales ──────────────────────
  // RSI 20-30 DOWN: 83% WR (+22) | Z 3-4: 69% WR (+14) | imb>0.3: 42% WR (-18)
  // DOWN sistemáticamente mejor que UP (+8 DOWN, -5 UP)
  _calcSignalScore(rsi, absZ, imbalance, direction) {
    let score = 50;

    // RSI contribution
    if      (rsi < 20)  score += 12;
    else if (rsi < 30)  score += 22;  // sweet spot DOWN: 83% WR
    else if (rsi < 40)  score += 6;
    else if (rsi < 60)  score -= 12;
    else if (rsi < 80)  score -= 25;  // peor bucket: 17% WR
    else if (rsi < 90)  score += 6;
    else                score += 3;   // 90-100: 52% WR, moderado

    // Z-score contribution
    if      (absZ < 1.5) score -= 20;
    else if (absZ < 2)   score += 4;
    else if (absZ < 2.5) score += 12; // 66% WR
    else if (absZ < 3)   score += 7;
    else if (absZ < 4)   score += 14; // 69% WR — mejor bucket
    else                 score += 5;

    // Imbalance contribution
    if      (imbalance > 0.3)                         score -= 18; // 42% WR
    else if (imbalance < 0 && direction === 'DOWN')   score += 8;
    else if (imbalance > 0 && direction === 'UP')     score += 5;

    // Dirección — DOWN 62% WR vs UP 49% WR
    if (direction === 'DOWN') score += 8;
    else                      score -= 5;

    return Math.min(Math.max(score, 0), 100);
  }
}

module.exports = { SignalEngine };
