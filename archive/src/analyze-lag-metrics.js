/**
 * LAG METRICS ANALYSIS SCRIPT
 *
 * Propósito: Analizar métricas de Polymarket lag detection y NO_FILL diagnostics
 * recolectadas durante live trading para calibrar filtros en Phase 3.
 *
 * Uso: node src/analyze-lag-metrics.js [data_dir]
 * Ej:  node src/analyze-lag-metrics.js /data
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = process.argv[2] || process.env.DATA_DIR || '/data';
const BOT_EVENTS_FILE = path.join(DATA_DIR, 'bot-events.jsonl');

async function readJsonl(filePath) {
  const records = [];
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  File not found: ${filePath}`);
    return records;
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        records.push(JSON.parse(line));
      } catch (e) {
        // Skip malformed lines
      }
    }
  }
  return records;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(index, sorted.length - 1)];
}

function stats(arr, decimals = 2) {
  if (arr.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    count: arr.length,
    min: sorted[0].toFixed(decimals),
    max: sorted[sorted.length - 1].toFixed(decimals),
    avg: (sum / arr.length).toFixed(decimals),
    p50: percentile(sorted, 50).toFixed(decimals),
    p95: percentile(sorted, 95).toFixed(decimals),
  };
}

async function analyzeMetrics() {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  LAG DETECTION & NO_FILL DIAGNOSTIC ANALYSIS                   ║');
  console.log('║  Phase 2: Data Collection Validation                            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const botEvents = await readJsonl(BOT_EVENTS_FILE);
  console.log(`📊 Total events loaded: ${botEvents.length}\n`);

  // ========== SECTION 1: POLYMARKET LAG METRICS ==========
  console.log('┌' + '─'.repeat(62) + '┐');
  console.log('│ 1️⃣  POLYMARKET LAG DETECTION METRICS                            │');
  console.log('└' + '─'.repeat(62) + '┘\n');

  const signals = botEvents.filter(e => e.event_type === 'SIGNAL_GENERATED');
  console.log(`Total SIGNAL_GENERATED events: ${signals.length}`);

  const withLagMetrics = signals.filter(s =>
    s.poly_lag_ms !== undefined ||
    s.poly_absorption_rate !== undefined ||
    s.btc_poly_price_gap_pct !== undefined
  );

  if (withLagMetrics.length === 0) {
    console.log('❌ No lag metrics found. Metrics may not be captured yet.\n');
  } else {
    console.log(`✓ Signals with lag metrics: ${withLagMetrics.length}/${signals.length} (${((withLagMetrics.length/signals.length)*100).toFixed(1)}%)\n`);

    // poly_lag_ms analysis
    const lagMs = withLagMetrics
      .map(s => s.poly_lag_ms)
      .filter(l => l !== undefined && l !== null);

    console.log('📌 poly_lag_ms (milliseconds since last Polymarket update)');
    console.log('   Interpretation:');
    console.log('   - <100ms → lag closed (Polymarket recently updated)');
    console.log('   - 100-300ms → lag partial (update in progress)');
    console.log('   - >400ms → lag open (time window for arbitrage)');

    if (lagMs.length > 0) {
      const lagStats = stats(lagMs, 0);
      console.log(`   Distribution:`);
      console.log(`     Min: ${lagStats.min}ms | Max: ${lagStats.max}ms | Avg: ${lagStats.avg}ms`);
      console.log(`     p50: ${lagStats.p50}ms | p95: ${lagStats.p95}ms`);

      const lagClosed = lagMs.filter(l => l < 100).length;
      const lagPartial = lagMs.filter(l => l >= 100 && l < 300).length;
      const lagOpen = lagMs.filter(l => l >= 300).length;

      console.log(`   Distribution by range:`);
      console.log(`     <100ms (closed): ${lagClosed} (${((lagClosed/lagMs.length)*100).toFixed(1)}%)`);
      console.log(`     100-300ms (partial): ${lagPartial} (${((lagPartial/lagMs.length)*100).toFixed(1)}%)`);
      console.log(`     ≥300ms (open): ${lagOpen} (${((lagOpen/lagMs.length)*100).toFixed(1)}%)`);
    } else {
      console.log('   ⚠️  No data collected\n');
    }
    console.log();

    // poly_absorption_rate analysis
    const rates = withLagMetrics
      .map(s => s.poly_absorption_rate)
      .filter(r => r !== undefined && r !== null);

    console.log('📌 poly_absorption_rate (¢/second price convergence speed)');
    console.log('   Interpretation:');
    console.log('   - <0.01 → slow convergence (good entry opportunity)');
    console.log('   - 0.01-0.05 → moderate convergence (edge medium)');
    console.log('   - >0.05 → fast convergence (edge closing, risky entry)');

    if (rates.length > 0) {
      const rateStats = stats(rates, 6);
      console.log(`   Distribution:`);
      console.log(`     Min: ${rateStats.min}¢/s | Max: ${rateStats.max}¢/s | Avg: ${rateStats.avg}¢/s`);
      console.log(`     p50: ${rateStats.p50}¢/s | p95: ${rateStats.p95}¢/s`);

      const slowConv = rates.filter(r => r < 0.01).length;
      const modConv = rates.filter(r => r >= 0.01 && r < 0.05).length;
      const fastConv = rates.filter(r => r >= 0.05).length;

      console.log(`   Distribution by speed:`);
      console.log(`     <0.01¢/s (slow): ${slowConv} (${((slowConv/rates.length)*100).toFixed(1)}%)`);
      console.log(`     0.01-0.05¢/s (moderate): ${modConv} (${((modConv/rates.length)*100).toFixed(1)}%)`);
      console.log(`     ≥0.05¢/s (fast): ${fastConv} (${((fastConv/rates.length)*100).toFixed(1)}%)`);
    } else {
      console.log('   ⚠️  No data collected\n');
    }
    console.log();

    // btc_poly_price_gap_pct analysis
    const gaps = withLagMetrics
      .map(s => s.btc_poly_price_gap_pct)
      .filter(g => g !== undefined && g !== null);

    console.log('📌 btc_poly_price_gap_pct (lag indicator, shows if Polymarket is behind)');
    console.log('   Interpretation:');
    console.log('   - >0.02 (>2%) → Polymarket LAGGING (lag exists, edge profitable)');
    console.log('   - ≈0 (±0.02) → SYNCHRONIZED (no lag)');
    console.log('   - <-0.02 (<-2%) → Polymarket AHEAD (overshot BTC move)');

    if (gaps.length > 0) {
      const gapStats = stats(gaps, 6);
      console.log(`   Distribution:`);
      console.log(`     Min: ${gapStats.min} | Max: ${gapStats.max} | Avg: ${gapStats.avg}`);
      console.log(`     p50: ${gapStats.p50} | p95: ${gapStats.p95}`);

      const lagExists = gaps.filter(g => g > 0.02).length;
      const synced = gaps.filter(g => g >= -0.02 && g <= 0.02).length;
      const ahead = gaps.filter(g => g < -0.02).length;

      console.log(`   Distribution by lag status:`);
      console.log(`     >0.02 (lagging): ${lagExists} (${((lagExists/gaps.length)*100).toFixed(1)}%)`);
      console.log(`     ±0.02 (synced): ${synced} (${((synced/gaps.length)*100).toFixed(1)}%)`);
      console.log(`     <-0.02 (ahead): ${ahead} (${((ahead/gaps.length)*100).toFixed(1)}%)`);

      if (lagExists > 0) {
        console.log(`   ✅ Lag confirmed in ${lagExists} signals (arbitrage edge exists)`);
      } else {
        console.log(`   ⚠️  No positive lag detected (Polymarket may be synchronized)`);
      }
    } else {
      console.log('   ⚠️  No data collected\n');
    }
    console.log();
  }

  // ========== SECTION 2: NO_FILL DIAGNOSTICS ==========
  console.log('┌' + '─'.repeat(62) + '┐');
  console.log('│ 2️⃣  NO_FILL DIAGNOSTIC SYSTEM ANALYSIS                         │');
  console.log('└' + '─'.repeat(62) + '┘\n');

  const noFills = botEvents.filter(e => e.event_type === 'NO_FILL');
  const fills = botEvents.filter(e => e.event_type === 'FILL');
  const orders = botEvents.filter(e => e.event_type === 'ORDER_SENT');

  console.log(`Order summary:`);
  console.log(`  Total orders sent: ${orders.length}`);
  console.log(`  Fills: ${fills.length} (${orders.length > 0 ? ((fills.length/orders.length)*100).toFixed(1) : 0}%)`);
  console.log(`  No-fills: ${noFills.length} (${orders.length > 0 ? ((noFills.length/orders.length)*100).toFixed(1) : 0}%)\n`);

  if (noFills.length === 0) {
    console.log('✅ No NO_FILL events recorded. All orders filled!\n');
  } else {
    // Rejection reason breakdown
    const reasonCounts = {};
    const withReason = noFills.filter(nf => nf.rejection_reason);

    noFills.forEach(nf => {
      const reason = nf.rejection_reason || 'unknown';
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    });

    console.log(`Rejection reason breakdown (${withReason.length}/${noFills.length} categorized):`);
    const sorted = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    sorted.forEach(([reason, count], idx) => {
      const pct = ((count / noFills.length) * 100).toFixed(1);
      const bar = '█'.repeat(Math.floor(pct / 2));
      console.log(`  ${(idx + 1).toString().padEnd(2)}. ${reason.padEnd(30)} ${count.toString().padEnd(4)} (${pct.padEnd(5)}%) ${bar}`);
    });
    console.log();

    // Order age analysis (latency from signal to order)
    const orderAges = noFills
      .map(nf => nf.order_age_ms)
      .filter(age => age !== undefined && age !== null);

    if (orderAges.length > 0) {
      console.log(`Order age (latency T3→T4 = signal to order send):`);
      const ageStats = stats(orderAges, 0);
      console.log(`  Min: ${ageStats.min}ms | Max: ${ageStats.max}ms | Avg: ${ageStats.avg}ms`);
      console.log(`  p50: ${ageStats.p50}ms | p95: ${ageStats.p95}ms`);

      const fast = orderAges.filter(age => age < 100).length;
      const medium = orderAges.filter(age => age >= 100 && age < 500).length;
      const slow = orderAges.filter(age => age >= 500).length;

      console.log(`  Distribution by speed:`);
      console.log(`    <100ms (fast): ${fast} (${((fast/orderAges.length)*100).toFixed(1)}%)`);
      console.log(`    100-500ms (normal): ${medium} (${((medium/orderAges.length)*100).toFixed(1)}%)`);
      console.log(`    ≥500ms (slow): ${slow} (${((slow/orderAges.length)*100).toFixed(1)}%)`);
    }
    console.log();

    // Price movement analysis
    const priceMovements = noFills
      .map(nf => nf.price_moved_pct)
      .filter(pm => pm !== undefined && pm !== null);

    if (priceMovements.length > 0) {
      console.log(`Price movements at NO_FILL time:`);
      const pmStats = stats(priceMovements, 4);
      console.log(`  Min: ${pmStats.min}% | Max: ${pmStats.max}% | Avg: ${pmStats.avg}%`);
      console.log(`  p50: ${pmStats.p50}% | p95: ${pmStats.p95}%`);

      const small = priceMovements.filter(pm => pm < 0.01).length;
      const medium = priceMovements.filter(pm => pm >= 0.01 && pm < 0.05).length;
      const large = priceMovements.filter(pm => pm >= 0.05).length;

      console.log(`  Distribution by magnitude:`);
      console.log(`    <1% (small): ${small} (${((small/priceMovements.length)*100).toFixed(1)}%)`);
      console.log(`    1-5% (medium): ${medium} (${((medium/priceMovements.length)*100).toFixed(1)}%)`);
      console.log(`    ≥5% (large): ${large} (${((large/priceMovements.length)*100).toFixed(1)}%)`);
    }
    console.log();
  }

  // ========== SECTION 3: CORRELATION ANALYSIS ==========
  console.log('┌' + '─'.repeat(62) + '┐');
  console.log('│ 3️⃣  CORRELATION ANALYSIS                                      │');
  console.log('└' + '─'.repeat(62) + '┘\n');

  // Correlation: lag metrics vs fill rate
  const signalsWithFill = signals.filter(s => {
    const correspondingOrder = orders.find(o => o.signal_id === s.signal_id);
    if (!correspondingOrder) return false;
    const fill = botEvents.find(e => e.order_id === correspondingOrder.order_id && e.event_type === 'FILL');
    return !!fill;
  });

  const signalsWithNoFill = signals.filter(s => {
    const correspondingOrder = orders.find(o => o.signal_id === s.signal_id);
    if (!correspondingOrder) return false;
    const noFill = botEvents.find(e => e.order_id === correspondingOrder.order_id && e.event_type === 'NO_FILL');
    return !!noFill;
  });

  console.log(`Fill rate correlation:`);
  console.log(`  Signals with fills: ${signalsWithFill.length}`);
  console.log(`  Signals with no-fills: ${signalsWithNoFill.length}`);

  if (signalsWithFill.length > 0) {
    const filledLagMs = signalsWithFill
      .map(s => s.poly_lag_ms)
      .filter(l => l !== undefined);
    const filledRates = signalsWithFill
      .map(s => s.poly_absorption_rate)
      .filter(r => r !== undefined);

    if (filledLagMs.length > 0) {
      const filledLagStats = stats(filledLagMs, 0);
      console.log(`  Filled signals - poly_lag_ms avg: ${filledLagStats.avg}ms`);
    }
    if (filledRates.length > 0) {
      const filledRateStats = stats(filledRates, 6);
      console.log(`  Filled signals - absorption_rate avg: ${filledRateStats.avg}¢/s`);
    }
  }

  if (signalsWithNoFill.length > 0) {
    const noFilledLagMs = signalsWithNoFill
      .map(s => s.poly_lag_ms)
      .filter(l => l !== undefined);
    const noFilledRates = signalsWithNoFill
      .map(s => s.poly_absorption_rate)
      .filter(r => r !== undefined);

    if (noFilledLagMs.length > 0) {
      const noFilledLagStats = stats(noFilledLagMs, 0);
      console.log(`  No-filled signals - poly_lag_ms avg: ${noFilledLagStats.avg}ms`);
    }
    if (noFilledRates.length > 0) {
      const noFilledRateStats = stats(noFilledRates, 6);
      console.log(`  No-filled signals - absorption_rate avg: ${noFilledRateStats.avg}¢/s`);
    }
  }
  console.log();

  // ========== SECTION 4: RECOMMENDATIONS ==========
  console.log('┌' + '─'.repeat(62) + '┐');
  console.log('│ 4️⃣  PHASE 3 FILTER RECOMMENDATIONS                             │');
  console.log('└' + '─'.repeat(62) + '┘\n');

  const recommendations = [];

  if (lagMs.length > 0) {
    const pct100 = ((lagMs.filter(l => l < 100).length / lagMs.length) * 100);
    if (pct100 > 50) {
      recommendations.push(`⚠️  ${pct100.toFixed(0)}% of signals have closed lag (<100ms)`);
      recommendations.push('   → Consider adding POLY_LAG_MIN_MS filter (>100ms threshold)\n');
    }
  }

  if (rates.length > 0) {
    const pctFast = ((rates.filter(r => r > 0.05).length / rates.length) * 100);
    if (pctFast > 20) {
      recommendations.push(`⚠️  ${pctFast.toFixed(0)}% of signals have fast convergence (>0.05¢/s)`);
      recommendations.push('   → Consider adding POLY_ABSORPTION_MAX filter (<0.03¢/s threshold)\n');
    }
  }

  if (gaps.length > 0) {
    const pctLag = ((gaps.filter(g => g > 0.02).length / gaps.length) * 100);
    if (pctLag < 30) {
      recommendations.push(`⚠️  Only ${pctLag.toFixed(0)}% of signals have positive price gap (lag indicator)`);
      recommendations.push('   → Polymarket may be too synchronized with BTC. Review edge hypothesis.\n');
    }
  }

  if (noFills.length > 0) {
    const priceMoved = noFills.filter(nf => nf.rejection_reason === 'price_moved').length;
    if ((priceMoved / noFills.length) > 0.4) {
      recommendations.push(`ℹ️  ${((priceMoved/noFills.length)*100).toFixed(0)}% of NO_FILL due to price_moved`);
      recommendations.push('   → Order execution latency may be limiting factor. Review timing.\n');
    }
  }

  if (recommendations.length === 0) {
    console.log('✅ Data quality looks good for Phase 3 filter calibration');
    console.log('   Proceed with threshold analysis based on distributions above.\n');
  } else {
    recommendations.forEach(rec => console.log(rec));
  }

  // ========== FOOTER ==========
  console.log('═'.repeat(64));
  console.log('Data Analysis Complete');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log('═'.repeat(64) + '\n');
}

analyzeMetrics().catch(console.error);
