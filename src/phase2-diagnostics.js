#!/usr/bin/env node
/**
 * PHASE 2 DIAGNOSTICS
 * Verifica estado real de archivos JSONL en Railway
 * Logea información crítica para validación
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BINANCE_RAW_FILE = path.join(DATA_DIR, 'binance-raw.jsonl');
const POLYMARKET_RAW_FILE = path.join(DATA_DIR, 'polymarket-raw.jsonl');
const BOT_EVENTS_FILE = path.join(DATA_DIR, 'bot-events.jsonl');

console.log('[PHASE2-DIAG] ════════════════════════════════════════════');
console.log('[PHASE2-DIAG] PHASE 2 DIAGNOSTICS REPORT');
console.log('[PHASE2-DIAG] ════════════════════════════════════════════');
console.log(`[PHASE2-DIAG] Timestamp: ${new Date().toISOString()}`);
console.log(`[PHASE2-DIAG] DATA_DIR: ${DATA_DIR}`);
console.log('');

// 1. Verificar directorio
console.log('[PHASE2-DIAG] 1️⃣  VERIFICACIÓN DE DIRECTORIO');
try {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`[PHASE2-DIAG] ❌ ${DATA_DIR} NO EXISTE`);
    console.log('[PHASE2-DIAG] Intentando crear...');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[PHASE2-DIAG] ✅ ${DATA_DIR} creado`);
  } else {
    console.log(`[PHASE2-DIAG] ✅ ${DATA_DIR} existe`);
    const stats = fs.statSync(DATA_DIR);
    console.log(`[PHASE2-DIAG]    Modo: ${stats.mode.toString(8)}`);
    console.log(`[PHASE2-DIAG]    Propietario: ${stats.uid}:${stats.gid}`);
  }
} catch (e) {
  console.log(`[PHASE2-DIAG] ❌ Error: ${e.message}`);
}
console.log('');

// 2. Verificar archivos
console.log('[PHASE2-DIAG] 2️⃣  ESTADO DE ARCHIVOS JSONL');

function checkFile(filePath, name) {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const size = stats.size;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).length;
      console.log(`[PHASE2-DIAG] ✅ ${name}`);
      console.log(`[PHASE2-DIAG]    Ruta: ${filePath}`);
      console.log(`[PHASE2-DIAG]    Tamaño: ${(size / 1024).toFixed(2)} KB`);
      console.log(`[PHASE2-DIAG]    Líneas: ${lines}`);
      console.log(`[PHASE2-DIAG]    Modo: ${stats.mode.toString(8)}`);
      return { exists: true, size, lines };
    } else {
      console.log(`[PHASE2-DIAG] ❌ ${name} NO EXISTE`);
      console.log(`[PHASE2-DIAG]    Ruta: ${filePath}`);
      return { exists: false, size: 0, lines: 0 };
    }
  } catch (e) {
    console.log(`[PHASE2-DIAG] ❌ ${name} - Error: ${e.message}`);
    return { exists: false, size: 0, lines: 0, error: e.message };
  }
}

const binanceStatus = checkFile(BINANCE_RAW_FILE, 'binance-raw.jsonl');
console.log('');
const polyStatus = checkFile(POLYMARKET_RAW_FILE, 'polymarket-raw.jsonl');
console.log('');
const botEventsStatus = checkFile(BOT_EVENTS_FILE, 'bot-events.jsonl');
console.log('');

// 3. Test de escritura
console.log('[PHASE2-DIAG] 3️⃣  TEST DE ESCRITURA');
try {
  const testFile = path.join(DATA_DIR, '.write-test');
  fs.writeFileSync(testFile, '{"test": true}\n');
  console.log('[PHASE2-DIAG] ✅ Escritura en ' + DATA_DIR + ': OK');
  fs.unlinkSync(testFile);
} catch (e) {
  console.log(`[PHASE2-DIAG] ❌ Escritura en ${DATA_DIR}: ${e.message}`);
}
console.log('');

// 4. Muestras de datos
console.log('[PHASE2-DIAG] 4️⃣  MUESTRAS DE DATOS (primera línea)');
try {
  if (binanceStatus.exists) {
    const firstLine = fs.readFileSync(BINANCE_RAW_FILE, 'utf-8').split('\n')[0];
    const data = JSON.parse(firstLine);
    console.log('[PHASE2-DIAG] Binance RAW (sample):');
    console.log(`[PHASE2-DIAG]   market_id: ${data.market_id}`);
    console.log(`[PHASE2-DIAG]   btc_price_last: ${data.btc_price_last}`);
    console.log(`[PHASE2-DIAG]   timestamp_quality: ${data.timestamp_quality}`);
    console.log(`[PHASE2-DIAG]   binance_timestamp_ms: ${data.binance_timestamp_ms}`);
  }
} catch (e) {
  console.log(`[PHASE2-DIAG] ❌ Error leyendo Binance: ${e.message}`);
}

try {
  if (polyStatus.exists) {
    const firstLine = fs.readFileSync(POLYMARKET_RAW_FILE, 'utf-8').split('\n')[0];
    const data = JSON.parse(firstLine);
    console.log('[PHASE2-DIAG] Polymarket RAW (sample):');
    console.log(`[PHASE2-DIAG]   market_id: ${data.market_id}`);
    console.log(`[PHASE2-DIAG]   yes_price: ${data.yes_price}`);
    console.log(`[PHASE2-DIAG]   no_price: ${data.no_price}`);
    console.log(`[PHASE2-DIAG]   timestamp_quality: ${data.timestamp_quality}`);
  }
} catch (e) {
  console.log(`[PHASE2-DIAG] ❌ Error leyendo Polymarket: ${e.message}`);
}

try {
  if (botEventsStatus.exists) {
    const firstLine = fs.readFileSync(BOT_EVENTS_FILE, 'utf-8').split('\n')[0];
    const data = JSON.parse(firstLine);
    console.log('[PHASE2-DIAG] Bot Events RAW (sample):');
    console.log(`[PHASE2-DIAG]   event_type: ${data.event_type}`);
    console.log(`[PHASE2-DIAG]   market_id: ${data.market_id}`);
    console.log(`[PHASE2-DIAG]   timestamp_quality: ${data.timestamp_quality}`);
  }
} catch (e) {
  console.log(`[PHASE2-DIAG] ❌ Error leyendo Bot Events: ${e.message}`);
}
console.log('');

// 5. Resumen
console.log('[PHASE2-DIAG] 5️⃣  RESUMEN');
const allExist = binanceStatus.exists && polyStatus.exists && botEventsStatus.exists;
const hasData = binanceStatus.lines > 0 && polyStatus.lines > 0 && botEventsStatus.lines > 0;

if (!allExist) {
  console.log('[PHASE2-DIAG] ⚠️  ESTADO: Archivos no completamente creados');
} else if (!hasData) {
  console.log('[PHASE2-DIAG] ⚠️  ESTADO: Archivos existen pero vacíos');
} else {
  console.log('[PHASE2-DIAG] ✅ ESTADO: Todos los archivos existen y contienen datos');
  console.log(`[PHASE2-DIAG]    Binance records: ${binanceStatus.lines}`);
  console.log(`[PHASE2-DIAG]    Polymarket records: ${polyStatus.lines}`);
  console.log(`[PHASE2-DIAG]    Bot events: ${botEventsStatus.lines}`);
}
console.log('[PHASE2-DIAG] ════════════════════════════════════════════');
