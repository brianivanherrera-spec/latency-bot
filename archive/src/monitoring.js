/**
 * Monitoring Script — Ciclo horario completo
 * Combina análisis de logs + PnL detallado
 */

const { PnLAnalyzer } = require('./pnl-analyzer');
const { Logger } = require('./logger');

const logger = new Logger('MONITOR');

/**
 * Ejecuta ciclo de monitoreo completo (logs + PnL)
 * @param {object} railwayLogs - Logs obtenidos de Railway
 * @param {number} hoursBack - Período a analizar (default: 1)
 */
async function runMonitoringCycle(railwayLogs = null, hoursBack = 1) {
  logger.info('═'.repeat(70));
  logger.info(`🔍 CICLO DE MONITOREO — Últimas ${hoursBack}h`);
  logger.info('═'.repeat(70));

  // 1. Analizar Logs (si se proporcionan)
  if (railwayLogs) {
    analyzeRailwayLogs(railwayLogs);
  }

  // 2. Analizar PnL detallado
  const analysis = PnLAnalyzer.analyzeLast(hoursBack);
  const report = PnLAnalyzer.formatReport(analysis);
  console.log(report);

  // 3. Retornar datos estructurados para API/Slack/WhatsApp
  return {
    timestamp: new Date().toISOString(),
    period: `Last ${hoursBack}h`,
    pnl: analysis.summary,
    trades: analysis.trades,
    formattedReport: report
  };
}

/**
 * Analiza logs de Railway y extrae información clave
 */
function analyzeRailwayLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    logger.warn('No logs disponibles');
    return;
  }

  logger.info('\n📋 RESUMEN DE LOGS:\n');

  // Extraer trades
  const trades = logs.filter(log => log.message?.includes('[PHASE0'));
  const marketResolutions = logs.filter(log => log.message?.includes('[MARKET-RESOLUTION]'));
  const errors = logs.filter(log => log.severity === 'error' || log.severity === 'warn');

  logger.info(`  Eventos de trade: ${trades.length}`);
  logger.info(`  Resoluciones de mercado: ${marketResolutions.length}`);
  logger.info(`  Errores/Warnings: ${errors.length}`);

  if (trades.length > 0) {
    logger.info(`\n  Trades:`);
    trades.forEach(t => {
      logger.info(`    ${t.message}`);
    });
  }

  if (marketResolutions.length > 0) {
    logger.info(`\n  Resoluciones de mercado:`);
    marketResolutions.forEach(m => {
      logger.info(`    ${m.message}`);
    });
  }

  if (errors.length > 0) {
    logger.info(`\n  ⚠️ Errores/Warnings:`);
    errors.forEach(e => {
      logger.info(`    [${e.severity.toUpperCase()}] ${e.message}`);
    });
  }
}

module.exports = { runMonitoringCycle };

// CLI: node monitoring.js [hours]
if (require.main === module) {
  const hours = parseInt(process.argv[2] || '1');
  runMonitoringCycle(null, hours);
}
