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

  // =============================================
  // PARÁMETROS DE SEÑAL MATEMÁTICA
  // =============================================

  // Ventana de ticks para calcular estadísticas
  // aggTrade Binance: ~10-50 ticks/segundo → 300 ticks ≈ 10-30 segundos
  SIGNAL_WINDOW: parseInt(process.env.SIGNAL_WINDOW || '300'),

  // Mínimo de ticks antes de generar señales (acumulación inicial)
  MIN_TICKS_REQUIRED: parseInt(process.env.MIN_TICKS_REQUIRED || '100'),

  // Z-score mínimo para considerar movimiento significativo
  // 1.5 = movimiento moderado, 2.0 = fuerte, 2.5 = muy fuerte
  ZSCORE_THRESHOLD: parseFloat(process.env.ZSCORE_THRESHOLD || '1.2'),

  // Movimiento mínimo en % dentro de la ventana corta
  MOVE_PCT_THRESHOLD: parseFloat(process.env.MOVE_PCT_THRESHOLD || '0.03'),

  // Velocidad mínima del movimiento (%/segundo)
  MIN_VELOCITY: parseFloat(process.env.MIN_VELOCITY || '0.001'),

  // =============================================
  // GESTIÓN DE RIESGO
  // =============================================

  // USDC por orden (en modo live)
  ORDER_SIZE_USDC: parseFloat(process.env.ORDER_SIZE_USDC || '5'),

  // Segundos de cooldown entre órdenes
  COOLDOWN_SECONDS: parseInt(process.env.COOLDOWN_SECONDS || '120'),

  // Máximo de órdenes activas simultáneas
  MAX_ACTIVE_ORDERS: parseInt(process.env.MAX_ACTIVE_ORDERS || '3'),

  // =============================================
  // LOGGING
  // =============================================
  LOG_LEVEL: process.env.LOG_LEVEL || 'info', // debug | info | warn | error
  LOG_FILE: process.env.LOG_FILE || './logs/bot.log',
};
