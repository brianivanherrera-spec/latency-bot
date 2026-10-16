'use strict';
// Configuracion leida al momento de uso (permite cambiarla en tests).
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

function config() {
  return {
    DATA_DIR: process.env.DATA_DIR || './data',
    PORT: num('PORT', 3000),
    DOWNLOAD_SECRET: process.env.DOWNLOAD_SECRET || '',
    GAMMA_URL: process.env.GAMMA_URL || 'https://gamma-api.polymarket.com',
    CLOB_URL: process.env.CLOB_URL || 'https://clob.polymarket.com',
    MIN_DAYS: num('MIN_DAYS', 2),
    MAX_DAYS: num('MAX_DAYS', 60),
    MIN_LIQUIDITY: num('MIN_LIQUIDITY', 5000),
    MIN_PRICE: num('MIN_PRICE', 0.03),
    MAX_PRICE: num('MAX_PRICE', 0.97),
    MARKETS_PER_DAY: num('MARKETS_PER_DAY', 10),
    MAX_PER_EVENT_SELECT: num('MAX_PER_EVENT_SELECT', 2),
    REFORECAST_MOVE: num('REFORECAST_MOVE', 0.10),
    EDGE_MIN: num('EDGE_MIN', 0.08),
    STAKE_USD: num('STAKE_USD', 10),
    MIN_FILL_USD: num('MIN_FILL_USD', 2),
    MAX_PER_EVENT: num('MAX_PER_EVENT', 2),
    MAX_OPEN_USD: num('MAX_OPEN_USD', 100),
    SELECT_HOUR_UTC: num('SELECT_HOUR_UTC', 12),
    HTTP_TIMEOUT_MS: num('HTTP_TIMEOUT_MS', 15000),
    HTTP_RETRIES: num('HTTP_RETRIES', 3),
    RETRY_BASE_MS: num('RETRY_BASE_MS', 1000),
    BOOK_LEVELS: num('BOOK_LEVELS', 20),
  };
}
module.exports = { config };
