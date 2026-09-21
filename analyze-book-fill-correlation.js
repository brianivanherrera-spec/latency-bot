#!/usr/bin/env node
/**
 * Analyze fill rate correlation with book data availability
 * Checks if empty-book trades have higher NO_FILL rates
 *
 * Run: node analyze-book-fill-correlation.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILLS_FILE = path.join(DATA_DIR, 'fills.jsonl');

function analyzeBookCorrelation() {
  if (!fs.existsSync(FILLS_FILE)) {
    console.log('❌ fills.jsonl not found at ' + FILLS_FILE);
    return;
  }

  const lines = fs.readFileSync(FILLS_FILE, 'utf8').trim().split('\n').filter(l => l);

  // Split trades by book data availability
  const withBookData = [];
  const withoutBookData = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line);

      // Check if book data is present
      // Book is "empty" if imbalance is null/undefined or if critical fields are missing
      const hasBookImbalance = record.book_vol_imbalance !== null && record.book_vol_imbalance !== undefined;
      const hasBookYesBid = record.book_yes_bid !== null && record.book_yes_bid !== undefined;
      const hasBookData = hasBookImbalance && hasBookYesBid;

      if (hasBookData) {
        withBookData.push(record);
      } else {
        withoutBookData.push(record);
      }
    } catch (e) {
      console.warn(`⚠️  Failed to parse line: ${line.slice(0,50)}`);
    }
  }

  // Calculate fill rates
  function calcFillStats(trades) {
    if (trades.length === 0) return { filled: 0, noFill: 0, rate: 0, total: 0 };

    const filled = trades.filter(t => t.fill_result === 'FILLED').length;
    const noFill = trades.filter(t => t.fill_result === 'NO_FILL').length;
    const rate = (filled / trades.length * 100).toFixed(1);

    return { filled, noFill, total: trades.length, rate };
  }

  const withBookStats = calcFillStats(withBookData);
  const withoutBookStats = calcFillStats(withoutBookData);
  const totalStats = calcFillStats(withBookData.concat(withoutBookData));

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     FILL RATE ANALYSIS: Book Data Availability Correlation     ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log('📊 ORDERS WITH REAL BOOK DATA (imbalance & bid available):');
  console.log(`   Total:   ${withBookStats.total}`);
  console.log(`   Filled:  ${withBookStats.filled} (${withBookStats.rate}%)`);
  console.log(`   NO_FILL: ${withBookStats.noFill} (${(100-parseFloat(withBookStats.rate)).toFixed(1)}%)`);

  console.log('\n📚 ORDERS WITH EMPTY/NULL BOOK DATA:');
  console.log(`   Total:   ${withoutBookStats.total}`);
  console.log(`   Filled:  ${withoutBookStats.filled} (${withoutBookStats.rate}%)`);
  console.log(`   NO_FILL: ${withoutBookStats.noFill} (${(100-parseFloat(withoutBookStats.rate)).toFixed(1)}%)`);

  console.log('\n📈 OVERALL SUMMARY:');
  console.log(`   Total Orders: ${totalStats.total}`);
  console.log(`   Filled: ${totalStats.filled} (${totalStats.rate}%)`);
  console.log(`   NO_FILL: ${totalStats.noFill} (${(100-parseFloat(totalStats.rate)).toFixed(1)}%)`);

  // Analysis
  const fillDiff = parseFloat(withBookStats.rate) - parseFloat(withoutBookStats.rate);
  const noFillDiff = (100-parseFloat(withBookStats.rate)) - (100-parseFloat(withoutBookStats.rate));

  console.log('\n🔍 CORRELATION ANALYSIS:');
  if (noFillDiff > 5) {
    console.log(`   ⚠️  STRONG CORRELATION: Empty-book trades have ${noFillDiff.toFixed(1)}% HIGHER NO_FILL rate`);
    console.log(`   📌 Implication: The BOOK_FILTER fix that accepts empty-book orders is causing fills to fail`);
    console.log(`   💡 Solution: Skip signals entirely when book data is unavailable (don't place orders)`);
  } else if (noFillDiff > 2) {
    console.log(`   ⚡ Moderate correlation: Empty-book trades have ${noFillDiff.toFixed(1)}% higher NO_FILL rate`);
  } else {
    console.log(`   ✅ No strong correlation: Book availability doesn't significantly impact fill rate`);
    console.log(`   (Difference: ${noFillDiff.toFixed(1)}%)`);
  }

  console.log('\n📋 NO_FILL REASONS - WITH BOOK DATA:');
  const reasonsWithBook = {};
  withBookData.filter(t => t.fill_result === 'NO_FILL').forEach(t => {
    const reason = t.rejection_reason || '(no reason)';
    reasonsWithBook[reason] = (reasonsWithBook[reason] || 0) + 1;
  });
  Object.entries(reasonsWithBook)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([reason, count]) => {
      console.log(`   ${reason}: ${count}`);
    });

  console.log('\n📋 NO_FILL REASONS - WITHOUT BOOK DATA:');
  const reasonsWithoutBook = {};
  withoutBookData.filter(t => t.fill_result === 'NO_FILL').forEach(t => {
    const reason = t.rejection_reason || '(no reason)';
    reasonsWithoutBook[reason] = (reasonsWithoutBook[reason] || 0) + 1;
  });
  Object.entries(reasonsWithoutBook)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([reason, count]) => {
      console.log(`   ${reason}: ${count}`);
    });

  console.log('\n');
}

analyzeBookCorrelation();
