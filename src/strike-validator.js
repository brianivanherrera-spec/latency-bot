#!/usr/bin/env node
/**
 * Strike Price Validator
 * Cross-references Polymarket BTC market strikes against Binance 5-min klines
 * Goal: confirm strike ≈ Binance open price to enable Binance-close outcome prediction
 *
 * Runs on startup + every 5 minutes
 * Exports: /data/strike-validation.jsonl
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const VALIDATION_FILE = path.join(DATA_DIR, 'strike-validation.jsonl');

const logger = {
  info: (msg) => console.log(`[STRIKE-VALIDATOR] ${msg}`),
  error: (msg) => console.error(`[STRIKE-VALIDATOR] ${msg}`),
  warn: (msg) => console.warn(`[STRIKE-VALIDATOR] ${msg}`),
};

/**
 * Fetch Binance 5-min klines for BTCUSDT
 */
async function fetchBinanceKlines() {
  try {
    const response = await fetch(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=50'
    );
    if (!response.ok) {
      logger.error(`Binance API error: ${response.status}`);
      return null;
    }
    const data = await response.json();
    return data.map((kline) => ({
      openTime: parseInt(kline[0]),
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5]),
      closeTime: parseInt(kline[6]),
    }));
  } catch (err) {
    logger.error(`Failed to fetch Binance klines: ${err.message}`);
    return null;
  }
}

/**
 * Fetch active Polymarket BTC markets from Gamma API
 */
async function fetchPolymarketMarkets() {
  try {
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?tag=BTC&active=true&closed=false'
    );
    if (!response.ok) {
      logger.error(`Gamma API error: ${response.status}`);
      return null;
    }
    const data = await response.json();
    // Assume data is an array of markets or has a markets property
    const markets = Array.isArray(data) ? data : data.markets || [];
    return markets.map((market) => ({
      id: market.id,
      question: market.question,
      startDate: market.startDate ? new Date(market.startDate).getTime() : null,
      endDate: market.endDate ? new Date(market.endDate).getTime() : null,
      outcomePrices: market.outcomePrices || {},
      yesPrice: market.outcomePrices?.[0] || null,
      noPrice: market.outcomePrices?.[1] || null,
    }));
  } catch (err) {
    logger.error(`Failed to fetch Polymarket markets: ${err.message}`);
    return null;
  }
}

/**
 * Extract strike price from market question text
 * Looks for patterns like "$63,450" or "63450"
 */
function extractStrikePrice(question) {
  if (!question) return null;
  // Match currency format: $XX,XXX or $XX,XXX.XX
  const match = question.match(/\$?([\d,]+(?:\.\d{2})?)/);
  if (match) {
    return parseFloat(match[1].replace(/,/g, ''));
  }
  return null;
}

/**
 * Find closest kline by timestamp (within 60s)
 */
function findClosestKline(klines, targetTime, isOpenTime = true) {
  if (!klines || klines.length === 0) return null;
  let closest = null;
  let minDiff = 60000; // 60 seconds in ms
  for (const kline of klines) {
    const klineTime = isOpenTime ? kline.openTime : kline.closeTime;
    const diff = Math.abs(klineTime - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closest = kline;
    }
  }
  return closest;
}

/**
 * Cross-reference markets with klines and calculate validation metrics
 */
function validateStrikes(klines, markets) {
  if (!klines || !markets) return [];
  const validations = [];

  for (const market of markets) {
    if (!market.endDate) continue;

    const strikePrice = extractStrikePrice(market.question);
    if (!strikePrice) continue;

    // Find opening kline (close to market start)
    const openKline = market.startDate
      ? findClosestKline(klines, market.startDate, true)
      : findClosestKline(klines, market.endDate - 300000, true); // ~5 min before end

    // Find closing kline (close to market end)
    const closeKline = findClosestKline(klines, market.endDate, false);

    if (!closeKline) continue;

    const strikeVsOpen = openKline ? strikePrice - openKline.open : null;
    const strikeVsOpenPct = openKline ? ((strikeVsOpen / openKline.open) * 100).toFixed(2) : null;
    const closedAboveStrike = strikePrice > 0 ? closeKline.close > strikePrice : null;

    validations.push({
      timestamp: Date.now(),
      marketId: market.id,
      marketEndTime: market.endDate,
      question: market.question,
      strike: strikePrice.toFixed(2),
      binanceOpen: openKline ? openKline.open.toFixed(2) : null,
      binanceClose: closeKline.close.toFixed(2),
      strikeVsOpenDiff: strikeVsOpen ? strikeVsOpen.toFixed(2) : null,
      strikeVsOpenPct,
      closedAboveStrike,
      predictedWinner: closedAboveStrike ? 'YES' : 'NO',
      yesPrice: market.yesPrice ? market.yesPrice.toFixed(4) : null,
      noPrice: market.noPrice ? market.noPrice.toFixed(4) : null,
      edge: market.yesPrice && closedAboveStrike ?
        ((market.yesPrice - 0.5) * 100).toFixed(1) :
        market.noPrice && !closedAboveStrike ?
        ((market.noPrice - 0.5) * 100).toFixed(1) : null,
    });
  }

  return validations.sort((a, b) => b.marketEndTime - a.marketEndTime).slice(0, 10);
}

/**
 * Log formatted table of validation results
 */
function logTable(validations) {
  if (validations.length === 0) {
    logger.warn('No validations to log');
    return;
  }

  console.log('\n╔════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    STRIKE PRICE VALIDATION (Last 10 Markets)                     ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════════╝\n');

  console.log(
    'Market End'.padEnd(20) +
    '| Strike'.padEnd(10) +
    '| BTC Open'.padEnd(12) +
    '| BTC Close'.padEnd(12) +
    '| Diff %'.padEnd(8) +
    '| Prediction'.padEnd(12) +
    '| Yes Price'.padEnd(12) +
    '| Edge'
  );
  console.log('─'.repeat(100));

  for (const val of validations) {
    const endTime = new Date(val.marketEndTime).toISOString().slice(11, 19);
    const diffPct = val.strikeVsOpenPct ? `${val.strikeVsOpenPct}%` : 'N/A';
    const edge = val.edge ? `${val.edge}%` : 'N/A';

    console.log(
      endTime.padEnd(20) +
      `$${val.strike}`.padEnd(10) +
      `$${val.binanceOpen || 'N/A'}`.padEnd(12) +
      `$${val.binanceClose}`.padEnd(12) +
      diffPct.padEnd(8) +
      val.predictedWinner.padEnd(12) +
      (val.yesPrice ? parseFloat(val.yesPrice).toFixed(3) : 'N/A').padEnd(12) +
      edge
    );
  }
  console.log('');
}

/**
 * Write validations to JSONL file
 */
function exportToJsonl(validations) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const jsonl = validations.map((v) => JSON.stringify(v)).join('\n') + '\n';
    fs.appendFileSync(VALIDATION_FILE, jsonl);
    logger.info(`Exported ${validations.length} validations to ${VALIDATION_FILE}`);
  } catch (err) {
    logger.error(`Failed to write validation file: ${err.message}`);
  }
}

/**
 * Main validation loop
 */
async function validateStrikes() {
  logger.info('Starting strike price validation...');

  const [klines, markets] = await Promise.all([
    fetchBinanceKlines(),
    fetchPolymarketMarkets(),
  ]);

  if (!klines || !markets) {
    logger.error('Failed to fetch required data');
    return;
  }

  const validations = validateStrikes(klines, markets);
  logTable(validations);
  exportToJsonl(validations);

  logger.info(`Validation complete: ${validations.length} markets analyzed`);
}

/**
 * Start validator: run once on startup, then every 5 minutes
 */
function startValidator() {
  logger.info('Strike Validator initialized');
  validateStrikes(); // Run immediately on startup

  setInterval(() => {
    validateStrikes().catch((err) => {
      logger.error(`Validation interval error: ${err.message}`);
    });
  }, 300000); // 5 minutes
}

// Export for use in index-final.js
module.exports = { startValidator, validateStrikes };

// Allow standalone execution
if (require.main === module) {
  validateStrikes();
}
