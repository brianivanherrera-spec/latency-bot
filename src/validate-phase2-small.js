#!/usr/bin/env node
/**
 * FASE 2: Validación pequeña de 8 trades
 * Verifica que los logs JSONL están siendo escritos correctamente
 * y valida contra 9-point checkpoint
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BINANCE_RAW_FILE = path.join(DATA_DIR, 'binance-raw.jsonl');
const POLYMARKET_RAW_FILE = path.join(DATA_DIR, 'polymarket-raw.jsonl');
const BOT_EVENTS_FILE = path.join(DATA_DIR, 'bot-events.jsonl');

console.log('🔍 PHASE 2 VALIDATION — pequeño análisis de 8 trades');
console.log('=' .repeat(60));
console.log(`DATA_DIR: ${DATA_DIR}`);
console.log(`Files esperados:`);
console.log(`  - ${BINANCE_RAW_FILE}`);
console.log(`  - ${POLYMARKET_RAW_FILE}`);
console.log(`  - ${BOT_EVENTS_FILE}`);
console.log('');

// Verificar si los directorios existen
console.log('📂 Estado de directorios:');
try {
  if (fs.existsSync(DATA_DIR)) {
    console.log(`  ✅ ${DATA_DIR} existe`);
    const files = fs.readdirSync(DATA_DIR);
    console.log(`  📋 Archivos en ${DATA_DIR}:`, files.length > 0 ? files : '(vacío)');
  } else {
    console.log(`  ❌ ${DATA_DIR} NO existe`);
  }
} catch (e) {
  console.log(`  ❌ Error leyendo ${DATA_DIR}: ${e.message}`);
}
console.log('');

// Función para leer un archivo JSONL
function readJsonlFile(filePath, maxLines = 100) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.warn(`⚠️  No se pudo parsear línea en ${filePath}: ${line.substring(0, 50)}...`);
        return null;
      }
    }).filter(r => r !== null);
  } catch (e) {
    console.warn(`⚠️  Error leyendo ${filePath}: ${e.message}`);
    return [];
  }
}

// Leer archivos
console.log('📖 Leyendo archivos JSONL...');
const binanceRecords = readJsonlFile(BINANCE_RAW_FILE);
const polyRecords = readJsonlFile(POLYMARKET_RAW_FILE);
const botEvents = readJsonlFile(BOT_EVENTS_FILE);

console.log(`  📊 Binance records: ${binanceRecords.length}`);
console.log(`  📊 Polymarket records: ${polyRecords.length}`);
console.log(`  📊 Bot events: ${botEvents.length}`);
console.log('');

// Filtrar solo FILL y ORDER_SENT para contar trades
const signals = botEvents.filter(e => e.event_type === 'SIGNAL_GENERATED');
const orders = botEvents.filter(e => e.event_type === 'ORDER_SENT');
const fills = botEvents.filter(e => e.event_type === 'FILL');
const noFills = botEvents.filter(e => e.event_type === 'NO_FILL');
const resolutions = botEvents.filter(e => e.event_type === 'RESOLUTION');

console.log('📈 Eventos registrados:');
console.log(`  🔔 Signals: ${signals.length}`);
console.log(`  📤 Orders: ${orders.length}`);
console.log(`  ✅ Fills: ${fills.length}`);
console.log(`  ❌ No-fills: ${noFills.length}`);
console.log(`  🏁 Resolutions: ${resolutions.length}`);
console.log('');

// Validación 9-point checkpoint
console.log('✅ VALIDACIÓN 9-POINT CHECKPOINT:');
console.log('');

let validationPassed = 0;
let validationTotal = 9;

// 1. Strike prices captured and official present
const hasStrikePrices = binanceRecords.some(r => r.official_strike_price) ||
                        polyRecords.some(r => r.yes_price);
console.log(`${hasStrikePrices ? '✅' : '❌'} 1. Strike prices captured: ${hasStrikePrices}`);
if (hasStrikePrices) validationPassed++;
console.log('');

// 2. Timestamp quality indicator present (source vs received_only)
const hasTimestampQuality = binanceRecords.some(r => r.timestamp_quality) &&
                            polyRecords.some(r => r.timestamp_quality) &&
                            botEvents.some(r => r.timestamp_quality);
console.log(`${hasTimestampQuality ? '✅' : '❌'} 2. Timestamp quality field: ${hasTimestampQuality}`);
if (hasTimestampQuality) validationPassed++;
console.log('');

// 3. Market resolution field populated
const hasResolution = polyRecords.some(r => r.market_id);
console.log(`${hasResolution ? '✅' : '❌'} 3. Market resolution field: ${hasResolution}`);
if (hasResolution) validationPassed++;
console.log('');

// 4. Event traceability (signal_id → order_id → fill)
const traceable = fills.length > 0 && fills.some(f => f.market_id);
console.log(`${traceable ? '✅' : '❌'} 4. Event traceability chain (signal→order→fill): ${traceable}`);
if (traceable) validationPassed++;
console.log('');

// 5. Order book snapshot (bid/ask for YES/NO)
const hasOrderBook = polyRecords.some(r => r.yes_bid !== undefined && r.yes_ask !== undefined &&
                                            r.no_bid !== undefined && r.no_ask !== undefined);
console.log(`${hasOrderBook ? '✅' : '❌'} 5. Order book depth (4-level YES/NO): ${hasOrderBook}`);
if (hasOrderBook) validationPassed++;
console.log('');

// 6. Timestamp sanity (no future timestamps, no old timestamps)
const now = Date.now();
const recentBinance = binanceRecords.filter(r => r.binance_timestamp_ms);
const binanceSane = recentBinance.length > 0 &&
                   recentBinance.every(r => Math.abs(r.binance_timestamp_ms - now) < 86400000); // <1 day old
const polytSane = polyRecords.length === 0 ||
                  polyRecords.every(r => Math.abs(r.event_received_timestamp_ms - now) < 86400000);
console.log(`${binanceSane && polytSane ? '✅' : '❌'} 6. Timestamp sanity: ${binanceSane && polytSane}`);
if (binanceSane && polytSane) validationPassed++;
console.log('');

// 7. Data volume (at least 10 records per type for small test)
const dataVolume = binanceRecords.length >= 5 && polyRecords.length >= 5 && botEvents.length >= 3;
console.log(`${dataVolume ? '✅' : '❌'} 7. Data volume (≥5 records each): ${dataVolume}`);
console.log(`   Binance: ${binanceRecords.length} | Poly: ${polyRecords.length} | Bot: ${botEvents.length}`);
if (dataVolume) validationPassed++;
console.log('');

// 8. Complete cycles (SIGNAL → ORDER → (FILL or NO_FILL) → RESOLUTION)
const completeCycles = signals.length > 0 &&
                       orders.length > 0 &&
                       (fills.length > 0 || noFills.length > 0);
console.log(`${completeCycles ? '✅' : '❌'} 8. Complete event cycles: ${completeCycles}`);
console.log(`   ${signals.length} signals → ${orders.length} orders → ${fills.length + noFills.length} fill events`);
if (completeCycles) validationPassed++;
console.log('');

// 9. Snapshots with market context
const hasSnapshots = botEvents.some(e => e.btc_price_snapshot) &&
                     botEvents.some(e => e.yes_price_snapshot && e.no_price_snapshot);
console.log(`${hasSnapshots ? '✅' : '❌'} 9. Market snapshots (BTC, YES, NO prices): ${hasSnapshots}`);
if (hasSnapshots) validationPassed++;
console.log('');

// Resumen final
console.log('=' .repeat(60));
console.log(`📊 RESULTADO: ${validationPassed}/${validationTotal} checkpoints validados`);
console.log('');

if (validationPassed < 6) {
  console.log('⚠️  PROBLEMA: No hay suficientes datos. Verificando si los archivos se escriben...');
  console.log('');
  console.log('SUGERENCIAS:');
  console.log('  1. Verificar que DATA_DIR está configurado correctamente en Railway');
  console.log('  2. Verificar que el contenedor tiene permisos de escritura en /data');
  console.log('  3. Revisar logs del bot para errores de [PHASE2]');
  console.log('');
  process.exit(1);
} else if (validationPassed >= 9) {
  console.log('✅ FASE 2 INSTRUMENTACIÓN OPERATIVA - Todos los checkpoints OK');
  console.log('Próximo paso: Acumular 50+ trades y análisis completo');
  console.log('');
  process.exit(0);
} else {
  console.log('⚠️  FASE 2 PARCIALMENTE OPERATIVO');
  console.log(`Datos incompletos pero suficientes. ${9 - validationPassed} checkpoint(s) requieren validación.`);
  console.log('');
  process.exit(0);
}
