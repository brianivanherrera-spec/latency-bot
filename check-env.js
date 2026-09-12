#!/usr/bin/env node
/**
 * Verificar variables de entorno críticas en Railway
 * Para diagnóstico de por qué el bot no está entrando en trades
 */

const criticalVars = [
  'TRADING_HOURS_ENABLED',
  'TRADING_HOURS_BLOCKED_UTC',
  'MAX_POLY_MOVE',
  'POLY_EXTREME_THRESHOLD',
  'MIN_EDGE_PCT',
  'MAX_EDGE_PCT',
  'ZSCORE_THRESHOLD',
  'MIN_SIGNAL_SCORE',
  'MAX_SIGNAL_SCORE',
  'PAPER_CAPITAL',
  'ORDER_SIZE_USDC',
  'COOLDOWN_SECONDS',
  'MIN_SECONDS_REMAINING',
  'MAX_SECONDS_REMAINING',
  'BOOK_FILTER_ENABLED',
  'RSI_FILTER_ENABLED',
  'RSI_FILTER_MIN',
  'RSI_FILTER_MAX',
  'BTC_TREND_FILTER',
  'DRY_RUN',
  'MOVE_PCT_THRESHOLD',
  'MAX_ACTIVE_POSITIONS',
  'ORDER_TYPE',
];

console.log('\n════════════════════════════════════════════════');
console.log('🔧 RAILWAY ENVIRONMENT VARIABLES - LATENCY-BOT');
console.log('════════════════════════════════════════════════\n');

criticalVars.forEach(varName => {
  const value = process.env[varName];
  const status = value !== undefined ? '✅' : '❌';
  console.log(`${status} ${varName.padEnd(30)} = ${value || '(not set)'}`);
});

console.log('\n════════════════════════════════════════════════');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('════════════════════════════════════════════════\n');
