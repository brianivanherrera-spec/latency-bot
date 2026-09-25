/**
 * MarketRecorder — Timeline completo de cada mercado de 5 minutos
 * Graba en /data/markets/MARKET_{id}_{ts}.jsonl
 * NO modifica signals.jsonl ni parámetros de trading.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { append } = require('./async-append');
const DATA_DIR = process.env.DATA_DIR || '/data';
const MARKETS_DIR = path.join(DATA_DIR, 'markets');
const BINANCE_MIN_CHANGE = 0.5;
const POLY_MIN_CHANGE = 0.002;

function ensureDirs() {
  try { if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR,    { recursive: true }); } catch(e) {}
  try { if (!fs.existsSync(MARKETS_DIR)) fs.mkdirSync(MARKETS_DIR, { recursive: true }); } catch(e) {}
}

class MarketRecorder {
  constructor() {
    ensureDirs();
    this._market = null; this._file = null; this._seq = 0;
    this._lastBinance = null; this._lastPoly = { yes: null, no: null };
    this.diag = {
      markets_started: 0, markets_completed: 0,
      events_binance: 0, events_chainlink_30s: 0, events_chainlink_60s: 0,
      events_polymarket: 0, events_signal: 0, events_order: 0, events_fill: 0, events_nofill: 0,
    };
  }
  startMarket({ market_id, question, start_ts, end_ts, strike_price, strike_source }) {
    if (this._market) this._append({ type: 'MARKET_INTERRUPTED', received_ts: Date.now() });
    this._seq = 0; this._lastBinance = null; this._lastPoly = { yes: null, no: null };
    const safe = (market_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    this._file = path.join(MARKETS_DIR, `MARKET_${safe}_${start_ts || Date.now()}.jsonl`);
    this._market = { market_id, question, start_ts, end_ts, strike_price, strike_source };
    this.diag.markets_started++;
    this._append({ type: 'MARKET_START', market_id, question, start_ts, end_ts, strike_price, strike_source, received_ts: Date.now(), timestamp_quality: 'good' });
  }
  recordBinance({ price, source_ts, received_ts, bid, ask, is_buyer_maker }) {
    if (!this._market) return;
    if (this._lastBinance !== null && Math.abs(price - this._lastBinance) < BINANCE_MIN_CHANGE) return;
    this._lastBinance = price; this.diag.events_binance++;
    const rt = received_ts || Date.now();
    this._append({ type: 'BINANCE_SPOT', source: 'binance_agg_trade', value: price,
      bid: bid ?? null, ask: ask ?? null, is_buyer_maker: is_buyer_maker ?? null,
      source_ts: source_ts || null, received_ts: rt,
      timestamp_quality: source_ts ? (rt - source_ts < 200 ? 'good' : 'stale') : 'no_source_ts' });
  }
  recordChainlink({ value, value_num, window_s, source_ts, received_ts, symbol, timestamp_quality, outer_ts }) {
    if (!this._market) return;
    if (window_s === 30) this.diag.events_chainlink_30s++;
    else                 this.diag.events_chainlink_60s++;
    this._append({ type: 'CHAINLINK_TWAP', source: 'chainlink_rtds', symbol: symbol || 'btc/usd',
      window_s, value, value_num, source_ts, received_ts: received_ts || Date.now(),
      outer_ts: outer_ts || null, timestamp_quality: timestamp_quality || 'unknown' });
  }
  recordPolymarket({ yes, no, bid_yes, ask_yes, bid_no, ask_no, received_ts }) {
    if (!this._market) return;
    const yc = this._lastPoly.yes === null || Math.abs(yes - this._lastPoly.yes) >= POLY_MIN_CHANGE;
    const nc = this._lastPoly.no  === null || Math.abs(no  - this._lastPoly.no)  >= POLY_MIN_CHANGE;
    if (!yc && !nc) return;
    this._lastPoly = { yes, no }; this.diag.events_polymarket++;
    this._append({ type: 'POLYMARKET_PRICE', source: 'polymarket_ws', yes, no,
      bid_yes: bid_yes ?? null, ask_yes: ask_yes ?? null, bid_no: bid_no ?? null, ask_no: ask_no ?? null,
      spread: (ask_yes && bid_yes) ? parseFloat((ask_yes - bid_yes).toFixed(4)) : null,
      received_ts: received_ts || Date.now(), timestamp_quality: 'good' });
  }
  recordSignal({ signal_id, direction, zscore, imbalance, score, edge_pct,
                 binance_price, twap_30, twap_60, binance_to_twap_30_ms, binance_to_twap_60_ms, received_ts }) {
    if (!this._market) return;
    this.diag.events_signal++;
    this._append({ type: 'SIGNAL_GENERATED', signal_id, direction, zscore, imbalance, score, edge_pct,
      binance_price, twap_30_at_signal: twap_30 ?? null, twap_60_at_signal: twap_60 ?? null,
      binance_to_twap_30_ms: binance_to_twap_30_ms ?? null,
      binance_to_twap_60_ms: binance_to_twap_60_ms ?? null,
      received_ts: received_ts || Date.now(), timestamp_quality: 'good' });
  }
  recordOrder({ signal_id, order_id, order_type, price, size, received_ts }) {
    if (!this._market) return;
    this.diag.events_order++;
    this._append({ type: 'ORDER_SENT', signal_id, order_id, order_type, price, size, received_ts: received_ts || Date.now(), timestamp_quality: 'good' });
  }
  recordFill({ signal_id, order_id, fill_price, size_filled, usdc_spent, fill_time_ms, received_ts }) {
    if (!this._market) return;
    this.diag.events_fill++;
    this._append({ type: 'FILL', signal_id, order_id, fill_price, size_filled, usdc_spent, fill_time_ms, received_ts: received_ts || Date.now(), timestamp_quality: 'good' });
  }
  recordNoFill({ signal_id, order_id, reason, received_ts }) {
    if (!this._market) return;
    this.diag.events_nofill++;
    this._append({ type: 'NO_FILL', signal_id, order_id, reason, received_ts: received_ts || Date.now(), timestamp_quality: 'good' });
  }
  endMarket({ resolution, resolution_price, resolution_ts, twap_30_final, twap_60_final, received_ts }) {
    if (!this._market) return;
    this.diag.markets_completed++;
    this._append({ type: 'MARKET_END', market_id: this._market.market_id,
      resolution, resolution_price: resolution_price ?? null, resolution_ts,
      twap_30_final: twap_30_final ?? null, twap_60_final: twap_60_final ?? null,
      total_events: this._seq, received_ts: received_ts || Date.now(), timestamp_quality: 'good' });
    this._market = null; this._file = null;
  }
  getDiag() {
    return { ...this.diag, current_market: this._market?.market_id ?? null, events_in_market: this._seq };
  }
  _append(data) {
    if (!this._file) return;
    try {
      append(this._file, JSON.stringify({ seq: ++this._seq, market_id: this._market?.market_id ?? null, ...data }));
    } catch(e) {}
  }
}
module.exports = { MarketRecorder };
