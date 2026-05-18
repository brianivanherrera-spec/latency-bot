/**
 * Configuración central del bot
 * Todas las variables sensibles vienen de process.env
 * En Railway: Settings → Variables
 */

module.exports = {
  // =============================================
  // MODO OPERACIÓN
  // =============================================
  // DRY_RUN=true  → paper trading, no gasta dinero real
  // DRY_RUN=false → live trading con fondos reales
  DRY_RUN: process.env.DRY_RUN !== 'false', // default: true (seguro)

  // =============================================
  // POLYMARKET CREDENCIALES
  // (solo necesarias si DRY_RUN=false)
  // =============================================
  POLY_PRIVATE_KEY: process.env.POLY_PRIVATE_KEY || '',
  POLY_API_KEY: process.env.POLY_API_KEY || '',
  POLY_API_SECRET: process.env.POLY_API_SECRET || '',
  POLY_PASSPHRASE: process.env.POLY_PASSPHRASE || '',

  // Funder address = proxy wallet (para cuentas Rabby/MetaMask legacy)
  POLY_FUNDER_ADDRESS: process.env.POLY_FUNDER_ADDRESS || '',

  // Deposit wallet address (para nuevas cuentas email/Google)
  // Se puede dejar vacío y el bot lo deriva automáticamente
  POLY_DEPOSIT_WALLET: process.env.POLY_DEPOSIT_WALLET || '',

  // Relayer API Key (de Polymarket Settings → API Keys del Relayer)
  POLY_RELAYER_API_KEY: process.env.POLY_RELAYER_API_KEY || '',
  POLY_RELAYER_API_KEY_ADDRESS: process.env.POLY_RELAYER_API_KEY_ADDRESS || '',

  // =============================================
  // PARÁMETROS DE SEÑAL MATEMÁTICA
  // =============================================

  // Ventana de ticks para calcular estadísticas
  SIGNAL_WINDOW: parseInt(process.env.SIGNAL_WINDOW || '300'),

  // Mínimo de ticks antes de generar señales
  MIN_TICKS_REQUIRED: parseInt(process.env.MIN_TICKS_REQUIRED || '100'),

  // Z-score mínimo — los que funcionaban con 63.9% win rate
  ZSCORE_THRESHOLD: parseFloat(process.env.ZSCORE_THRESHOLD || '1.5'),

  // Movimiento mínimo en %
  MOVE_PCT_THRESHOLD: parseFloat(process.env.MOVE_PCT_THRESHOLD || '0.04'),

  // Velocidad mínima del movimiento (%/segundo)
  MIN_VELOCITY: parseFloat(process.env.MIN_VELOCITY || '0.001'),

  // =============================================
  // GESTIÓN DE RIESGO
  // =============================================

  // USDC por orden (en modo live)
  ORDER_SIZE_USDC: parseFloat(process.env.ORDER_SIZE_USDC || '5'),

  // Límites de posiciones y capital
  MAX_POSITIONS: parseInt(process.env.MAX_POSITIONS || '10'),
  MAX_TOTAL_EXPOSURE_USDC: parseFloat(process.env.MAX_TOTAL_EXPOSURE_USDC || '100'),
  MAX_POSITION_SIZE_USDC: parseFloat(process.env.MAX_POSITION_SIZE_USDC || '20'),
  STOP_LOSS_PERCENT: parseFloat(process.env.STOP_LOSS_PERCENT || '10'),

  // Cooldown entre órdenes
  COOLDOWN_SECONDS: parseInt(process.env.COOLDOWN_SECONDS || '360'),

  // =============================================
  // LATENCIA Y FRESHNESS DE DATOS
  // =============================================

  // Máxima antigüedad del precio de Polymarket (ms)
  MAX_PRICE_AGE_MS: parseInt(process.env.MAX_PRICE_AGE_MS || '3000'),

  // Sensibilidad: puntos de probabilidad por 0.1% de BTC
  POLY_SENSITIVITY: parseFloat(process.env.POLY_SENSITIVITY || '2.5'),

  // Edge mínimo para operar (%)
  MIN_EDGE_PCT: parseFloat(process.env.MIN_EDGE_PCT || '0.8'),

  // Edge máximo realista — mayor indica precio stale
  MAX_REALISTIC_EDGE: parseFloat(process.env.MAX_REALISTIC_EDGE || '15'),

  // =============================================
  // LOGGING
  // =============================================
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FILE: process.env.LOG_FILE || './logs/bot.log',
};
// =============================================
// TAKE PROFIT
