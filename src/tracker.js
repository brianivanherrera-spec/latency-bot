/**
 * P&L Tracker - Seguimiento de operaciones simuladas
 */
 
const { Logger } = require('./logger');
const signalLogger = require('./signal-logger');
const logger = new Logger('TRACKER');
 
const GAMMA_API = 'https://gamma-api.polymarket.com';
// Minutos tras el fin del mercado sin 'closed' oficial antes de resolver con precios >= 0.95
const RESOLVE_GRACE_MIN = parseFloat(process.env.RESOLVE_GRACE_MIN || '20');
 
const fs = require('fs');
const config = require('./config');
const POSITIONS_FILE = process.env.POSITIONS_FILE || '/data/positions.json';

// Comisión simulada en paper: % sobre el monto de cada compra/venta (taker).
// 0 = sin comisión. Poner la tasa real de Polymarket para estos mercados.
// 01/10 16:24: POS_1790870794783 (−$4.83) se contó dos veces — por la corrección y por la
// resolución normal al restaurarse. Se devuelve una de las dos.
const ADJUSTMENTS = [
  { id: 'dup-POS_1790870794783', pnl: 4.83, losses: -1 },
];
// Posiciones vencidas hace menos de esto se restauran al arrancar para resolverlas
const RESTORE_MAX_AGE_MIN = parseInt(process.env.RESTORE_MAX_AGE_MIN || '120');
const PAPER_FEE = config.DRY_RUN ? (parseFloat(process.env.PAPER_FEE_PCT || '0') || 0) / 100 : 0;
const fee = (notional) => parseFloat((notional * PAPER_FEE).toFixed(4));
// Comisión taker de Polymarket en mercados cripto: 0.07·p·(1−p) USDC por acción, se paga
// al comprar. Se aplica al P&L de paper (PAPER_TAKER_FEE=false la apaga); en real ya la
// cobra el exchange.
const TAKER_FEE_RATE = parseFloat(process.env.TAKER_FEE_RATE || '0.07');
const PAPER_TAKER_FEE = config.DRY_RUN && process.env.PAPER_TAKER_FEE !== 'false';
const takerFee = (p, shares) => PAPER_TAKER_FEE
  ? parseFloat((TAKER_FEE_RATE * p * (1 - p) * shares).toFixed(4)) : 0;

class PnLTracker {
  constructor() {
    this.positions = [];
    this.closed = [];
    this.totalPnL = 0;
    this.wins = 0;
    this.losses = 0;
    // P&L del día UTC en curso, para MAX_DAILY_LOSS_USDC (se guarda en disco: sobrevive redeploys)
    this.dailyKey = null;
    this.dailyPnL = 0;
    this._loadFromDisk();
  }

  _addDaily(pnl) {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== this.dailyKey) { this.dailyKey = key; this.dailyPnL = 0; }
    this.dailyPnL = parseFloat((this.dailyPnL + pnl).toFixed(2));
  }

  getDailyPnL() {
    return this.dailyKey === new Date().toISOString().slice(0, 10) ? this.dailyPnL : 0;
  }

  // Cargar posiciones abiertas desde disco (sobrevive redeploys)
  _loadFromDisk() {
    try {
      if (fs.existsSync(POSITIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
        // Restaurar también las que vencieron hace poco y esperan el resultado en Gamma:
        // antes solo las no vencidas, y un redeploy entre el cierre y la resolución
        // descartaba la posición sin contarla (01/10 16:14, una pérdida de $4.83)
        const cutoff = Date.now() - RESTORE_MAX_AGE_MIN * 60000;
        const closedIds = signalLogger.closedPosIds();
        const active = (data.positions || []).filter(p => p.status !== 'CLOSED'
          && new Date(p.endDate).getTime() > cutoff && !closedIds.has(p.posId || p.id));
        // Totales siempre (antes solo si quedaban posiciones abiertas: el balance
        // de paper y el W/L volvían a cero en cada redeploy)
        this.totalPnL = data.totalPnL || 0;
        this.wins = data.wins || 0;
        this.losses = data.losses || 0;
        this.dailyKey = data.dailyKey || null;
        this.dailyPnL = data.dailyPnL || 0;
        this._appliedAdjustments = data.appliedAdjustments || [];
        if (active.length > 0) {
          // Convertir endDate a Date object
          this.positions = active.map(p => ({ ...p, endDate: new Date(p.endDate) }));
          logger.info(`[TRACKER] ✅ Restauradas ${this.positions.length} posiciones desde disco`);
        }
      }
    } catch (e) {
      logger.warn(`[TRACKER] No se pudo restaurar posiciones: ${e.message}`);
    }
    // Ajustes únicos del balance persistido (se aplican una vez; quedan anotados en disco)
    const done = new Set(this._appliedAdjustments || []);
    for (const adj of ADJUSTMENTS) {
      if (done.has(adj.id)) continue;
      this.totalPnL += adj.pnl; this.wins += adj.wins || 0; this.losses += adj.losses || 0;
      done.add(adj.id);
      logger.warn(`Ajuste aplicado: ${adj.id} | P&L ${adj.pnl >= 0 ? '+' : ''}$${adj.pnl.toFixed(2)} W${adj.wins || 0} L${adj.losses || 0}`);
      this._appliedAdjustments = [...done];
      this._saveToDisk();
    }
    // Correcciones de trades mal resueltos aplicadas en este arranque (ver signal-logger)
    const cd = signalLogger.correctionDelta;
    if (cd && cd.applied.length) {
      this.totalPnL += cd.pnl; this.wins += cd.wins; this.losses += cd.losses;
      logger.warn(`Correcciones aplicadas: ${cd.applied.join('; ')} | ajuste P&L ${cd.pnl >= 0 ? '+' : ''}$${cd.pnl.toFixed(2)}`);
    }
    // signals.jsonl (en el volumen) tiene todos los trades cerrados: si registra más que
    // positions.json (sobrescrito por un proceso que arrancó de cero), manda ese
    // Antes contaba NO_FILL como pérdida (losses = cerrados − ganados) y lo copiaba acá;
    // ahora stats cuenta solo WIN/LOSS, así que si difiere se reconstruye desde ahí.
    try {
      signalLogger.updateStats(); // stats.json puede venir del criterio viejo
      const st = signalLogger.getStats();
      if (st && st.closedTrades > 0 && (st.wins !== this.wins || st.losses !== this.losses)) {
        logger.warn(`[TRACKER] W/L reconstruido desde signals.jsonl (solo WIN/LOSS): antes W:${this.wins} L:${this.losses} P&L ${this.totalPnL.toFixed(2)} → W:${st.wins} L:${st.losses} P&L ${st.totalPnL} | NO_FILL: ${st.noFills ?? 'n/a'}`);
        this.wins = st.wins || 0;
        this.losses = st.losses || 0;
        this.totalPnL = parseFloat(st.totalPnL) || 0;
        this._wlRebuilt = true;
      }
    } catch (_) {}
    if ((cd && cd.applied.length) || this._wlRebuilt) this._saveToDisk();
    if (this.wins + this.losses > 0) {
      logger.info(`✅ Historial restaurado: W:${this.wins} L:${this.losses} | P&L ${this.totalPnL >= 0 ? '+' : ''}$${this.totalPnL.toFixed(2)}`);
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
        dailyKey: this.dailyKey,
        dailyPnL: this.dailyPnL,
        appliedAdjustments: this._appliedAdjustments || [],
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      // No crítico — el bot sigue operando
    }
  }
 
  openPosition({ marketId, gammaId, marketQuestion, side, price, size, endDate, posId, entryType, tokenId, tokenOutcome, direction, onClose }) {
    const pos = {
      id: posId || `POS_${Date.now()}`,
      marketId,
      gammaId,
      marketQuestion,
      side,
      tokenId,
      entryPrice: price,
      size,
      usdcIn: parseFloat((price * size).toFixed(2)),
      endDate: new Date(endDate),
      openedAt: new Date(),
      status: 'OPEN',
      tokenOutcome: tokenOutcome || 'YES',
      direction: direction || '?',
      entryType: entryType || 'early',
      _onClose: onClose || null,  // callback para liberar slot en index-final
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
    // Solo posiciones cuyo mercado ya cerró. Antes se chequeaban todas y un
    // outcomePrices >= 0.95 a mitad de ventana (precio en juego, no resultado)
    // cerraba la posición como WIN/LOSS antes de tiempo.
    const toCheck = this.positions.filter(p => p.status === 'OPEN' && new Date(p.endDate) <= now);

    for (const pos of toCheck) {
      try {
        const result = await this._getMarketResult(pos.marketId, pos.gammaId, pos.endDate);
        if (result === null) {
          if (!pos._pendingLogged) {
            logger.info(`Mercado ${pos.id} cerrado, esperando resolución en Gamma...`);
            pos._pendingLogged = true;
          }
          continue;
        }
        this._closePosition(pos, result);
      } catch (err) {
        logger.error(`Error chequeando posicion ${pos.id}: ${err.message}`);
      }
    }
  }
 
  async _getMarketResult(marketId, gammaId, endDate) {
    try {
      const id = gammaId || marketId;
      const res = await fetch(`${GAMMA_API}/markets/${id}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        logger.warn(`Gamma market fetch failed: ${res.status} for ${id}`);
        return null;
      }
      const market = await res.json();

      // outcomePrices ["1","0"] = YES ganó | ["0","1"] = NO ganó. Solo vale con el
      // mercado cerrado: antes se aceptaba >= 0.95 con el mercado abierto, que es el
      // precio en juego en el segundo del cierre y no el resultado (29/09 07:15: se
      // contó WIN un trade que resolvió LOSS). Mismo criterio que el shadow.
      const closed = market.closed === true || market.resolved === true;
      let prices = null;
      if (market.outcomePrices) {
        try {
          prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices)
            : market.outcomePrices;
        } catch (_) {}
      }
      const pYes = parseFloat(prices?.[0]), pNo = parseFloat(prices?.[1]);
      if (closed) {
        if (pYes >= 0.99) return 'YES';
        if (pNo >= 0.99) return 'NO';
      } else {
        // Sin cierre oficial pasados RESOLVE_GRACE_MIN: mejor dato disponible, avisado
        const lateMin = endDate ? (Date.now() - new Date(endDate).getTime()) / 60000 : 0;
        if (lateMin > RESOLVE_GRACE_MIN && (pYes >= 0.95 || pNo >= 0.95)) {
          logger.warn(`Mercado ${id} sin cerrar a ${lateMin.toFixed(0)} min del fin — resuelvo con precios (${prices[0]}/${prices[1]})`);
          return pYes >= 0.95 ? 'YES' : 'NO';
        }
        return null;
      }

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
        if (yesToken && parseFloat(yesToken.price || yesToken.lastTradePrice) >= 0.95) return 'YES';
        if (noToken  && parseFloat(noToken.price  || noToken.lastTradePrice)  >= 0.95) return 'NO';
      }

      logger.warn(`Mercado ${id} resuelto pero no se pudo determinar ganador. JSON: ${JSON.stringify(market)}`);
      return null;

    } catch (err) {
      logger.error(`Error fetching market result: ${err.message}`);
      return null;
    }
  }
 
  _closePosition(pos, winner) {
    // side siempre es BUY — el bot compra YES (para UP) o NO (para DOWN)
    // Ganás si el token que compraste es el ganador del mercado
    // UP  → compró YES → gana si winner=YES
    // DOWN → compró NO → gana si winner=NO
    // Para determinar qué token compró, usamos pos.tokenOutcome que se guarda al abrir
    const won = pos.tokenOutcome === winner;
 
    // Comisión de entrada (paper); cobrar al resolver no paga comisión
    const entryFee = parseFloat((fee(pos.entryPrice * pos.size) + takerFee(pos.entryPrice, pos.size)).toFixed(4));
    let pnl;
    if (won) {
      pnl = parseFloat(((1 - pos.entryPrice) * pos.size - entryFee).toFixed(2));
      this.wins++;
    } else {
      pnl = parseFloat((-pos.entryPrice * pos.size - entryFee).toFixed(2));
      this.losses++;
    }
 
    this.totalPnL += pnl;
    this._addDaily(pnl);
    pos.status = 'CLOSED';
    pos.winner = winner;
    pos.pnl = pnl;
    pos.closedAt = new Date();
 
    this.closed.push(pos);
    this.positions = this.positions.filter(p => p.id !== pos.id);
 
    const emoji = won ? 'WIN' : 'LOSS';
    logger.info(`[${emoji}] Posicion cerrada: ${pos.id}`);
    logger.info(`   Resultado: ${winner} | PnL: ${pnl > 0 ? '+' : ''}$${pnl} | comisión $${entryFee.toFixed(4)}`);
    // Log claro para análisis: qué predijo el bot vs cómo resolvió el mercado
    logger.info(`[SIGNAL-RESOLUTION] ${pos.id} | Predicted:${pos.direction || '?'} | Resolved:${winner} | Match:${(pos.direction === 'UP' && winner === 'YES') || (pos.direction === 'DOWN' && winner === 'NO') ? 'YES' : 'NO'}`);
    logger.info(`   P&L Total acumulado: ${this.totalPnL > 0 ? '+' : ''}$${this.totalPnL.toFixed(2)} | W:${this.wins} L:${this.losses}`);
    // Registrar resultado en signal logger
    // Intentar con pos.id y pos.posId (ambos formatos usados)
    const signalId = pos.posId || pos.id;
    signalLogger.logSignalClose(signalId, won ? 'WIN' : 'LOSS', pnl, undefined, { fee_usdc: entryFee });
    if (typeof pos._onClose === 'function') pos._onClose();
    this._saveToDisk();
  }

  // Para el position monitor: devuelve las posiciones actualmente abiertas
  getOpenPositions() {
    return this.positions.filter(p => p.status === 'OPEN');
  }

  // Cierre forzado por SL/TP — registra el PnL real de la venta anticipada
  // exitNotional: monto de la venta, para la comisión simulada de salida (paper)
  forceClosePosition(posId, pnl, reason, exitNotional = 0) {
    const pos = this.positions.find(p => p.id === posId);
    if (!pos) return;
    // Venta anticipada: taker al entrar y al salir (precio de salida = exitNotional / size)
    const exitPx = pos.size ? exitNotional / pos.size : 0;
    const feeUsdc = parseFloat((fee(pos.entryPrice * pos.size) + fee(exitNotional)
      + takerFee(pos.entryPrice, pos.size) + (exitNotional ? takerFee(exitPx, pos.size) : 0)).toFixed(4));
    if (feeUsdc) pnl = parseFloat((pnl - feeUsdc).toFixed(2));
    pos.status = 'CLOSED';
    pos.pnl = pnl;
    pos.closedAt = new Date();
    pos.closeReason = reason;
    this.totalPnL += pnl;
    this._addDaily(pnl);
    if (pnl >= 0) this.wins++; else this.losses++;
    this.closed.push(pos);
    this.positions = this.positions.filter(p => p.id !== posId);
    const emoji = pnl >= 0 ? 'WIN' : 'LOSS';
    logger.info(`[${emoji}] [POSITION-MONITOR] Posicion cerrada anticipadamente: ${posId}`);
    logger.info(`   Razón: ${reason} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl}`);
    logger.info(`   P&L Total acumulado: ${this.totalPnL > 0 ? '+' : ''}$${this.totalPnL.toFixed(2)} | W:${this.wins} L:${this.losses}`);
    const signalId = pos.posId || pos.id;
    signalLogger.logSignalClose(signalId, pnl >= 0 ? 'WIN' : 'LOSS', pnl, undefined, { fee_usdc: feeUsdc });
    if (typeof pos._onClose === 'function') pos._onClose();
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
