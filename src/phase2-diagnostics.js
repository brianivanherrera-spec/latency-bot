#!/usr/bin/env node
/**
 * PHASE 2 DIAGNOSTICS
 * Verifica estado real de archivos JSONL en Railway
 * Logea información crítica para validación
 * IMPORTANTE: Usa streaming para archivos grandes (>100MB) sin sobrecargar memoria
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BINANCE_RAW_FILE = path.join(DATA_DIR, 'binance-raw.jsonl');
const POLYMARKET_RAW_FILE = path.join(DATA_DIR, 'polymarket-raw.jsonl');
const BOT_EVENTS_FILE = path.join(DATA_DIR, 'bot-events.jsonl');

// REDUCED LOGGING: Only report errors, skip success messages
const VERBOSE = process.env.PHASE2_VERBOSE === 'true';

if (VERBOSE) {
  console.log('[PHASE2-DIAG] ════════════════════════════════════════════');
  console.log('[PHASE2-DIAG] PHASE 2 DIAGNOSTICS REPORT');
  console.log('[PHASE2-DIAG] ════════════════════════════════════════════');
}

// 1. Verificar directorio
try {
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`[PHASE2-DIAG] ❌ ${DATA_DIR} NO EXISTE - Creando...`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (VERBOSE) {
    const stats = fs.statSync(DATA_DIR);
    console.log(`[PHASE2-DIAG] ✅ ${DATA_DIR} lista (${stats.uid}:${stats.gid})`);
  }
} catch (e) {
  console.log(`[PHASE2-DIAG] ❌ Error en DATA_DIR: ${e.message}`);
}

async function checkFileAsync(filePath, name) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(filePath)) {
        console.log(`[PHASE2-DIAG] ❌ ${name} NO EXISTE`);
        console.log(`[PHASE2-DIAG]    Ruta: ${filePath}`);
        resolve({ exists: false, size: 0, lines: 0 });
        return;
      }

      const stats = fs.statSync(filePath);
      const size = stats.size;
      let lines = 0;

      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity
      });

      rl.on('line', () => {
        lines++;
      });

      rl.on('close', () => {
        console.log(`[PHASE2-DIAG] ✅ ${name}`);
        console.log(`[PHASE2-DIAG]    Ruta: ${filePath}`);
        console.log(`[PHASE2-DIAG]    Tamaño: ${(size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`[PHASE2-DIAG]    Líneas: ${lines}`);
        console.log(`[PHASE2-DIAG]    Modo: ${stats.mode.toString(8)}`);
        resolve({ exists: true, size, lines });
      });

      rl.on('error', (e) => {
        console.log(`[PHASE2-DIAG] ❌ ${name} - Error: ${e.message}`);
        resolve({ exists: false, size: 0, lines: 0, error: e.message });
      });
    } catch (e) {
      console.log(`[PHASE2-DIAG] ❌ ${name} - Error: ${e.message}`);
      resolve({ exists: false, size: 0, lines: 0, error: e.message });
    }
  });
}

// Leer primeras líneas con streaming
async function readFirstLineAsync(filePath) {
  return new Promise((resolve) => {
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity
      });

      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });

      rl.on('error', () => resolve(null));
    } catch (e) {
      resolve(null);
    }
  });
}

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

// Main async function
(async () => {
  const binanceStatus = await checkFileAsync(BINANCE_RAW_FILE, 'binance-raw.jsonl');
  console.log('');
  const polyStatus = await checkFileAsync(POLYMARKET_RAW_FILE, 'polymarket-raw.jsonl');
  console.log('');
  const botEventsStatus = await checkFileAsync(BOT_EVENTS_FILE, 'bot-events.jsonl');
  console.log('');

  // 4. Muestras de datos
  console.log('[PHASE2-DIAG] 4️⃣  MUESTRAS DE DATOS (primera línea)');
  try {
    if (binanceStatus.exists) {
      const firstLine = await readFirstLineAsync(BINANCE_RAW_FILE);
      if (firstLine) {
        const data = JSON.parse(firstLine);
        console.log('[PHASE2-DIAG] Binance RAW (sample):');
        console.log(`[PHASE2-DIAG]   market_id: ${data.market_id}`);
        console.log(`[PHASE2-DIAG]   btc_price_last: ${data.btc_price_last}`);
        console.log(`[PHASE2-DIAG]   timestamp_quality: ${data.timestamp_quality}`);
        console.log(`[PHASE2-DIAG]   binance_timestamp_ms: ${data.binance_timestamp_ms}`);
      }
    }
  } catch (e) {
    console.log(`[PHASE2-DIAG] ❌ Error leyendo Binance: ${e.message}`);
  }

  try {
    if (polyStatus.exists) {
      const firstLine = await readFirstLineAsync(POLYMARKET_RAW_FILE);
      if (firstLine) {
        const data = JSON.parse(firstLine);
        console.log('[PHASE2-DIAG] Polymarket RAW (sample):');
        console.log(`[PHASE2-DIAG]   market_id: ${data.market_id}`);
        console.log(`[PHASE2-DIAG]   yes_price: ${data.yes_price}`);
        console.log(`[PHASE2-DIAG]   no_price: ${data.no_price}`);
        console.log(`[PHASE2-DIAG]   timestamp_quality: ${data.timestamp_quality}`);
      }
    }
  } catch (e) {
    console.log(`[PHASE2-DIAG] ❌ Error leyendo Polymarket: ${e.message}`);
  }

  try {
    if (botEventsStatus.exists) {
      const firstLine = await readFirstLineAsync(BOT_EVENTS_FILE);
      if (firstLine) {
        const data = JSON.parse(firstLine);
        console.log('[PHASE2-DIAG] Bot Events RAW (sample):');
        console.log(`[PHASE2-DIAG]   event_type: ${data.event_type}`);
        console.log(`[PHASE2-DIAG]   market_id: ${data.market_id}`);
        console.log(`[PHASE2-DIAG]   timestamp_quality: ${data.timestamp_quality}`);
      }
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
})();
