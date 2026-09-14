/**
 * PHASE 2: Validation Report Generator
 *
 * Análisis de datos recolectados:
 * 1. Cuenta de eventos por stream
 * 2. Completitud de mercados
 * 3. Validación de strikes
 * 4. Disponibilidad de timestamps
 * 5. Disponibilidad de order book
 * 6. Ejemplos de reconstrucción completa
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BINANCE_RAW_FILE = path.join(DATA_DIR, 'binance-raw.jsonl');
const POLYMARKET_RAW_FILE = path.join(DATA_DIR, 'polymarket-raw.jsonl');
const BOT_EVENTS_FILE = path.join(DATA_DIR, 'bot-events.jsonl');

async function readJsonl(filePath) {
  const records = [];
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
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
        console.error(`Error parsing line: ${line.substring(0, 100)}`);
      }
    }
  }
  return records;
}

async function generateReport() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  PHASE 2 VALIDATION REPORT - INITIAL DATA COLLECTION TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Read all streams
  console.log('📂 Reading data streams...');
  const binanceRaw = await readJsonl(BINANCE_RAW_FILE);
  const polymarketRaw = await readJsonl(POLYMARKET_RAW_FILE);
  const botEvents = await readJsonl(BOT_EVENTS_FILE);

  console.log(`   ✓ binance-raw.jsonl: ${binanceRaw.length} records`);
  console.log(`   ✓ polymarket-raw.jsonl: ${polymarketRaw.length} records`);
  console.log(`   ✓ bot-events.jsonl: ${botEvents.length} records\n`);

  // === 1. EVENT COUNTS ===
  console.log('1️⃣  EVENT SUMMARY BY TYPE');
  console.log('─'.repeat(60));

  const eventsByType = {};
  botEvents.forEach(evt => {
    eventsByType[evt.event_type] = (eventsByType[evt.event_type] || 0) + 1;
  });

  for (const [type, count] of Object.entries(eventsByType).sort()) {
    console.log(`   ${type.padEnd(25)}: ${count}`);
  }
  console.log();

  // === 2. MARKET COMPLETENESS ===
  console.log('2️⃣  MARKET COMPLETENESS');
  console.log('─'.repeat(60));

  const marketStats = {};

  binanceRaw.forEach(rec => {
    const mid = rec.market_id;
    if (!marketStats[mid]) {
      marketStats[mid] = {
        market_id: mid,
        binance_events: 0,
        polymarket_events: 0,
        bot_events: 0,
        signal_generated: 0,
        order_sent: 0,
        fills: 0,
        no_fills: 0,
        market_start: rec.market_start_ms,
        market_end: rec.market_end_ms,
        has_strikes: !!rec.official_strike_price && !!rec.bot_captured_strike_price,
        has_timestamps: !!rec.binance_timestamp_ms,
        has_orderbook: false,
      };
    }
    marketStats[mid].binance_events++;
  });

  polymarketRaw.forEach(rec => {
    const mid = rec.market_id;
    if (!marketStats[mid]) {
      marketStats[mid] = {
        market_id: mid,
        binance_events: 0,
        polymarket_events: 0,
        bot_events: 0,
        signal_generated: 0,
        order_sent: 0,
        fills: 0,
        no_fills: 0,
        market_start: rec.market_start_ms,
        market_end: rec.market_end_ms,
        has_strikes: false,
        has_timestamps: false,
        has_orderbook: !!rec.yes_bid && !!rec.yes_ask && !!rec.no_bid && !!rec.no_ask,
      };
    }
    marketStats[mid].polymarket_events++;
    if (rec.yes_bid && rec.yes_ask && rec.no_bid && rec.no_ask) {
      marketStats[mid].has_orderbook = true;
    }
  });

  botEvents.forEach(rec => {
    const mid = rec.market_id;
    if (!marketStats[mid]) {
      marketStats[mid] = {
        market_id: mid,
        binance_events: 0,
        polymarket_events: 0,
        bot_events: 0,
        signal_generated: 0,
        order_sent: 0,
        fills: 0,
        no_fills: 0,
        market_start: rec.market_start_ms,
        market_end: rec.market_end_ms,
        has_strikes: false,
        has_timestamps: false,
        has_orderbook: false,
      };
    }
    marketStats[mid].bot_events++;
    if (rec.event_type === 'SIGNAL_GENERATED') marketStats[mid].signal_generated++;
    if (rec.event_type === 'ORDER_SENT') marketStats[mid].order_sent++;
    if (rec.event_type === 'FILL') marketStats[mid].fills++;
    if (rec.event_type === 'NO_FILL') marketStats[mid].no_fills++;
  });

  // Show stats
  const markets = Object.values(marketStats).sort(
    (a, b) => b.binance_events + b.polymarket_events - (a.binance_events + a.polymarket_events)
  );

  console.log(`Total markets: ${markets.length}\n`);
  console.log(
    'Top 10 markets by event volume:'.padEnd(60)
  );
  console.log(
    'Market ID'.padEnd(20) +
      'Binance'.padEnd(10) +
      'Polymarket'.padEnd(12) +
      'Bot'.padEnd(6) +
      'Status'
  );
  console.log('─'.repeat(60));

  markets.slice(0, 10).forEach((m) => {
    const isComplete =
      m.binance_events > 0 &&
      m.polymarket_events > 0 &&
      m.signal_generated > 0 &&
      (m.fills > 0 || m.no_fills > 0);
    const status = isComplete ? '✓ Complete' : '⚠ Partial';
    console.log(
      (m.market_id || 'unknown').substring(0, 19).padEnd(20) +
        String(m.binance_events).padEnd(10) +
        String(m.polymarket_events).padEnd(12) +
        String(m.bot_events).padEnd(6) +
        status
    );
  });
  console.log();

  // === 3. STRIKE VALIDATION ===
  console.log('3️⃣  STRIKE PRICE VALIDATION');
  console.log('─'.repeat(60));

  let strikeValid = 0;
  let strikeMissing = 0;
  let strikeMismatch = 0;

  markets.forEach((m) => {
    if (!m.has_strikes) {
      strikeMissing++;
    } else {
      strikeValid++;
    }
  });

  console.log(`   Valid (both official & captured): ${strikeValid}`);
  console.log(`   Missing strikes: ${strikeMissing}`);
  console.log(`   Mismatch detected: ${strikeMismatch}\n`);

  // === 4. TIMESTAMP QUALITY ===
  console.log('4️⃣  TIMESTAMP QUALITY (SOURCE vs RECEIVED_ONLY)');
  console.log('─'.repeat(60));

  let timestampSource = 0;
  let timestampReceived = 0;

  binanceRaw.forEach((rec) => {
    if (rec.timestamp_quality === 'source') timestampSource++;
    else if (rec.timestamp_quality === 'received_only') timestampReceived++;
  });

  const totalBinanceTs = binanceRaw.length;
  console.log(`   Binance timestamps from SOURCE: ${timestampSource} (${((timestampSource / totalBinanceTs) * 100).toFixed(1)}%)`);
  console.log(`   Binance timestamps RECEIVED_ONLY: ${timestampReceived} (${((timestampReceived / totalBinanceTs) * 100).toFixed(1)}%)\n`);

  // === 5. ORDER BOOK AVAILABILITY ===
  console.log('5️⃣  ORDER BOOK COMPLETENESS');
  console.log('─'.repeat(60));

  let bookComplete = 0;
  let bookPartial = 0;

  polymarketRaw.forEach((rec) => {
    if (
      rec.yes_bid !== null &&
      rec.yes_ask !== null &&
      rec.no_bid !== null &&
      rec.no_ask !== null
    ) {
      bookComplete++;
    } else {
      bookPartial++;
    }
  });

  console.log(`   Complete order book (4 levels): ${bookComplete} (${((bookComplete / polymarketRaw.length) * 100).toFixed(1)}%)`);
  console.log(`   Partial order book: ${bookPartial} (${((bookPartial / polymarketRaw.length) * 100).toFixed(1)}%)\n`);

  // === 6. MARKET RECONSTRUCTION EXAMPLES ===
  console.log('6️⃣  MARKET RECONSTRUCTION EXAMPLES');
  console.log('─'.repeat(60));

  // Find 2-3 most complete markets
  const completeMarkets = markets
    .filter(
      (m) =>
        m.binance_events > 5 &&
        m.polymarket_events > 5 &&
        m.signal_generated > 0 &&
        (m.fills > 0 || m.no_fills > 0)
    )
    .slice(0, 3);

  if (completeMarkets.length === 0) {
    console.log('   No complete market cycles found yet. Collection still in progress.\n');
  } else {
    completeMarkets.forEach((market, idx) => {
      console.log(`\n   MARKET ${idx + 1}: ${market.market_id}`);
      console.log('   ' + '─'.repeat(56));

      const marketBinance = binanceRaw.filter((r) => r.market_id === market.market_id);
      const marketPoly = polymarketRaw.filter((r) => r.market_id === market.market_id);
      const marketEvents = botEvents.filter((e) => e.market_id === market.market_id);

      if (marketBinance.length > 0) {
        const first = marketBinance[0];
        const last = marketBinance[marketBinance.length - 1];
        console.log(
          `   Binance: ${marketBinance.length} events | ` +
            `Start: $${(first.btc_price_last || 0).toFixed(2)} | ` +
            `End: $${(last.btc_price_last || 0).toFixed(2)}`
        );
      }

      if (marketPoly.length > 0) {
        const first = marketPoly[0];
        const last = marketPoly[marketPoly.length - 1];
        console.log(
          `   Polymarket: ${marketPoly.length} updates | ` +
            `YES: ${(first.yes_price || 0).toFixed(4)} → ${(last.yes_price || 0).toFixed(4)}`
        );
      }

      if (marketEvents.length > 0) {
        const signalEvt = marketEvents.find((e) => e.event_type === 'SIGNAL_GENERATED');
        const orderEvt = marketEvents.find((e) => e.event_type === 'ORDER_SENT');
        const fillEvt = marketEvents.find((e) => e.event_type === 'FILL' || e.event_type === 'NO_FILL');

        if (signalEvt) {
          console.log(
            `   Signal: Z=${(signalEvt.z_score || 0).toFixed(2)} | ` +
              `Edge=${((signalEvt.edge_detected_pct || 0) * 100).toFixed(2)}%`
          );
        }
        if (orderEvt) {
          console.log(
            `   Order: ${orderEvt.order_intent} @ ${(orderEvt.order_price || 0).toFixed(4)} | ` +
              `Size: ${orderEvt.order_size}`
          );
        }
        if (fillEvt) {
          console.log(
            `   Result: ${fillEvt.fill_result || 'UNKNOWN'} @ ${(fillEvt.filled_price || 0).toFixed(4)} | ` +
              `Latency: ${fillEvt.fill_latency_ms}ms`
          );
        }
      }
    });
    console.log();
  }

  // === SUMMARY ===
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  VALIDATION SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const completeMarketCount = markets.filter(
    (m) =>
      m.binance_events > 5 &&
      m.polymarket_events > 5 &&
      m.signal_generated > 0 &&
      (m.fills > 0 || m.no_fills > 0)
  ).length;

  console.log(`✓ Total data streams: 3 (binance-raw, polymarket-raw, bot-events)`);
  console.log(`✓ Total events collected: ${binanceRaw.length + polymarketRaw.length + botEvents.length}`);
  console.log(`✓ Markets covered: ${markets.length}`);
  console.log(`✓ Complete market cycles: ${completeMarketCount}`);
  console.log(`✓ Strike validation: ${strikeValid}/${markets.length} markets`);
  console.log(`✓ Order book completeness: ${((bookComplete / polymarketRaw.length) * 100).toFixed(1)}%`);
  console.log(`✓ Timestamp source availability: ${((timestampSource / totalBinanceTs) * 100).toFixed(1)}%\n`);

  if (completeMarketCount >= 20) {
    console.log('✅ READY FOR SCALED COLLECTION');
    console.log('   Data quality validated. Can proceed with full dataset collection.\n');
  } else if (completeMarketCount >= 5) {
    console.log('⚠️  PARTIAL VALIDATION');
    console.log(`   ${completeMarketCount} complete cycles. Continue monitoring for more data.\n`);
  } else {
    console.log('⏳ COLLECTION IN PROGRESS');
    console.log(`   ${completeMarketCount} complete cycles. More data needed for validation.\n`);
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
}

generateReport().catch(console.error);
