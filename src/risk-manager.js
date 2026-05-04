/**
 * Risk Manager - Gestión de riesgo y límites
 */

const { Logger } = require('./logger');
const config = require('./config');

const logger = new Logger('RISK');

class RiskManager {
  constructor() {
    // Límites configurables
    this.limits = {
      maxPositions: config.MAX_POSITIONS || 5,
      maxTotalExposure: config.MAX_TOTAL_EXPOSURE_USDC || 100,
      maxPositionSize: config.MAX_POSITION_SIZE_USDC || 20,
      stopLossPercent: config.STOP_LOSS_PERCENT || 10,
      maxEdgePercent: config.MAX_REALISTIC_EDGE || 15, // edges >15% son sospechosos
      minEdgePercent: config.MIN_EDGE_PCT || 2,
    };
    
    // Estado actual
    this.openPositions = [];
    this.closedPositions = [];
    this.totalExposure = 0;
    this.totalPnL = 0;
    
    logger.info(`✓ Risk Manager inicializado:`);
    logger.info(`  Max posiciones: ${this.limits.maxPositions}`);
    logger.info(`  Max exposición total: $${this.limits.maxTotalExposure}`);
    logger.info(`  Max por posición: $${this.limits.maxPositionSize}`);
    logger.info(`  Stop loss: ${this.limits.stopLossPercent}%`);
  }

  /**
   * Validar si se puede abrir una nueva posición
   */
  canOpenPosition(orderSize) {
    const checks = {
      maxPositions: this.openPositions.length < this.limits.maxPositions,
      maxExposure: (this.totalExposure + orderSize) <= this.limits.maxTotalExposure,
      maxPositionSize: orderSize <= this.limits.maxPositionSize,
      stopLoss: this.totalPnL > -(this.limits.maxTotalExposure * this.limits.stopLossPercent / 100),
    };
    
    const canOpen = Object.values(checks).every(v => v);
    
    if (!canOpen) {
      const failures = Object.entries(checks)
        .filter(([_, passed]) => !passed)
        .map(([check, _]) => check);
      
      logger.warn(`❌ Posición rechazada por límites: ${failures.join(', ')}`);
      logger.warn(`   Posiciones: ${this.openPositions.length}/${this.limits.maxPositions}`);
      logger.warn(`   Exposición: $${this.totalExposure.toFixed(2)}/$${this.limits.maxTotalExposure}`);
      logger.warn(`   Tamaño orden: $${orderSize.toFixed(2)} (max: $${this.limits.maxPositionSize})`);
      logger.warn(`   P&L total: $${this.totalPnL.toFixed(2)}`);
    }
    
    return {
      allowed: canOpen,
      checks,
      reason: canOpen ? 'OK' : failures.join(', '),
    };
  }

  /**
   * Validar edge
   */
  validateEdge(edgePercent) {
    if (edgePercent === null || edgePercent === undefined) {
      return { valid: false, reason: 'NO_EDGE' };
    }
    
    if (edgePercent < this.limits.minEdgePercent) {
      return { 
        valid: false, 
        reason: 'EDGE_TOO_SMALL',
        edge: edgePercent,
        min: this.limits.minEdgePercent,
      };
    }
    
    if (Math.abs(edgePercent) > this.limits.maxEdgePercent) {
      return { 
        valid: false, 
        reason: 'EDGE_SUSPICIOUS',
        edge: edgePercent,
        max: this.limits.maxEdgePercent,
        message: 'Edge demasiado alto - probablemente precio stale',
      };
    }
    
    return { valid: true, edge: edgePercent };
  }

  /**
   * Registrar nueva posición
   */
  openPosition(position) {
    const positionId = `POS_${Date.now()}`;
    const exposure = position.price * position.size;
    
    const pos = {
      id: positionId,
      ...position,
      exposure,
      openedAt: Date.now(),
      status: 'OPEN',
      pnl: 0,
    };
    
    this.openPositions.push(pos);
    this.totalExposure += exposure;
    
    logger.info(`✓ Posición abierta: ${positionId}`);
    logger.info(`  Mercado: ${position.marketQuestion}`);
    logger.info(`  ${position.side} ${position.size} @ $${position.price}`);
    logger.info(`  Exposición: $${exposure.toFixed(2)}`);
    logger.info(`  Total exposición: $${this.totalExposure.toFixed(2)}/$${this.limits.maxTotalExposure}`);
    logger.info(`  Posiciones abiertas: ${this.openPositions.length}/${this.limits.maxPositions}`);
    
    return positionId;
  }

  /**
   * Cerrar posición
   */
  closePosition(positionId, exitPrice, outcome) {
    const idx = this.openPositions.findIndex(p => p.id === positionId);
    if (idx === -1) {
      logger.warn(`Posición ${positionId} no encontrada`);
      return null;
    }
    
    const position = this.openPositions[idx];
    const pnl = this._calculatePnL(position, exitPrice, outcome);
    
    position.status = 'CLOSED';
    position.closedAt = Date.now();
    position.exitPrice = exitPrice;
    position.outcome = outcome;
    position.pnl = pnl;
    position.holdTime = position.closedAt - position.openedAt;
    
    // Mover a cerradas
    this.closedPositions.push(position);
    this.openPositions.splice(idx, 1);
    
    // Actualizar totales
    this.totalExposure -= position.exposure;
    this.totalPnL += pnl;
    
    logger.info(`${pnl >= 0 ? '✓' : '❌'} Posición cerrada: ${positionId}`);
    logger.info(`  P&L: $${pnl.toFixed(2)}`);
    logger.info(`  Tiempo: ${Math.round(position.holdTime / 1000)}s`);
    logger.info(`  P&L total acumulado: $${this.totalPnL.toFixed(2)}`);
    
    return position;
  }

  _calculatePnL(position, exitPrice, outcome) {
    // Simplificado: asumimos que compramos y el mercado resolvió
    // En realidad sería más complejo con diferentes tipos de órdenes
    
    if (position.side === 'BUY') {
      // Compramos YES/NO
      if (outcome === 'YES' && position.tokenId === position.yesTokenId) {
        return position.size * (1 - position.price); // ganamos 1-precio por token
      } else if (outcome === 'NO' && position.tokenId === position.noTokenId) {
        return position.size * (1 - position.price);
      } else {
        return -position.size * position.price; // perdimos lo invertido
      }
    } else {
      // SELL (más complejo, por ahora simplificado)
      return 0;
    }
  }

  /**
   * Verificar si alguna posición llegó a stop loss
   */
  checkStopLoss() {
    const stopLossLimit = -(this.limits.maxTotalExposure * this.limits.stopLossPercent / 100);
    
    if (this.totalPnL <= stopLossLimit) {
      logger.error(`🚨 STOP LOSS ACTIVADO!`);
      logger.error(`   P&L total: $${this.totalPnL.toFixed(2)}`);
      logger.error(`   Límite: $${stopLossLimit.toFixed(2)}`);
      logger.error(`   Cerrando todas las posiciones...`);
      
      return true;
    }
    
    return false;
  }

  /**
   * Obtener resumen del estado
   */
  getSummary() {
    const winRate = this.closedPositions.length > 0
      ? (this.closedPositions.filter(p => p.pnl > 0).length / this.closedPositions.length * 100)
      : 0;
    
    const avgPnL = this.closedPositions.length > 0
      ? this.closedPositions.reduce((sum, p) => sum + p.pnl, 0) / this.closedPositions.length
      : 0;
    
    return {
      openPositions: this.openPositions.length,
      closedPositions: this.closedPositions.length,
      totalExposure: this.totalExposure,
      totalPnL: this.totalPnL,
      winRate: winRate.toFixed(1),
      avgPnL: avgPnL.toFixed(2),
      limits: this.limits,
    };
  }

  /**
   * Imprimir resumen
   */
  printSummary() {
    const summary = this.getSummary();
    
    logger.info('─'.repeat(60));
    logger.info('📊 RESUMEN DE RIESGO');
    logger.info('─'.repeat(60));
    logger.info(`  Posiciones abiertas: ${summary.openPositions}/${this.limits.maxPositions}`);
    logger.info(`  Posiciones cerradas: ${summary.closedPositions}`);
    logger.info(`  Exposición actual: $${summary.totalExposure.toFixed(2)}/$${this.limits.maxTotalExposure}`);
    logger.info(`  P&L total: ${summary.totalPnL >= 0 ? '+' : ''}$${summary.totalPnL.toFixed(2)}`);
    logger.info(`  Win rate: ${summary.winRate}%`);
    logger.info(`  Avg P&L/trade: $${summary.avgPnL}`);
    logger.info('─'.repeat(60));
  }

  /**
   * Exportar historial
   */
  getHistory() {
    return {
      open: this.openPositions,
      closed: this.closedPositions,
    };
  }
}

module.exports = { RiskManager };
