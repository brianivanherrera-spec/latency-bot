#!/usr/bin/env node
/**
 * PHASE 0 Analysis Tool
 * Analyzes fills.jsonl to validate audit hypotheses about NO_FILL causes
 *
 * Run: node analyze-fills.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILLS_FILE = path.join(DATA_DIR, 'fills.jsonl');

function analyzeNoFills() {
  if (!fs.existsSync(FILLS_FILE)) {
    console.log('❌ fills.jsonl not found. Run some trades first to collect data.');
    return;
  }

  const lines = fs.readFileSync(FILLS_FILE, 'utf8').trim().split('\n').filter(l => l);

  let filledCount = 0;
  let noFillCount = 0;

  // Hypotheses tracking
  const statusLiveNoFills = [];
  const bookDepthNoFills = [];
  const otherNoFills = [];
  const fillsByStatus = {};
  const noFillReasons = {};

  for (const line of lines) {
    try {
      const record = JSON.parse(line);

      if (record.fill_result === 'FILLED') {
        filledCount++;
        if (!fillsByStatus[record.order_status]) fillsByStatus[record.order_status] = 0;
        fillsByStatus[record.order_status]++;
      } else if (record.fill_result === 'NO_FILL') {
        noFillCount++;

        // Track hypothesis 1: status='live' wrongly classified as NO_FILL
        if (record.order_status === 'live') {
          statusLiveNoFills.push(record);
        }

        // Track hypothesis 2: book-depth exhaustion (no volume)
        // Indicators: constant price, 'ask_too_high', 'sin liquidez'
        const reason = record.rejection_reason || '';
        if (reason.includes('sin liquidez') || reason.includes('ask_too_high') ||
            (record.best_ask && !reason.includes('timeout'))) {
          bookDepthNoFills.push(record);
        } else {
          otherNoFills.push(record);
        }

        // Count reasons
        if (!noFillReasons[reason]) noFillReasons[reason] = 0;
        noFillReasons[reason]++;
      }
    } catch (e) {
      console.warn(`⚠️  Failed to parse line: ${line.slice(0,50)}`);
    }
  }

  const total = filledCount + noFillCount;
  const fillRate = total > 0 ? (filledCount / total * 100).toFixed(1) : 'N/A';

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║         PHASE 0 FILL TELEMETRY ANALYSIS                      ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log(`📊 FILL RATE SUMMARY:`);
  console.log(`   Total Orders:  ${total}`);
  console.log(`   Filled:        ${filledCount} (${fillRate}%)`);
  console.log(`   NO_FILL:       ${noFillCount} (${(100-parseFloat(fillRate)).toFixed(1)}%)\n`);

  console.log(`📈 FILLED ORDERS BY STATUS:`);
  Object.entries(fillsByStatus)
    .sort((a, b) => b[1] - a[1])
    .forEach(([status, count]) => {
      console.log(`   ${status}: ${count}`);
    });

  console.log(`\n🚨 HYPOTHESIS 1: status='live' wrongly classified as NO_FILL`);
  console.log(`   Count: ${statusLiveNoFills.length} (${total > 0 ? (statusLiveNoFills.length/total*100).toFixed(1) : '0'}% of all orders)`);
  if (statusLiveNoFills.length > 0) {
    console.log(`   ✓ HYPOTHESIS CONFIRMED: ${statusLiveNoFills.length} orders in book but logged as NO_FILL`);
    console.log(`   Impact if fixed: +${(statusLiveNoFills.length/noFillCount*100).toFixed(1)}% to reported fill rate`);
  } else {
    console.log(`   ✗ HYPOTHESIS NOT CONFIRMED`);
  }

  console.log(`\n📚 HYPOTHESIS 2: Book-depth exhaustion (no volume)`);
  console.log(`   Count: ${bookDepthNoFills.length} (${total > 0 ? (bookDepthNoFills.length/total*100).toFixed(1) : '0'}% of all orders)`);
  if (bookDepthNoFills.length > 0) {
    console.log(`   ✓ HYPOTHESIS PLAUSIBLE: ${bookDepthNoFills.length} orders show volume/liquidity issues`);
    console.log(`   Impact if fixed: +${(bookDepthNoFills.length/noFillCount*100).toFixed(1)}% to reported fill rate (if fixable)`);
  } else {
    console.log(`   ✗ HYPOTHESIS NOT CONFIRMED`);
  }

  console.log(`\n❓ OTHER NO_FILLS (unclear cause)`);
  console.log(`   Count: ${otherNoFills.length}`);

  console.log(`\n📋 NO_FILL REASONS BREAKDOWN:`);
  Object.entries(noFillReasons)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      console.log(`   ${reason}: ${count}`);
    });

  console.log(`\n💡 NEXT STEPS:`);
  if (statusLiveNoFills.length > 0) {
    console.log(`   1. ✓ PHASE 1: Fix the status='live' bug (confirmed ${statusLiveNoFills.length} misclassifications)`);
  }
  if (bookDepthNoFills.length > 0) {
    console.log(`   2. Investigate book-depth: Can we improve market selection or retry strategy?`);
  }
  console.log(`   3. Export detailed NO_FILL records for manual inspection`);

  console.log('\n📁 Raw data available in: ' + FILLS_FILE + '\n');
}

analyzeNoFills();
