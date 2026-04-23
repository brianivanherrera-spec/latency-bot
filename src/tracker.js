/**
 * P&L Tracker - Seguimiento de operaciones simuladas
 */

const { Logger } = require('./logger');
const logger = new Logger('TRACKER');

const GAMMA_API = 'https://gamma-api.polymarket.com';

class PnLTracker {
  constructor() {
    this.positions = [];     // posiciones abiertas
    this.closed = [];        // posiciones cerradas
    this.totalPnL = 0;
    this.wins = 0;
    this.losses = 0;
  }

openPosition({ marketId, gammaId, marketQuestion, side, price, size, endDate }) {
  const pos = {
    ...
    gammaId,  // agregar esta línea
    ...
  };
    this.positions.push(pos);
    logger.info(`📂 Posición abierta: ${pos.id} | ${side} ${size}t @ $${price} | USDC: $${pos.usdcIn}`);
    logger.info(`   Mercado: ${marketQuestion}`);
    logger.info(`   Cierre estimado: ${pos.endDate.toISOString()}`);
    return pos;
  }

  async checkClosedPositions() {
    const now = new Date();
    const toCheck = this.positions.filter(p => p.status === 'OPEN' && now > p.endDate);

    for (const pos of toCheck) {
      try {
        const result = await this._getMarketResult(pos.marketId);
        if (result === null) continue; // mercado aún no resuelto

        this._closePosition(pos, result);
      } catch (err) {
        logger.error(`Error chequeando posición ${pos.id}: ${err.message}`);
      }
    }
  }

async _getMarketResult(marketId) {
  try {
    const res = await fetch(`${GAMMA_API}/markets/${marketId}`);
    if (!res.ok) {
      logger.warn(`Gamma market fetch failed: ${res.status} for ${marketId}`);
      return null;
    }
    const market = await res.json();
    logger.info(`Market status: resolved=${market.resolved} winner=${market.winner} resolutionPrice=${market.resolutionPrice}`);

    if (!market.resolved) return null;

    return market.winner || (market.resolutionPrice === 1 ? 'YES' : 'NO');
  } catch (err) {
    logger.error(`Error fetching market result: ${err.message}`);
    return null;
  }
}

  _closePosition(pos, winner) {
    // Determinar si ganamos
    // BUY YES token → ganamos si winner=YES
    // SELL YES token → ganamos si winner=NO
    const won = (pos.side === 'BUY' && winner === 'YES') ||
                (pos.side === 'SELL' && winner === 'NO');

    let pnl;
    if (won) {
      // Ganancia: cobramos $1 por token, pagamos entryPrice
      pnl = parseFloat(((1 - pos.entryPrice) * pos.size).toFixed(2));
      this.wins++;
    } else {
      // Pérdida: perdemos lo que pusimos
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

    const emoji = won ? '✅' : '❌';
    logger.info(`${emoji} Posición cerrada: ${pos.id}`);
    logger.info(`   Resultado: ${winner} | PnL: ${pnl > 0 ? '+' : ''}$${pnl}`);
    logger.info(`   P&L Total acumulado: ${this.totalPnL > 0 ? '+' : ''}$${this.totalPnL.toFixed(2)} | W:${this.wins} L:${this.losses}`);
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
    logger.info('=== 📊 RESUMEN P&L ===');
    logger.info(`Posiciones abiertas: ${s.openPositions}`);
    logger.info(`Cerradas: ${s.closedPositions} | Wins: ${s.wins} | Losses: ${s.losses}`);
    logger.info(`Win Rate: ${s.winRate}`);
    logger.info(`P&L Total: ${s.totalPnL}`);
    logger.info('====================');
  }
}

module.exports = { PnLTracker };
