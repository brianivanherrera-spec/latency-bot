'use strict';
// Toda la configuración en un solo lugar. Todo se puede cambiar por variable de entorno (prefijo V2_).
const num = (k, d) => { const v = process.env[k]; return v === undefined || v === '' ? d : Number(v); };
const bool = (k, d) => { const v = process.env[k]; return v === undefined || v === '' ? d : v === 'true'; };

module.exports = {
  PORT: num('PORT', 8080),
  DATA_DIR: process.env.DATA_DIR || './data',
  SECRET: process.env.DOWNLOAD_SECRET || 'latency2026',

  // Mercado
  WINDOW_MS: 300000,                                  // mercados de 5 minutos
  SLUG_PREFIX: process.env.V2_SLUG_PREFIX || 'btc-updown-5m-',
  PREFETCH_MS: num('V2_PREFETCH_MS', 90000),           // buscar el mercado siguiente 90 s antes
  BOOK_CONNECT_BEFORE_MS: num('V2_BOOK_CONNECT_BEFORE_MS', 10000),

  // Modelo de probabilidad (regla real: TWAP 60 s de Chainlink al cierre >= al de la apertura)
  TWAP_WINDOW_S: 60,
  VOL_WINDOW_S: num('V2_VOL_WINDOW_S', 900),           // volatilidad de los últimos 15 min de Binance
  VOL_RET_S: num('V2_VOL_RET_S', 5),                   // retornos de 5 s (1 s tiene ruido de bid/ask)
  VOL_MULT: num('V2_VOL_MULT', 1.4),                   // el bot actual calibró ×1.4 con 207 aperturas
  VOL_MIN_HISTORY_S: num('V2_VOL_MIN_HISTORY_S', 120), // historia mínima de Binance para medir volatilidad
  CL_LAG_MS: num('V2_CL_LAG_MS', 500),                 // Chainlink va ~500 ms detrás de Binance
  BASIS_ALPHA: num('V2_BASIS_ALPHA', 0.03),            // EWMA de (Chainlink − Binance) por punto (~1/s)
  NOWCAST_SD: num('V2_NOWCAST_SD', 3.5),               // error típico de proyectar Chainlink con Binance (USD)

  // Datos frescos (si no, no opera)
  STALE_BINANCE_MS: num('V2_STALE_BINANCE_MS', 2000),
  STALE_CHAINLINK_MS: num('V2_STALE_CHAINLINK_MS', 6000),
  STALE_BOOK_MS: num('V2_STALE_BOOK_MS', 30000),        // sin ningún mensaje del libro en 30 s → no confiar

  // Decisión
  EDGE_MIN: num('V2_EDGE_MIN', 0.03),                   // ventaja mínima POR ACCIÓN, ya descontada la comisión
  FEE_RATE_DEFAULT: num('V2_FEE_RATE', 0.07),           // comisión cripto: rate × p × (1 − p) por acción
  MIN_SECS_LEFT: num('V2_MIN_SECS_LEFT', 8),
  MAX_SECS_LEFT: num('V2_MAX_SECS_LEFT', 298),
  ENTRY_COOLDOWN_MS: num('V2_ENTRY_COOLDOWN_MS', 3000),
  MAX_ENTRIES_PER_MARKET: num('V2_MAX_ENTRIES_PER_MARKET', 3),
  EVAL_INTERVAL_MS: num('V2_EVAL_INTERVAL_MS', 250),

  // Tamaño y riesgo (paper)
  PAPER_BANKROLL: num('V2_PAPER_BANKROLL', 100),
  KELLY_FRACTION: num('V2_KELLY_FRACTION', 0.25),       // un cuarto de Kelly
  MAX_STAKE_USD: num('V2_MAX_STAKE_USD', 10),
  MAX_MARKET_EXPOSURE_USD: num('V2_MAX_MARKET_EXPOSURE_USD', 20),
  MAX_TOTAL_EXPOSURE_USD: num('V2_MAX_TOTAL_EXPOSURE_USD', 50),
  DAILY_LOSS_LIMIT_USD: num('V2_DAILY_LOSS_LIMIT_USD', 30),
  MIN_ORDER_SHARES_DEFAULT: num('V2_MIN_ORDER_SHARES', 5),

  // Salida anticipada: vender si el mercado paga por lo que tenemos más de lo que vale
  EXIT_ENABLED: bool('V2_EXIT_ENABLED', true),
  EXIT_EDGE: num('V2_EXIT_EDGE', 0.03),

  // Simulación de ejecución
  SIM_LATENCY_MS: num('V2_SIM_LATENCY_MS', 300),       // decisión → la orden llega al libro

  // Resolución
  RESOLVE_POLL_MS: num('V2_RESOLVE_POLL_MS', 15000),
  RESOLVE_TIMEOUT_MS: num('V2_RESOLVE_TIMEOUT_MS', 15 * 60000),

  // Endpoints
  GAMMA: process.env.V2_GAMMA || 'https://gamma-api.polymarket.com',
  POLY_WS: process.env.V2_POLY_WS || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  RTDS_WS: process.env.V2_RTDS_WS || 'wss://ws-live-data.polymarket.com',
  BINANCE_WS: process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade',
  COINBASE_WS: process.env.V2_COINBASE_WS || 'wss://advanced-trade-ws.coinbase.com',
};
