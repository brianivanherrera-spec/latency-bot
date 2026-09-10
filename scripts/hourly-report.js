#!/usr/bin/env node

/**
 * Hourly Report — Genera reporte completo de PnL y logs
 * Se ejecuta automáticamente cada hora via cron
 *
 * Uso:
 *   node hourly-report.js [projectId] [serviceId] [environmentId]
 */

const path = require('path');
const { PnLAnalyzer } = require('../src/pnl-analyzer');

const PROJECT_ID = process.argv[2] || 'd45ca687-cb1d-4719-a06f-ffdb723c4d97';
const SERVICE_ID = process.argv[3] || 'e969a5db-9775-481d-bebd-be480a10496a';
const ENV_ID = process.argv[4] || '90d21516-5f58-4df2-807d-72c36ee82ad4';

/**
 * Genera reporte horario completo
 */
async function generateHourlyReport() {
  console.log('\n' + '═'.repeat(80));
  console.log('📊 REPORTE HORARIO — latency-bot');
  console.log('═'.repeat(80));

  const timestamp = new Date().toISOString();
  console.log(`⏰ Generado: ${timestamp}\n`);

  // 1. Análisis de PnL
  console.log('📈 ANÁLISIS DE PnL (última hora):\n');
  const analysis = PnLAnalyzer.analyzeLast(1);

  if (analysis.trades.length === 0) {
    console.log('  ℹ️  No hay trades en la última hora\n');
  } else {
    // Resumen
    const { summary } = analysis;
    console.log(`  Trades totales:  ${summary.totalTrades}`);
    console.log(`  ✅ Winners:       ${summary.winners}`);
    console.log(`  ❌ Losers:        ${summary.losers}`);
    console.log(`  ⏸️  No Fills:      ${summary.noFills}`);
    console.log(`  Win Rate:        ${summary.winRate}`);
    console.log(`  Total PnL:       $${summary.totalPnL}`);
    console.log(`  Avg PnL:         $${summary.avgPnL}\n`);

    // Detalle de trades
    console.log('  📋 Trades:\n');
    analysis.trades.forEach((trade, idx) => {
      const icon = trade.result === 'WIN' ? '✅' : trade.result === 'LOSS' ? '❌' : '⏸️';
      const pnlStr = trade.pnl !== null ? `$${trade.pnl.toFixed(4)}` : '-';
      const timeStr = new Date(trade.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      console.log(`    ${idx + 1}. ${icon} ${timeStr} | ${trade.direction.padEnd(4)} | ` +
                  `Entry: $${trade.entry.price.toFixed(4)} | ` +
                  `Edge: ${(trade.entry.edge * 100).toFixed(2)}% | ` +
                  `PnL: ${pnlStr}`);
    });
  }

  // 2. Información de Railway
  console.log('\n📡 INFORMACIÓN DE RAILWAY:\n');
  console.log(`  Project ID:     ${PROJECT_ID}`);
  console.log(`  Service ID:     ${SERVICE_ID}`);
  console.log(`  Environment ID: ${ENV_ID}`);
  console.log(`  Logs disponibles vía: mcp__Railway__get-logs`);

  // 3. Resumen final
  console.log('\n' + '═'.repeat(80));
  const summary = analysis.summary;
  const statusEmoji = summary.totalTrades === 0 ? 'ℹ️' :
                      summary.winners > summary.losers ? '✅' : '⚠️';
  console.log(`${statusEmoji} ESTADO: ${getStatusMessage(summary)}`);
  console.log('═'.repeat(80) + '\n');

  return {
    timestamp,
    analysis: analysis.summary,
    trades: analysis.trades.length,
    detailed_trades: analysis.trades
  };
}

/**
 * Genera mensaje de estado
 */
function getStatusMessage(summary) {
  if (summary.totalTrades === 0) {
    return 'Sin trades en la última hora';
  }

  const winRate = summary.totalTrades > 0 ? (summary.winners / summary.totalTrades) * 100 : 0;

  if (winRate >= 70) {
    return `🔥 Excelente — ${summary.winners}/${summary.totalTrades} (${winRate.toFixed(0)}%)`;
  } else if (winRate >= 50) {
    return `✅ Bueno — ${summary.winners}/${summary.totalTrades} (${winRate.toFixed(0)}%)`;
  } else if (winRate > 0) {
    return `⚠️  Bajo — ${summary.winners}/${summary.totalTrades} (${winRate.toFixed(0)}%)`;
  } else {
    return `❌ Negativo — 0/${summary.totalTrades}`;
  }
}

// Ejecutar
if (require.main === module) {
  generateHourlyReport().catch(err => {
    console.error('[ERROR]', err.message);
    process.exit(1);
  });
}

module.exports = { generateHourlyReport };
