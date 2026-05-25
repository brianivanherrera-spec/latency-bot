/**
 * P&L Tracker - Seguimiento de operaciones simuladas
 */
 
const { Logger } = require('./logger');
const signalLogger = require('./signal-logger');
const logger = new Logger('TRACKER');
 
const GAMMA_API = 'https://gamma-api.polymarket.com';
 
class PnLTracker {
  constructor() {
    this.positions = [];
    this.closed = [];
    this.totalPnL = 0;
    this.wins = 0;
    this.losses = 0;
  }
 
  openPosition({ marketId, gammaId, marketQuestion, side, price, size, endDate, posId }) {
    const pos = {
      id: posId || `POS_${Date.now()}`,
      marketId,
      gammaId,
      marketQuestion,
      side,
      entryPrice: price,
      size,
      usdcIn: parseFloat((price * size).toFixed(2)),
      endDate: new Date(endDate),
      openedAt: new Date(),
      status: 'OPEN',
    };
    this.positions.push(pos);
    logger.info(`Posicion abierta: ${pos.id} | ${side} ${size}t @ $${price} | USDC: $${pos.usdcIn}`);
    logger.info(`   Mercado: ${marketQuestion}`);
    logger.info(`   Cierre estimado: ${pos.endDate.toISOString()}`);
    return pos;
  }
 
  async checkClosedPositions() {
    const now = new Date();
    const toCheck = this.positions.filter(p => p.status === 'OPEN' && now > p.endDate);
 
    for (const pos of toCheck) {
      try {
        const result = await this._getMarketResult(pos.marketId, pos.gammaId);
        if (result === null) {
          logger.info(`Mercado ${pos.id} aun no resuelto, esperando...`);
          continue;
        }
        this._closePosition(pos, result);
      } catch (err) {
        logger.error(`Error chequeando posicion ${pos.id}: ${err.message}`);
      }
    }
  }
 
  async _getMarketResult(marketId, gammaId) {
    try {
      const id = gammaId || marketId;
      const res = await fetch(`${GAMMA_API}/markets/${id}`);
      if (!res.ok) {
        logger.warn(`Gamma market fetch failed: ${res.status} for ${id}`);
        return null;
      }
      const market = await res.json();

      // Log completo para diagnostico
      logger.info(`Market raw fields: resolved=${market.resolved} closed=${market.closed} active=${market.active} winner=${market.winner} resolutionPrice=${market.resolutionPrice} outcomePrices=${market.outcomePrices} winnerIndex=${market.winnerIndex}`);

      // La Gamma API puede indicar resolucion de varias formas
      const isResolved = market.resolved === true || market.closed === true || market.active === false;
      if (!isResolved) return null;

      // Forma 1: campo winner directo
      if (market.winner === 'YES' || market.winner === 'NO') {
        return market.winner;
      }

      // Forma 2: resolutionPrice (1 = YES gano, 0 = NO gano)
      if (market.resolutionPrice !== undefined && market.resolutionPrice !== null) {
        return parseFloat(market.resolutionPrice) === 1 ? 'YES' : 'NO';
      }

      // Forma 3: outcomePrices es un array JSON stringificado
      // Ej: '["1","0"]' => YES gano; '["0","1"]' => NO gano
      if (market.outcomePrices) {
        try {
          const prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices)
            : market.outcomePrices;
          if (parseFloat(prices[0]) === 1) return 'YES';
          if (parseFloat(prices[1]) === 1) return 'NO';
        } catch (_) {}
      }

      // Forma 4: winnerIndex (0 = YES, 1 = NO)
      if (market.winnerIndex !== undefined && market.winnerIndex !== null) {
        return market.winnerIndex === 0 ? 'YES' : 'NO';
      }

      // Forma 5: tokens con price — el que cerro en 1 gano
      if (market.tokens && Array.isArray(market.tokens)) {
        const yesToken = market.tokens.find(t => t.outcome === 'Yes' || t.outcome === 'YES');
        const noToken  = market.tokens.find(t => t.outcome === 'No'  || t.outcome === 'NO');
        if (yesToken && parseFloat(yesToken.price || yesToken.lastTradePrice) >= 0.99) return 'YES';
        if (noToken  && parseFloat(noToken.price  || noToken.lastTradePrice)  >= 0.99) return 'NO';
      }

      logger.warn(`Mercado ${id} resuelto pero no se pudo determinar ganador. JSON: ${JSON.stringify(market)}`);
      return null;

    } catch (err) {
      logger.error(`Error fetching market result: ${err.message}`);
      return null;
    }
  }
 
  _closePosition(pos, winner) {
    const won = (pos.side === 'BUY' && winner === 'YES') ||
                (pos.side === 'SELL' && winner === 'NO');
 
    let pnl;
    if (won) {
      pnl = parseFloat(((1 - pos.entryPrice) * pos.size).toFixed(2));
      this.wins++;
    } else {
      pnl = parseFloat((-pos.entryPrice * pos.size).toFixed(2));
      this.losses++;
    }
 
    this.totalPnL += pnl;
    pos.status = 'CLOSED';
    pos.winner = winner;
    pos.pnl = pnl;
    pos.closedAt = new Date();
 
    this.closed.push(pos);
    this.positions = this.positions.filter(p => p.id !== pos.id);
 
    const emoji = won ? 'WIN' : 'LOSS';
    logger.info(`[${emoji}] Posicion cerrada: ${pos.id}`);
    logger.info(`   Resultado: ${winner} | PnL: ${pnl > 0 ? '+' : ''}$${pnl}`);
    logger.info(`   P&L Total acumulado: ${this.totalPnL > 0 ? '+' : ''}$${this.totalPnL.toFixed(2)} | W:${this.wins} L:${this.losses}`);
    // Registrar resultado en signal logger
    signalLogger.logSignalClose(pos.id, won ? 'WIN' : 'LOSS', pnl);
  }
 
  getSummary() {
    const total = this.wins + this.losses;
    const winRate = total > 0 ? ((this.wins / total) * 100).toFixed(1) : '0.0';
    return {
      openPositions: this.positions.length,
      closedPositions: this.closed.length,
      wins: this.wins,
      losses: this.losses,
      winRate: `${winRate}%`,
      totalPnL: `${this.totalPnL > 0 ? '+' : ''}$${this.totalPnL.toFixed(2)}`,
    };
  }
 
  printSummary() {
    const s = this.getSummary();
    logger.info('=== RESUMEN P&L ===');
    logger.info(`Posiciones abiertas: ${s.openPositions}`);
    logger.info(`Cerradas: ${s.closedPositions} | Wins: ${s.wins} | Losses: ${s.losses}`);
    logger.info(`Win Rate: ${s.winRate}`);
    logger.info(`P&L Total: ${s.totalPnL}`);
    logger.info('==================');
  }
}
 
module.exports = { PnLTracker };
