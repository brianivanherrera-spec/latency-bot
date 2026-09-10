/**
 * PnL Analyzer — Análisis detallado de ganancias/pérdidas por trade
 * Lee fills.jsonl y signals.jsonl para calcular PnL exacto de cada posición
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILLS_FILE = path.join(DATA_DIR, 'fills.jsonl');
const SIGNAL_FILE = path.join(DATA_DIR, 'signals.jsonl');

class PnLAnalyzer {
  /**
   * Analiza trades de la última N horas
   * @param {number} hoursBack - Cuántas horas atrás analizar (default: 1)
   * @returns {object} Reporte de PnL detallado
   */
  static analyzeLast(hoursBack = 1) {
    const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);

    const signals = this._readSignals().filter(s => s.timestamp > cutoffTime);
    const fills = this._readFills().filter(f => f.timestamp > cutoffTime);

    if (signals.length === 0 && fills.length === 0) {
      return {
        period: `Última ${hoursBack}h`,
        trades: [],
        summary: {
          totalTrades: 0,
          winners: 0,
          losers: 0,
          noFills: 0,
          totalPnL: 0,
          winRate: '0%',
          avgPnL: 0
        }
      };
    }

    // Agrupar por posId
    const tradeMap = new Map();

    signals.forEach(sig => {
      if (!tradeMap.has(sig.posId)) {
        tradeMap.set(sig.posId, { opens: [], closes: [] });
      }
      tradeMap.get(sig.posId).opens.push(sig);
    });

    fills.forEach(fill => {
      if (!tradeMap.has(fill.posId)) {
        tradeMap.set(fill.posId, { opens: [], closes: [] });
      }
      tradeMap.get(fill.posId).closes.push(fill);
    });

    // Calcular PnL por trade
    const trades = [];
    let totalPnL = 0;
    let winners = 0;
    let losers = 0;
    let noFills = 0;

    tradeMap.forEach((data, posId) => {
      const openSig = data.opens[data.opens.length - 1]; // Última señal de entrada
      const closeFill = data.closes[data.closes.length - 1]; // Último fill

      if (!openSig) return; // Sin señal de entrada

      const trade = {
        posId,
        timestamp: new Date(openSig.timestamp).toISOString(),
        direction: openSig.direction,

        // Entrada
        entry: {
          price: openSig.filled_price,
          polyPrice: parseFloat(openSig.poly_price_entry) || null,
          btcPrice: this._parseNumber(openSig.btc_price_entry),
          strikePrice: this._parseNumber(openSig.strike_price),
          zscore: parseFloat(openSig.zscore) || 0,
          edge: parseFloat(openSig.edge) || 0,
          imbalance: parseFloat(openSig.imbalance) || 0,
        },

        // Relleno (si existe)
        fill: closeFill ? {
          filled: closeFill.fill_result === 'FILLED',
          price: closeFill.order_price ? parseFloat(closeFill.order_price) : null,
          size: closeFill.size_filled || 0,
          time_ms: closeFill.time_to_fill_ms || 0,
          status: closeFill.order_status,
          reason: closeFill.rejection_reason
        } : null,

        // PnL (si está resuelto)
        pnl: null,
        result: 'OPEN' // OPEN, WIN, LOSS, NO_FILL
      };

      // Calcular PnL si hay información de cierre
      if (closeFill && closeFill.fill_result === 'FILLED') {
        const entryPrice = parseFloat(openSig.filled_price);
        const exitPrice = parseFloat(closeFill.order_price);
        const size = closeFill.size_filled || 1;

        // PnL simple: (exit - entry) * size
        trade.pnl = (exitPrice - entryPrice) * size;

        if (trade.pnl > 0) {
          trade.result = 'WIN';
          winners++;
        } else if (trade.pnl < 0) {
          trade.result = 'LOSS';
          losers++;
        }
        totalPnL += trade.pnl;
      } else if (closeFill && closeFill.fill_result !== 'FILLED') {
        trade.result = 'NO_FILL';
        noFills++;
      }

      trades.push(trade);
    });

    const totalTrades = winners + losers;

    return {
      period: `Última ${hoursBack}h`,
      trades: trades.sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
      summary: {
        totalTrades,
        winners,
        losers,
        noFills,
        totalPnL: parseFloat(totalPnL.toFixed(4)),
        winRate: totalTrades > 0 ? `${((winners / totalTrades) * 100).toFixed(1)}%` : 'N/A',
        avgPnL: totalTrades > 0 ? parseFloat((totalPnL / totalTrades).toFixed(4)) : 0
      }
    };
  }

  /**
   * Formatea reporte de PnL para consola/Slack/etc
   */
  static formatReport(analysis) {
    const { summary, trades } = analysis;

    let report = `\n${'═'.repeat(70)}\n`;
    report += `📊 ANÁLISIS DE PnL — ${analysis.period}\n`;
    report += `${'═'.repeat(70)}\n\n`;

    // Resumen
    report += `📈 RESUMEN:\n`;
    report += `  Trades totales: ${summary.totalTrades}\n`;
    report += `  ✅ Winners: ${summary.winners}\n`;
    report += `  ❌ Losers: ${summary.losers}\n`;
    report += `  ⏸️  No Fills: ${summary.noFills}\n`;
    report += `  Win Rate: ${summary.winRate}\n`;
    report += `  Total PnL: $${summary.totalPnL}\n`;
    report += `  Avg PnL: $${summary.avgPnL}\n\n`;

    // Detalle por trade
    if (trades.length > 0) {
      report += `📋 DETALLES POR TRADE:\n`;
      report += `${'─'.repeat(70)}\n`;

      trades.forEach((trade, idx) => {
        const icon = trade.result === 'WIN' ? '✅' : trade.result === 'LOSS' ? '❌' : '⏸️';
        const pnlStr = trade.pnl !== null ? `PnL: $${trade.pnl.toFixed(4)}` : 'Abierto';

        report += `\n${idx + 1}. ${icon} ${trade.posId} | ${trade.direction} | ${trade.result}\n`;
        report += `   Time: ${trade.timestamp}\n`;
        report += `   Entry: $${trade.entry.price.toFixed(4)} (Poly: $${trade.entry.polyPrice?.toFixed(4) || 'N/A'})\n`;
        report += `   Z-Score: ${trade.entry.zscore.toFixed(2)} | Edge: ${(trade.entry.edge * 100).toFixed(2)}%\n`;

        if (trade.fill) {
          report += `   Fill: ${trade.fill.filled ? '✓' : '✗'} @ $${trade.fill.price?.toFixed(4) || 'N/A'} (${trade.fill.time_ms}ms)\n`;
          if (!trade.fill.filled && trade.fill.reason) {
            report += `   Razón: ${trade.fill.reason}\n`;
          }
        }

        if (trade.pnl !== null) {
          report += `   ${pnlStr}\n`;
        }
      });
    }

    report += `\n${'═'.repeat(70)}\n`;
    return report;
  }

  // Helpers privados
  static _readSignals() {
    if (!fs.existsSync(SIGNAL_FILE)) return [];
    try {
      const lines = fs.readFileSync(SIGNAL_FILE, 'utf8').trim().split('\n');
      return lines
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l); } catch(e) { return null; }
        })
        .filter(Boolean);
    } catch(e) { return []; }
  }

  static _readFills() {
    if (!fs.existsSync(FILLS_FILE)) return [];
    try {
      const lines = fs.readFileSync(FILLS_FILE, 'utf8').trim().split('\n');
      return lines
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l); } catch(e) { return null; }
        })
        .filter(Boolean);
    } catch(e) { return []; }
  }

  static _parseNumber(str) {
    if (!str) return null;
    if (typeof str === 'number') return str;
    return parseFloat(str.toString().replace(/,/g, '')) || null;
  }
}

module.exports = { PnLAnalyzer };

// CLI: node pnl-analyzer.js [hours]
if (require.main === module) {
  const hours = parseInt(process.argv[2] || '1');
  const analysis = PnLAnalyzer.analyzeLast(hours);
  console.log(PnLAnalyzer.formatReport(analysis));
}
