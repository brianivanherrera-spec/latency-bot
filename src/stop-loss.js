/**
 * Daily Stop Loss Protection
 * Para el bot con parámetros de $50 capital, $5 por trade
 */

const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('STOP-LOSS');

class DailyStopLoss {
  constructor() {
    this.dailyPnL = 0;
    this.consecutiveLosses = 0;
    this.tradesToday = 0;
    this.lastResetDate = this._getTodayString();
    
    // Límites
    this.MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS_USD || '5'); // $5 = 10% del capital
    this.MAX_CONSECUTIVE_LOSSES = parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '3');
    this.MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '50');
    
    this.isStopped = false;
    this.stopReason = null;
    
    logger.info(`Stop Loss inicializado:`);
    logger.info(`  Max pérdida diaria: $${this.MAX_DAILY_LOSS}`);
    logger.info(`  Max pérdidas consecutivas: ${this.MAX_CONSECUTIVE_LOSSES}`);
    logger.info(`  Max trades/día: ${this.MAX_TRADES_PER_DAY}`);
  }

  /**
   * Resetear contadores a medianoche
   */
  _checkDailyReset() {
    const today = this._getTodayString();
    if (today !== this.lastResetDate) {
      logger.info(`🌅 Nuevo día: ${today}`);
      logger.info(`  P&L día anterior: ${this.dailyPnL >= 0 ? '+' : ''}$${this.dailyPnL.toFixed(2)}`);
      logger.info(`  Trades día anterior: ${this.tradesToday}`);
      
      this.dailyPnL = 0;
      this.consecutiveLosses = 0;
      this.tradesToday = 0;
      this.lastResetDate = today;
      this.isStopped = false;
      this.stopReason = null;
    }
  }

  _getTodayString() {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  }

  /**
   * Verificar si se puede tradear
   */
  canTrade() {
    this._checkDailyReset();
    
    if (this.isStopped) {
      logger.warn(`⛔ Trading detenido: ${this.stopReason}`);
      return false;
    }
    
    // Check 1: Pérdida diaria máxima
    if (this.dailyPnL <= -this.MAX_DAILY_LOSS) {
      this._stop(`Pérdida diaria alcanzada: $${this.dailyPnL.toFixed(2)} (límite: -$${this.MAX_DAILY_LOSS})`);
      return false;
    }
    
    // Check 2: Pérdidas consecutivas
    if (this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
      this._stop(`${this.consecutiveLosses} pérdidas consecutivas (límite: ${this.MAX_CONSECUTIVE_LOSSES})`);
      return false;
    }
    
    // Check 3: Max trades por día
    if (this.tradesToday >= this.MAX_TRADES_PER_DAY) {
      this._stop(`Max trades alcanzado: ${this.tradesToday}/${this.MAX_TRADES_PER_DAY}`);
      return false;
    }
    
    return true;
  }

  /**
   * Registrar resultado de trade
   */
  recordTrade(pnl) {
    this._checkDailyReset();
    
    this.tradesToday++;
    this.dailyPnL += pnl;
    
    if (pnl < 0) {
      this.consecutiveLosses++;
      logger.warn(`❌ Pérdida: $${pnl.toFixed(2)} | Consecutivas: ${this.consecutiveLosses} | P&L día: $${this.dailyPnL.toFixed(2)}`);
    } else {
      this.consecutiveLosses = 0; // Reset en win
      logger.info(`✅ Ganancia: +$${pnl.toFixed(2)} | P&L día: +$${this.dailyPnL.toFixed(2)}`);
    }
    
    // Warning si nos acercamos a límites
    if (this.dailyPnL <= -this.MAX_DAILY_LOSS * 0.7) {
      logger.warn(`⚠️  P&L diario bajo: $${this.dailyPnL.toFixed(2)} (70% del límite)`);
    }
    
    if (this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES - 1) {
      logger.warn(`⚠️  ${this.consecutiveLosses} pérdidas consecutivas (1 más = stop)`);
    }
  }

  _stop(reason) {
    this.isStopped = true;
    this.stopReason = reason;
    logger.error(`⛔⛔⛔ TRADING DETENIDO ⛔⛔⛔`);
    logger.error(`  Razón: ${reason}`);
    logger.error(`  P&L hoy: $${this.dailyPnL.toFixed(2)}`);
    logger.error(`  Trades hoy: ${this.tradesToday}`);
    logger.error(`  Reinicio: Medianoche UTC`);
  }

  /**
   * Obtener stats actuales
   */
  getStats() {
    this._checkDailyReset();
    
    return {
      dailyPnL: parseFloat(this.dailyPnL.toFixed(2)),
      consecutiveLosses: this.consecutiveLosses,
      tradesToday: this.tradesToday,
      isStopped: this.isStopped,
      stopReason: this.stopReason,
      limitsRemaining: {
        pnl: parseFloat((this.MAX_DAILY_LOSS + this.dailyPnL).toFixed(2)),
        consecutiveLosses: this.MAX_CONSECUTIVE_LOSSES - this.consecutiveLosses,
        trades: this.MAX_TRADES_PER_DAY - this.tradesToday,
      },
    };
  }

  /**
   * Override manual del stop (usar con cuidado)
   */
  reset() {
    logger.warn('⚠️  Stop loss reseteado manualmente');
    this.isStopped = false;
    this.stopReason = null;
  }
}

module.exports = { DailyStopLoss };
