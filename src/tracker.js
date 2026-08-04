/**
 * P&L Tracker - Seguimiento de operaciones simuladas
 */
 
const { Logger } = require('./logger');
const signalLogger = require('./signal-logger');
const logger = new Logger('TRACKER');
 
const GAMMA_API = 'https://gamma-api.polymarket.com';
 
const fs = require('fs');
const POSITIONS_FILE = process.env.POSITIONS_FILE || '/data/positions.json';

class PnLTracker {
  constructor() {
    this.positions = [];
    this.closed = [];
    this.totalPnL = 0;
    this.wins = 0;
    this.losses = 0;
    this._loadFromDisk();
  }

  // Cargar posiciones abiertas desde disco (sobrevive redeploys)
  _loadFromDisk() {
    try {
      if (fs.existsSync(POSITIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
        // Solo restaurar posiciones que aún no vencieron
        const now = new Date();
        const active = (data.positions || []).filter(p => new Date(p.endDate) > now);
        if (active.length > 0) {
          // Convertir endDate a Date object
          this.positions = active.map(p => ({ ...p, endDate: new Date(p.endDate) }));
          this.totalPnL = data.totalPnL || 0;
          this.wins = data.wins || 0;
          this.losses = data.losses || 0;
          logger.info(`[TRACKER] ✅ Restauradas ${this.positions.length} posiciones desde disco`);
        }
      }
    } catch (e) {
      logger.warn(`[TRACKER] No se pudo restaurar posiciones: ${e.message}`);
    }
  }

  // Guardar posiciones abiertas en disco
  _saveToDisk() {
    try {
      const data = {
        positions: this.positions,
        totalPnL: this.totalPnL,
        wins: this.wins,
        losses: this.losses,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      // No crítico — el bot sigue operando
    }
  }
 
  openPosition({ marketId, gammaId, marketQuestion, side, price, size, endDate, posId, entryType, tokenId }) {
    const pos = {
      id: posId || `POS_${Date.now()}`,
      marketId,
      gammaId,
      marketQuestion,
      side,
      tokenId,        // necesario para el position monitor (SL/TP/lock-in)
      entryPrice: price,
      size,
      usdcIn: parseFloat((price * size).toFixed(2)),
      endDate: new Date(endDate),
      openedAt: new Date(),
      status: 'OPEN',
      entryType: entryType || 'early',
    };
    this.positions.push(pos);
    this._saveToDisk();
    logger.info(`Posicion abierta: ${pos.id} | ${side} ${size}t @ $${price} | USDC: $${pos.usdcIn}`);
    logger.info(`   Mercado: ${marketQuestion}`);
    logger.info(`   Cierre estimado: ${pos.endDate.toISOString()}`);
    return pos;
  }
 
  async checkClosedPositions() {
    const now = new Date();
    // Chequear TODAS las posiciones abiertas — Polymarket puede resolver antes del endDate
    const toCheck = this.positions.filter(p => p.status === 'OPEN');
 
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

      // PRIORITARIO: outcomePrices — Polymarket los actualiza antes que closed/resolved
      // ["1","0"] = YES ganó | ["0","1"] = NO ganó
      if (market.outcomePrices) {
        try {
          const prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices)
            : market.outcomePrices;
          if (parseFloat(prices[0]) >= 0.99) return 'YES';
          if (parseFloat(prices[1]) >= 0.99) return 'NO';
        } catch (_) {}
      }

      // Fallback: campos estándar de resolución
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

      // winnerIndex (0 = YES, 1 = NO)
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
    // Intentar con pos.id y pos.posId (ambos formatos usados)
    const signalId = pos.posId || pos.id;
    signalLogger.logSignalClose(signalId, won ? 'WIN' : 'LOSS', pnl);
    this._saveToDisk(); // persistir resultado
  }

  // Para el position monitor: devuelve las posiciones actualmente abiertas
  getOpenPositions() {
    return this.positions.filter(p => p.status === 'OPEN');
  }

  // Cierre forzado por SL/TP — registra el PnL real de la venta anticipada
  forceClosePosition(posId, pnl, reason) {
    const pos = this.positions.find(p => p.id === posId);
    if (!pos) return;
    pos.status = 'CLOSED';
    pos.pnl = pnl;
    pos.closedAt = new Date();
    pos.closeReason = reason;
    this.totalPnL += pnl;
    if (pnl >= 0) this.wins++; else this.losses++;
    this.closed.push(pos);
    this.positions = this.positions.filter(p => p.id !== posId);
    const emoji = pnl >= 0 ? 'WIN' : 'LOSS';
    logger.info(`[${emoji}] [POSITION-MONITOR] Posicion cerrada anticipadamente: ${posId}`);
    logger.info(`   Razón: ${reason} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl}`);
    logger.info(`   P&L Total acumulado: ${this.totalPnL > 0 ? '+' : ''}$${this.totalPnL.toFixed(2)} | W:${this.wins} L:${this.losses}`);
    const signalId = pos.posId || pos.id;
    signalLogger.logSignalClose(signalId, pnl >= 0 ? 'WIN' : 'LOSS', pnl);
    this._saveToDisk();
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
