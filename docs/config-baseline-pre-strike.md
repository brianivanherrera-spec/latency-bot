# Configuración baseline pre-implementación strike price
## Fecha: 2026-09-09
## Contexto: 96W/4L = 96% WR en paper | $30 → $439 en una sesión

## Variables Railway activas
DUAL_FILL_ORDER=true | LATE_ENTRY_MODE=false | ELITE_MODE=false
BOOK_FILTER_MIN_IMBALANCE=0.30 | MOVE_PCT_THRESHOLD=0.02
ZSCORE_THRESHOLD=1.5 | SENSITIVITY=41 | BTC_TICK_INTERVAL_MS=500
ORDER_SIZE_USDC=5 | MAX_ACTIVE_POSITIONS=10 | COOLDOWN_SECONDS=0

## Lo que NO teníamos
- Strike price del mercado
- Monitoreo segundo a segundo del precio durante el trade

## Resultados
- 96W/4L = 96% WR | +$409 en paper

## Pendiente de analizar (NO implementar aún)
1. Strike price → impacto en WR
2. Monitoreo precio/segundo → correlación BTC vs Poly
3. Cruce de trades con strike histórico
