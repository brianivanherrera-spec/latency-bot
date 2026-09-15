const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class MarketRecorder {
  constructor(dataDir = './data/markets', logger = console) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.currentMarketId = null;
    this.currentFile = null;
    this.currentStream = null;
    this.seq = 0;
    this.diag = {
      markets_started: 0,
      markets_completed: 0,
      events_binance: 0,
      events_chainlink_30s: 0,
      events_chainlink_60s: 0,
      events_polymarket: 0,
      events_signal: 0,
      events_order: 0,
      events_fill: 0,
      events_nofill: 0,
    };
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  startMarket(meta) {
    this.currentMarketId = meta.market_id;
    const ts = Date.now();
    const filename = `MARKET_${this.currentMarketId}_${ts}.jsonl`;
    this.currentFile = path.join(this.dataDir, filename);
    this.currentStream = fs.createWriteStream(this.currentFile, { flags: 'a' });
    this.seq = 0;
    this.diag.markets_started++;

    this._writeLine({
      seq: this.seq++,
      market_id: meta.market_id,
      type: 'MARKET_START',
      source: 'bot',
      source_ts: ts,
      received_ts: ts,
      timestamp_quality: 'local_now',
      question: meta.question || null,
      start_ts: meta.start_ts || null,
      end_ts: meta.end_ts || null,
      strike_price: meta.strike_price || null,
      strike_source: meta.strike_source || null,
    });
  }

  endMarket(data) {
    if (!this.currentStream) return;
    const ts = Date.now();

    this._writeLine({
      seq: this.seq++,
      market_id: this.currentMarketId,
      type: 'MARKET_END',
      source: 'bot',
      source_ts: ts,
      received_ts: ts,
      timestamp_quality: 'local_now',
      resolution: data.resolution || null,
      resolution_price: data.resolution_price || null,
      resolution_ts: data.resolution_ts || null,
      twap_30_final: data.twap_30_final || null,
      twap_60_final: data.twap_60_final || null,
    });

    this.currentStream.end();
    this.currentStream = null;
    this.currentFile = null;
    this.currentMarketId = null;
    this.diag.markets_completed++;
  }

  recordBinance(data) {
    if (!this.currentStream) return;
    this.diag.events_binance++;

    this._writeLine({
      seq: this.seq++,
      market_id: this.currentMarketId,
      type: 'BINANCE_SPOT',
      source: 'binance_ws',
      source_ts: data.source_ts || null,
      received_ts: data.received_ts,
      timestamp_quality: data.source_ts ? 'source_ts' : 'local_received',
      price: data.price,
      bid: data.bid || null,
      ask: data.ask || null,
      is_buyer_maker: data.is_buyer_maker || null,
    });
  }

  recordChainlink(event) {
    if (!this.currentStream) return;
    const isThirty = event.event_type === 'crypto_prices_twap_thirty';
    this.diag[isThirty ? 'events_chainlink_30s' : 'events_chainlink_60s']++;

    this._writeLine({
      seq: this.seq++,
      market_id: this.currentMarketId,
      type: isThirty ? 'CHAINLINK_TWAP_30S' : 'CHAINLINK_TWAP_60S',
      source: 'polymarket_rtds',
      source_ts: event.twap_timestamp,
      received_ts: event.received_ts || Date.now(),
      timestamp_quality: 'source_ts',
      twap_value: event.twap_value,
      asset_pair: event.asset_pair || 'BTC/USD',
      age_ms: event.age_ms || null,
    });
  }

  recordPolymarket(data) {
    if (!this.currentStream) return;
    this.diag.events_polymarket++;

    this._writeLine({
      seq: this.seq++,
      market_id: this.currentMarketId,
      type: 'POLYMARKET_PRICE',
      source: 'polymarket_ws',
      source_ts: null,
      received_ts: data.received_ts,
      timestamp_quality: 'local_received',
      yes: data.yes,
      no: data.no,
      bid_yes: data.bid_yes || null,
      ask_yes: data.ask_yes || null,
      bid_no: data.bid_no || null,
      ask_no: data.ask_no || null,
    });
  }

  recordSignal(data) {
    if (!this.currentStream) return;
    this.diag.events_signal++;

    this._writeLine({
      seq: this.seq++,
      market_id: this.currentMarketId,
      type: 'SIGNAL_GENERATED',
      source: 'bot_signal_engine',
      source_ts: null,
      received_ts: data.received_ts,
      timestamp_quality: 'local_now',
      signal_id: data.signal_id,
      direction: data.direction,
      zscore: data.zscore || null,
      imbalance: data.imbalance || null,
      score: data.score || null,
      edge_pct: data.edge_pct || null,
      binance_price: data.binance_price,
      twap_30: data.twap_30 || null,
      twap_60: data.twap_60 || null,
      binance_to_twap_30_ms: data.binance_to_twap_30_ms || null,
      binance_to_twap_60_ms: data.binance_to_twap_60_ms || null,
    });
  }

  recordOrder(data) {
    if (!this.currentStream) return;
    this.diag.events_order++;

    this._writeLine({
      seq: this.seq++,
      market_id: this.currentMarketId,
      type: 'ORDER_SENT',
      source: 'bot_order_engine',
      source_ts: null,
      received_ts: data.received_ts,
      timestamp_quality: 'local_received',
      signal_id: data.signal_id || null,
      order_id: data.order_id,
      order_type: data.order_type,
      price: data.price,
      size: data.size,
    });
  }

  recordFill(data) {
    if (!this.currentStream) return;
    this.diag.events_fill++;

    this._writeLine({
      seq: this.seq++,
      market_id: this.currentMarketId,
      type: 'FILL',
      source: 'bot_fill_watcher',
      source_ts: null,
      received_ts: data.received_ts,
      timestamp_quality: 'local_received',
      signal_id: data.signal_id || null,
      order_id: data.order_id,
      fill_price: data.fill_price,
      size_filled: data.size_filled,
      usdc_spent: data.usdc_spent,
      fill_time_ms: data.fill_time_ms || null,
    });
  }

  recordNoFill(data) {
    if (!this.currentStream) return;
    this.diag.events_nofill++;

    this._writeLine({
      seq: this.seq++,
      market_id: this.currentMarketId,
      type: 'NO_FILL',
      source: 'bot_fill_watcher',
      source_ts: null,
      received_ts: data.received_ts,
      timestamp_quality: 'local_received',
      signal_id: data.signal_id || null,
      order_id: data.order_id,
      reason: data.reason,
    });
  }

  _writeLine(obj) {
    if (!this.currentStream) return;
    try {
      this.currentStream.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      this.logger.error(`[MARKET-RECORDER] Write error: ${e.message}`);
    }
  }

  getDiag() {
    return { ...this.diag };
  }

  disconnect() {
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
    }
  }
}

module.exports = { MarketRecorder };
