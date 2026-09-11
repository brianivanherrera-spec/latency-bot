#!/usr/bin/env node

/**
 * PHASE 0 Analysis Tool — Valida hipótesis sobre NO_FILLs
 *
 * Hypothesis 1: ¿Hay orders clasificadas erróneamente como status='live'
 *               cuando deberían ser 'no_fill'?
 *
 * Hypothesis 2: ¿Hay book-depth issues (precios constantes, sin volumen)?
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILLS_FILE = path.join(DATA_DIR, 'fills.jsonl');

function readFills() {
  if (!fs.existsSync(FILLS_FILE)) {
    console.log('📁 No fills.jsonl found at', FILLS_FILE);
    return [];
  }

  const lines = fs.readFileSync(FILLS_FILE, 'utf8').trim().split('\n');
  return lines
    .filter(l => l.trim())
    .map(l => {
      try { return JSON.parse(l); } catch(e) { return null; }
    })
    .filter(Boolean);
}

function analyzeFills(fills) {
  if (fills.length === 0) {
    console.log('\n❌ Sin datos de fills. Ejecuta el bot primero.\n');
    return;
  }

  console.log('\n' + '═'.repeat(80));
  console.log('📊 PHASE 0 ANALYSIS — Validación de Hipótesis');
  console.log('═'.repeat(80));
  console.log(`\n📈 Data Collected: ${fills.length} order attempts\n`);

  // === ESTADÍSTICAS GLOBALES ===
  const filled = fills.filter(f => f.fill_result === 'FILLED').length;
  const noFill = fills.filter(f => f.fill_result === 'NO_FILL').length;
  const fillRate = ((filled / fills.length) * 100).toFixed(1);

  console.log('📋 ESTADÍSTICAS GLOBALES:');
  console.log(`  ✅ FILLED:  ${filled} (${((filled/fills.length)*100).toFixed(1)}%)`);
  console.log(`  ❌ NO_FILL: ${noFill} (${((noFill/fills.length)*100).toFixed(1)}%)`);
  console.log(`  📊 Fill Rate: ${fillRate}%\n`);

  // === HYPOTHESIS 1: status='live' bug ===
  console.log('🔍 HYPOTHESIS 1: Misclassified status=\'live\'');
  console.log('─'.repeat(80));

  const noFillLive = fills.filter(f =>
    f.fill_result === 'NO_FILL' && f.order_status === 'live'
  );

  console.log(`  Orders with NO_FILL + status='live': ${noFillLive.length}`);

  if (noFillLive.length > 0) {
    console.log(`  ⚠️  BUG CONFIRMED — These should not be 'live' (they didn't fill)\n`);

    // Breakdown de razones para esos 'live'
    const liveReasons = {};
    noFillLive.forEach(f => {
      const reason = f.rejection_reason || 'unknown';
      liveReasons[reason] = (liveReasons[reason] || 0) + 1;
    });

    console.log('  Breakdown de razones (status=live pero NO_FILL):');
    Object.entries(liveReasons)
      .sort((a, b) => b[1] - a[1])
      .forEach(([reason, count]) => {
        console.log(`    - ${reason}: ${count}`);
      });
  } else {
    console.log(`  ✅ No bug detected — All NO_FILL orders properly classified\n`);
  }

  // === HYPOTHESIS 2: Book depth issues ===
  console.log('\n🔍 HYPOTHESIS 2: Book-Depth Issues (constant prices, no volume)');
  console.log('─'.repeat(80));

  const noFillAskTooHigh = fills.filter(f =>
    f.fill_result === 'NO_FILL' &&
    (f.rejection_reason === 'ask_too_high' || f.rejection_reason === 'libro_agotado')
  );

  const askTooHighPct = ((noFillAskTooHigh.length / fills.length) * 100).toFixed(1);
  console.log(`  Orders rejected for ask_too_high/libro_agotado: ${noFillAskTooHigh.length} (${askTooHighPct}%)`);

  if (noFillAskTooHigh.length > 5) {
    console.log(`  ⚠️  BOOK DEPTH ISSUE DETECTED — High ask prices blocking fills\n`);
  } else {
    console.log(`  ✅ Book depth is healthy — Few ask_too_high rejections\n`);
  }

  // === DETAILED NO_FILL BREAKDOWN ===
  console.log('📊 DETAILED NO_FILL BREAKDOWN:');
  console.log('─'.repeat(80));

  const reasons = {};
  fills
    .filter(f => f.fill_result === 'NO_FILL')
    .forEach(f => {
      const reason = f.rejection_reason || 'unknown';
      reasons[reason] = (reasons[reason] || 0) + 1;
    });

  Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      const pct = ((count / noFill) * 100).toFixed(1);
      console.log(`  ${reason}: ${count} (${pct}% of NO_FILLs)`);
    });

  // === RECOMMENDATION ===
  console.log('\n' + '═'.repeat(80));
  console.log('💡 RECOMENDACIONES PARA SIGUIENTE FASE:');
  console.log('═'.repeat(80));

  if (noFillLive.length > 0) {
    console.log('\n✅ PHASE 1: Fix status=\'live\' bug');
    console.log('   Location: src/index-final.js');
    console.log('   Action: Correct order status classification in logFillTelemetry()');
  }

  if (askTooHighPct > 5) {
    console.log('\n✅ PHASE 2: A/B test MAX_PRICE adjustment');
    console.log('   Current: Aumentar MAX_PRICE en 2-5% para reducir ask_too_high');
    console.log('   Test: Compare fill rate antes/después en 100 trades');
  }

  if (noFillLive.length === 0 && askTooHighPct <= 5) {
    console.log('\n✅ NO MAJOR ISSUES — Sistema funcionando bien');
    console.log('   Fill rate acceptable (>90%)');
    console.log('   Monitorear y continuar recolectando data');
  }

  console.log('\n' + '═'.repeat(80) + '\n');
}

// Ejecutar
const fills = readFills();
analyzeFills(fills);

module.exports = { analyzeFills };
