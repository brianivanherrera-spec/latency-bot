/**
 * PHASE 2: Logger — Captura RAW de 3 streams JSONL
 *
 * Principio: RAW = SOURCE OF TRUTH
 * - binance-raw.jsonl: Cada tick de Binance sin agregación
 * - polymarket-raw.jsonl: Cada update de Polymarket sin filtrar
 * - bot-events.jsonl: Eventos del bot (SIGNAL, ORDER, FILL, RESOLUTION)
 *
 * Todos los timestamps en milliseconds (Date.now()) con timestamp_quality
 * indicando si vienen de source o si es received_only
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const BINANCE_RAW_FILE = path.join(DATA_DIR, 'binance-raw.jsonl');
const POLYMARKET_RAW_FILE = path.join(DATA_DIR, 'polymarket-raw.jsonl');
const BOT_EVENTS_FILE = path.join(DATA_DIR, 'bot-events.jsonl');

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
}

// ─── BINANCE RAW ──────────────────────────────────────────────────────────
/**
 * Log raw Binance data — máxima resolución disponible (subsecond)
 * @param {Object} data - Datos de Binance
 *   - price: último precio
 *   - timestamp: timestamp de recepción (Date.now())
 *   - latencyMs: lag estimado desde exchange
 *   - binance_timestamp_ms: timestamp original de Binance (si disponible)
 *   - volume, bestBid, bestAsk, etc.
 * @param {Object} market - mercado actual
 * @param {Object} strikes - { official, captured, source, timestamp }
 */
function logBinanceRaw(data, market, strikes) {
  ensureDir();
  try {
    const record = {
      // Identificación del mercado
      market_id: market?.tokenId || null,
      market_start_ms: market?.market_start_time || null,
      market_end_ms: market?.market_end_time || null,

      // Strike prices
      official_strike_price: strikes?.official || null,
      bot_captured_strike_price: strikes?.captured || null,
      strike_source: strikes?.source || null,
      strike_capture_timestamp_ms: strikes?.timestamp || null,

      // Resolución final
      market_resolution: market?.market_resolution || null,

      // === DATOS RAW DE BINANCE ===
      // Timestamp original de Binance si disponible, sino recepción del bot
      binance_timestamp_ms: data.binance_timestamp_ms || data.timestamp,
      bot_received_timestamp_ms: data.timestamp,
      timestamp_quality: data.binance_timestamp_ms ? 'source' : 'received_only',

      // Precios
      btc_price_bid: data.bestBid || null,
      btc_price_ask: data.bestAsk || null,
      btc_price_last: data.price || null,
      btc_price_open: data.open || null,
      btc_price_high: data.high || null,
      btc_price_low: data.low || null,
      btc_price_close: data.close || data.price || null,

      // Volumen y trades
      btc_volume: data.volume || null,
      btc_quote_asset_volume: data.quoteAssetVolume || null,
      number_of_trades: data.numberOfTrades || null,

      // Trade details
      trade_id: data.trade_id || null,
      taker_buy_base_asset: data.takerBuyBaseAsset || null,
      taker_buy_quote_asset: data.takerBuyQuoteAsset || null,

      // Metadata
      btc_source: data.source || 'binance_ws',
      kline_interval: data.kline_interval || 'tick',
      isBuyerMaker: data.isBuyerMaker !== undefined ? data.isBuyerMaker : null,
    };

    fs.appendFileSync(BINANCE_RAW_FILE, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error(`[PHASE2] Error logging binance raw: ${e.message}`);
  }
}

// ─── POLYMARKET RAW ───────────────────────────────────────────────────────
/**
 * Log raw Polymarket data — cada update del WebSocket sin filtrar
 * @param {Object} data - Update de Polymarket
 *   - yes_price, no_price, spreads, bid/ask, sizes
 *   - timestamp: cuándo llegó al bot
 *   - event_source_timestamp_ms: si viene del WS (timestamp de origen)
 * @param {Object} market - mercado actual
 * @param {string} eventId - ID único del evento
 */
function logPolymarketRaw(data, market, eventId) {
  ensureDir();
  try {
    const record = {
      // Identificación
      market_id: market?.tokenId || null,
      market_start_ms: market?.market_start_time || null,
      market_end_ms: market?.market_end_time || null,
      event_id: eventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,

      // === TIMESTAMPS: ORIGEN vs RECEPCIÓN ===
      event_source_timestamp_ms: data.event_source_timestamp_ms || null,
      event_received_timestamp_ms: data.timestamp || Date.now(),
      timestamp_quality: data.event_source_timestamp_ms ? 'source' : 'received_only',

      // Latency si hay timestamp de origen
      event_latency_ms:
        data.event_source_timestamp_ms && data.timestamp
          ? data.timestamp - data.event_source_timestamp_ms
          : null,

      event_source: data.event_source || 'ws',

      // === PRECIOS ===
      yes_price: data.yes_price || null,
      no_price: data.no_price || null,
      yes_mid: data.yes_mid || (data.yes_bid && data.yes_ask ? (data.yes_bid + data.yes_ask) / 2 : null),
      no_mid: data.no_mid || (data.no_bid && data.no_ask ? (data.no_bid + data.no_ask) / 2 : null),

      // === ORDER BOOK COMPLETO ===
      yes_bid: data.yes_bid || null,
      yes_ask: data.yes_ask || null,
      no_bid: data.no_bid || null,
      no_ask: data.no_ask || null,

      yes_bid_size: data.yes_bid_size || null,
      yes_ask_size: data.yes_ask_size || null,
      no_bid_size: data.no_bid_size || null,
      no_ask_size: data.no_ask_size || null,

      // Spreads
      yes_spread: data.yes_spread || (data.yes_ask && data.yes_bid ? data.yes_ask - data.yes_bid : null),
      no_spread: data.no_spread || (data.no_ask && data.no_bid ? data.no_ask - data.no_bid : null),

      // Cambio desde evento anterior
      previous_yes_price: data.previous_yes_price || null,
      yes_price_change: data.yes_price_change || null,
      yes_price_change_bps: data.yes_price_change_bps || null,

      // Timing del mercado
      window_elapsed_sec: data.window_elapsed_sec || null,
      window_remaining_sec: data.window_remaining_sec || null,
    };

    fs.appendFileSync(POLYMARKET_RAW_FILE, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error(`[PHASE2] Error logging polymarket raw: ${e.message}`);
  }
}

// ─── BOT EVENTS ───────────────────────────────────────────────────────────
/**
 * Log bot events: SIGNAL_GENERATED, ORDER_SENT, FILL, NO_FILL, RESOLUTION
 * @param {string} eventType - tipo de evento
 * @param {Object} data - datos del evento
 */
function logBotEvent(eventType, data) {
  ensureDir();
  try {
    const record = {
      // Identificación del evento
      event_id: data.event_id || `evt_bot_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      event_type: eventType,
      event_timestamp_ms: data.event_timestamp_ms || Date.now(),
      timestamp_quality: data.event_timestamp_ms ? 'source' : 'received_only',

      // Relaciones para reconstruir flujo
      market_id: data.market_id || null,
      signal_id: data.signal_id || null,
      order_id: data.order_id || null,
      market_start_ms: data.market_start_ms || null,
      market_end_ms: data.market_end_ms || null,

      // Estado del mercado en este evento
      btc_price_snapshot: data.btc_price_snapshot || null,
      official_strike_price: data.official_strike_price || null,
      bot_captured_strike_price: data.bot_captured_strike_price || null,
      yes_price_snapshot: data.yes_price_snapshot || null,
      no_price_snapshot: data.no_price_snapshot || null,
      yes_bid_snapshot: data.yes_bid_snapshot || null,
      yes_ask_snapshot: data.yes_ask_snapshot || null,
      no_bid_snapshot: data.no_bid_snapshot || null,
      no_ask_snapshot: data.no_ask_snapshot || null,

      window_elapsed_sec: data.window_elapsed_sec || null,
      window_remaining_sec: data.window_remaining_sec || null,

      // ===== SIGNAL_GENERATED =====
      signal_direction: data.signal_direction || null,
      z_score: data.z_score || null,
      z_threshold: data.z_threshold || null,
      edge_detected_pct: data.edge_detected_pct || null,
      move_pct: data.move_pct || null,
      btc_velocity: data.btc_velocity || null,
      volatility_60s: data.volatility_60s || null,

      // ===== SIGNAL_REJECTED =====
      rejection_reasons: data.rejection_reasons || null,

      // ===== ORDER_SENT =====
      order_intent: data.order_intent || null,
      order_price: data.order_price || null,
      order_size: data.order_size || null,
      order_side: data.order_side || null,

      // ===== FILL / NO_FILL =====
      fill_result: data.fill_result || null,
      filled_price: data.filled_price || null,
      filled_size: data.filled_size || null,
      fill_timestamp_ms: data.fill_timestamp_ms || null,
      fill_latency_ms: data.fill_latency_ms || null,

      // ===== RESOLUTION =====
      market_resolution: data.market_resolution || null,
      position_result: data.position_result || null,
      edge_at_entry_pct: data.edge_at_entry_pct || null,
      edge_at_resolution_pct: data.edge_at_resolution_pct || null,
    };

    fs.appendFileSync(BOT_EVENTS_FILE, JSON.stringify(record) + '\n');
  } catch (e) {
    console.error(`[PHASE2] Error logging bot event: ${e.message}`);
  }
}

// Contador de eventos para monitoreo
let eventCounts = {
  binanceRaw: 0,
  polymarketRaw: 0,
  botEvents: {}
};

function getStats() {
  return {
    binanceRaw: eventCounts.binanceRaw,
    polymarketRaw: eventCounts.polymarketRaw,
    botEvents: eventCounts.botEvents
  };
}

function resetStats() {
  eventCounts = {
    binanceRaw: 0,
    polymarketRaw: 0,
    botEvents: {}
  };
}

module.exports = {
  logBinanceRaw,
  logPolymarketRaw,
  logBotEvent,
  getStats,
  resetStats,
};
