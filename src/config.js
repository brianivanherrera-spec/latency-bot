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
  // FILTROS DE HORARIO
  // =============================================
  TRADING_HOURS_ENABLED: process.env.TRADING_HOURS_ENABLED !== 'false',

  // Horas UTC bloqueadas — calibradas con datos reales de signals.jsonl
  // Horas doradas: 3,4,5,8,12,13,14 | Malas: todo lo demás listado abajo
  // UTC 06 bloqueado: 58% WR + dispara CB en cascada bloqueando UTC 07-08
  TRADING_HOURS_BLOCKED_UTC: (process.env.TRADING_HOURS_BLOCKED_UTC || '0,1,2,6,9,10,11,16,17,18,19,20,22,23')
    .split(',').map(Number),

  // =============================================
  // FILTROS DE SEÑAL ADICIONALES
  // =============================================

  // Imbalance máximo permitido — datos reales: imb>0.3 tiene 42% WR
  IMBALANCE_MAX: parseFloat(process.env.IMBALANCE_MAX || '0.3'),

  // Fill rate simulado en paper — 0.75 = 75% de órdenes se llenan (refleja GTC real)
  PAPER_FILL_RATE: parseFloat(process.env.PAPER_FILL_RATE || '0.75'),

  // Buffer mínimo de ticks antes de operar (warmup)
  // 100 ticks @ 56 ticks/10s = ~18s warmup vs 35s con 200 ticks
  MIN_BUFFER_SIZE: parseInt(process.env.MIN_BUFFER_SIZE || '100'),

  // LATE_ENTRY_MODE — modo experimental: espera confirmación de dirección
  // en vez de anticiparse. Solo entra tarde en el período con precio ya definido.
  LATE_ENTRY_MODE: process.env.LATE_ENTRY_MODE === 'true',
  // DUAL_ENTRY_MODE: permite operar los 2 filtros a la par —
  // primera entrada con lógica normal (temprana) + segunda entrada
  // en el mismo mercado solo si se confirma LATE_ENTRY después.
  DUAL_ENTRY_MODE: process.env.DUAL_ENTRY_MODE === 'true',
  // MARKET_RETRY: si el intento MARKET (FOK) falla por falta de liquidez,
  // reintenta automáticamente como GTC — mejora el fill rate sin sacrificar
  // la velocidad del primer intento.
  MARKET_RETRY: process.env.MARKET_RETRY === 'true',
  // Cuántos intentos rápidos de MARKET (FOK) hacer antes de caer a GTC
  MARKET_RETRY_ATTEMPTS: parseInt(process.env.MARKET_RETRY_ATTEMPTS || '3'),
  MAX_ACTIVE_POSITIONS: parseInt(process.env.MAX_ACTIVE_POSITIONS || '1'),
  MAX_SECONDS_REMAINING: parseInt(process.env.MAX_SECONDS_REMAINING || '150'),
  LATE_ENTRY_MAX_PRICE: parseFloat(process.env.LATE_ENTRY_MAX_PRICE || '0.30'),

  // Tolerancia de precio — acepta fills hasta N por encima del precio detectado
  // 0.02 = 2 ticks → sube fill rate de ~74% a ~90% con mínimo impacto en edge
  PRICE_TOLERANCE: parseFloat(process.env.PRICE_TOLERANCE || '0.02'),

  // Tipo de orden: GTC (límite con timeout) o MARKET (fill inmediato)
  // GTC: más selectivo, fill rate 30-75% pero protege contra tendencias
  // MARKET: fill 100% garantizado, WR real sin filtro de liquidez
  ORDER_TYPE: process.env.ORDER_TYPE || 'GTC',

  // Filtro de tendencia BTC: si BTC se movió más de N USD en 1 hora
  // bloquea señales contra la tendencia (0 = desactivado)
  BTC_TREND_FILTER: parseInt(process.env.BTC_TREND_FILTER || '0'),

  // Segundos mínimos restantes en el mercado para entrar (60 = más ventana que 90)
  MIN_SECONDS_REMAINING: parseInt(process.env.MIN_SECONDS_REMAINING || '60'),

  // GTC timeout — segundos que espera fill antes de cancelar la orden
  GTC_TIMEOUT_SECONDS: parseInt(process.env.GTC_TIMEOUT_SECONDS || '60'),

  // Signal Score mínimo y máximo — calibrado con 652 trades reales
  // Score 90-99 tiene solo 53% WR (señales en momentos extremos de BTC)
  MIN_SIGNAL_SCORE: parseInt(process.env.MIN_SIGNAL_SCORE || '60'),
  MAX_SIGNAL_SCORE: parseInt(process.env.MAX_SIGNAL_SCORE || '89'),

  // =============================================
  // LOGGING
  // =============================================
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FILE: process.env.LOG_FILE || './logs/bot.log',
};
// =============================================
// TAKE PROFIT
