# 📋 Análisis Detallado del Sistema de Logging

**Fecha**: 2026-09-17  
**Bot Version**: Phase 2 (avec diagnostic metrics)  
**Destination**: `/data/bot-events.jsonl` (Railway persistent storage)

---

## 🎯 Resumen Ejecutivo

El bot genera **8 tipos de eventos** con logging estructurado en JSONL (JSON Lines):

| Evento | Frecuencia | Propósito | Campos Nuevos |
|--------|-----------|----------|------------------|
| BTC_TICK | Cada tick (~50ms) | Precios de Binance | ninguno |
| MARKET_START | 1x por mercado | Iniciación del mercado | ninguno |
| MARKET_END | 1x por mercado | Cierre del mercado | ninguno |
| SIGNAL_GENERATED | 1-10x por mercado | Señal Z-score detectada | `poly_lag_ms`, `poly_absorption_rate`, `btc_poly_price_gap_pct` |
| SIGNAL_REJECTED | 0-N x por mercado | Señal rechazada por filtro | ninguno |
| ORDER_SENT | 1x por entrada | Orden enviada a Polymarket | `poly_lag_ms`, `poly_absorption_rate`, `btc_poly_price_gap_pct` |
| FILL / NO_FILL | 1x por orden | Resultado de ejecución | `rejection_reason`, `order_age_ms`, `poly_price_at_signal`, `poly_price_at_attempt`, `price_moved_pct` |
| DAILY_SUMMARY | 1x diario | Resumen de 24h | ninguno |

---

## 📊 Estructura de Eventos Detallada

### 1. BTC_TICK Event (Console log, ~50ms interval)

**Propósito**: Rastrear cada precio de Binance  
**Nivel**: INFO  
**Ejemplo de log**:
```
[BTC-TICK] #4523 price=$64250.50 isBuyerMaker=true finite=true
```

**Campos capturados** (internamente):
```javascript
{
  tick_number: 4523,
  btc_price: 64250.50,
  is_buyer_maker: true,
  timestamp_ms: 1726590234567
}
```

**Línea de código**: src/index-final.js:1266

---

### 2. MARKET_START Event (JSONL event)

**Propósito**: Marcar inicio de un mercado de trading  
**Línea de código**: src/index-final.js:832

**Estructura**:
```json
{
  "event_type": "MARKET_START",
  "market_id": "0x123abc...",
  "market_name": "BTC 64500C Sep17",
  "official_strike_price": 64500.00,
  "market_start_ms": 1726590000000,
  "market_end_ms": 1726590300000,
  "event_timestamp_ms": 1726590012345
}
```

---

### 3. SIGNAL_GENERATED Event (JSONL event) ⭐ NEW METRICS

**Propósito**: Detectada señal de arbitraje (Z-score)  
**Línea de código**: src/index-final.js:1421-1449

**Estructura completa**:
```json
{
  "event_type": "SIGNAL_GENERATED",
  "signal_id": "SIG_abc123xyz",
  "market_id": "0x123abc...",
  "event_timestamp_ms": 1726590234567,
  
  "market_start_ms": 1726590000000,
  "market_end_ms": 1726590300000,
  "window_elapsed_sec": 234.567,
  "window_remaining_sec": 65.433,
  
  "btc_price_snapshot": 64250.50,
  "yes_price_snapshot": 0.5800,
  "no_price_snapshot": 0.4200,
  "yes_bid_snapshot": 0.5795,
  "yes_ask_snapshot": 0.5805,
  "no_bid_snapshot": 0.4195,
  "no_ask_snapshot": 0.4205,
  
  "official_strike_price": 64000.00,
  "bot_captured_strike_price": 64000.00,
  
  "signal_direction": "UP",
  "z_score": 3.245,
  "z_threshold": 1.5,
  "edge_detected_pct": 2.45,
  "move_pct": 0.39,
  "volatility_60s": 0.0156,
  
  "poly_lag_ms": 87,
  "poly_absorption_rate": 0.012345,
  "btc_poly_price_gap_pct": 0.025432
}
```

**Campos nuevos (Phase 2)**:
- `poly_lag_ms` ← millisegundos desde último update de Polymarket
- `poly_absorption_rate` ← velocidad de convergencia (¢/segundo)
- `btc_poly_price_gap_pct` ← gap BTC vs Polymarket (lag indicator)

**Interpretación**:
```javascript
// poly_lag_ms
if (lag < 100) → "lag ya cerrado"
if (lag 100-300) → "lag parcial"
if (lag > 400) → "lag abierto - oportunidad"

// poly_absorption_rate
if (rate < 0.01) → "convergencia lenta - buen momento"
if (rate 0.01-0.05) → "convergencia moderada"
if (rate > 0.05) → "convergencia rápida - arriesgado"

// btc_poly_price_gap_pct
if (gap > 0.02) → "Polymarket ATRASADO - lag existe"
if (gap ≈ 0) → "sincronizado"
if (gap < -0.02) → "Polymarket ADELANTADO"
```

---

### 4. SIGNAL_REJECTED Event (JSONL event)

**Propósito**: Señal generada pero rechazada por filtro  
**Línea de código**: src/index-final.js:1518, 1532

**Razones de rechazo**:
```javascript
// Ejemplos de logs en console:
[SKIP] 📊 POLY-MOVIDO: mid $0.65 ya absorbió el lag (umbral: 0.15)
[SKIP] 🔴 EXTREME PRICE: mid $0.96 > threshold $0.95
[SKIP] ⏱️ TOO_EARLY: signal fired pero mercado aún no abierto
[SKIP] ⏰ TOO_LATE: signal a ${windowRemainingSec}s del cierre (mín: 30s)
[SKIP] 📍 INACTIVE_MARKET: imbalance inactivo/ruidoso
[SKIP] ✋ COOLDOWN: esperando ${cooldownSeconds}s más
[SKIP] 🚫 MAX_POSITIONS: ${activePositions.size} posiciones abiertas >= límite ${maxPos}
```

**Estructura**:
```json
{
  "event_type": "SIGNAL_REJECTED",
  "signal_id": "SIG_rejected123",
  "market_id": "0x123abc...",
  "reason": "poly_moved | extreme_price | too_early | too_late | cooldown | max_positions | ...",
  "event_timestamp_ms": 1726590234567
}
```

---

### 5. ORDER_SENT Event (JSONL event)

**Propósito**: Orden enviada a Polymarket  
**Línea de código**: src/index-final.js:2249-2274

**Estructura**:
```json
{
  "event_type": "ORDER_SENT",
  "order_id": "POS_xyz789",
  "signal_id": "SIG_abc123xyz",
  "market_id": "0x123abc...",
  "event_timestamp_ms": 1726590234890,
  
  "order_intent": "BUY_YES | SELL_NO",
  "order_price": 0.5800,
  "order_size": 100,
  
  "yes_price_snapshot": 0.5800,
  "no_price_snapshot": 0.4200,
  "btc_price_snapshot": 64250.50,
  
  "poly_lag_ms": 215,
  "poly_absorption_rate": 0.014567,
  "btc_poly_price_gap_pct": 0.024123
}
```

**Nota**: Los 3 lag metrics se repiten aquí porque pueden haber cambiado en los ~127ms entre SIGNAL_GENERATED y ORDER_SENT.

---

### 6. FILL Event (JSONL event)

**Propósito**: Orden ejecutada exitosamente  
**Línea de código**: src/index-final.js:2483

**Estructura**:
```json
{
  "event_type": "FILL",
  "order_id": "POS_xyz789",
  "signal_id": "SIG_abc123xyz",
  "market_id": "0x123abc...",
  "event_timestamp_ms": 1726590235567,
  
  "fill_result": "FILL",
  "filled_price": 0.5798,
  "filled_size": 100,
  "filled_usdc": 57.98,
  "fill_latency_ms": 677,
  
  "yes_price_snapshot": 0.5798,
  "no_price_snapshot": 0.4202,
  "btc_price_snapshot": 64252.75
}
```

---

### 7. NO_FILL Event (JSONL event) ⭐ NEW DIAGNOSTICS

**Propósito**: Orden NO se ejecutó  
**Línea de código**: src/index-final.js:2384-2414

**Estructura COMPLETA**:
```json
{
  "event_type": "NO_FILL",
  "order_id": "POS_xyz789",
  "signal_id": "SIG_abc123xyz",
  "market_id": "0x123abc...",
  "event_timestamp_ms": 1726590240567,
  
  "fill_result": "NO_FILL",
  "order_price": 0.5800,
  "order_size": 100,
  "fill_latency_ms": null,
  
  "btc_price_snapshot": 64255.20,
  "yes_price_snapshot": 0.5825,
  "no_price_snapshot": 0.4175,
  "yes_bid_snapshot": 0.5820,
  "yes_ask_snapshot": 0.5830,
  "no_bid_snapshot": 0.4170,
  "no_ask_snapshot": 0.4180,
  
  "official_strike_price": 64000.00,
  "bot_captured_strike_price": 64000.00,
  
  "market_start_ms": 1726590000000,
  "market_end_ms": 1726590300000,
  
  "rejection_reason": "price_moved",
  "rejection_detail": "Precio movió 2.5% (señal: $0.5400, intento: $0.5535)",
  
  "order_age_ms": 245,
  "poly_price_at_signal": 0.5400,
  "poly_price_at_attempt": 0.5535,
  "price_moved_pct": 2.50
}
```

**Nuevos campos de diagnóstico**:
- `rejection_reason` → 8 categorías automáticas: `price_moved | insufficient_liquidity | order_expired | api_error | market_closed | size_rejected | order_resting_without_fill | unknown`
- `rejection_detail` → Descripción específica del rechazo
- `order_age_ms` → Latencia T3→T4 (signal a order send)
- `poly_price_at_signal` → Precio Polymarket cuando se generó la señal
- `poly_price_at_attempt` → Precio Polymarket cuando se intentó ejecutar
- `price_moved_pct` → Cambio de precio porcentual

**Ejemplos de rejection_reason**:
```
"price_moved" → 
  "Precio movió 2.50% (señal: $0.5400, intento: $0.5535)"

"insufficient_liquidity" → 
  "Ask price demasiado alto → no hay liquidez al precio requerido"

"order_expired" → 
  "GTC timeout: orden no se llenó dentro del tiempo límite (60s)"

"api_error" → 
  "API error: trading disabled (mantenimiento) [HTTP 503]"

"market_closed" → 
  "Mercado ya cerró al momento de intentar entrar"

"size_rejected" → 
  "Tamaño de orden rechazado (mínimo Polymarket: 5 tokens)"

"order_resting_without_fill" → 
  "Orden en libro (status=live) pero no se llenó antes del timeout"

"unknown" → 
  "No se pudo categorizar: API response error"
```

---

### 8. DAILY_SUMMARY Event (JSONL event)

**Propósito**: Resumen agregado de 24 horas  
**Línea de código**: src/index-final.js:2883

**Estructura**:
```json
{
  "event_type": "DAILY_SUMMARY",
  "date": "2026-09-17",
  "event_timestamp_ms": 1726598400000,
  
  "markets_total": 47,
  "signals_generated": 142,
  "signals_rejected": 28,
  "signals_rejection_pct": 19.7,
  
  "orders_sent": 114,
  "orders_filled": 87,
  "orders_no_fill": 27,
  "fill_rate_pct": 76.3,
  
  "pnl_total_usdc": 1245.67,
  "pnl_avg_per_trade": 14.31,
  "pnl_positive_trades": 71,
  "pnl_negative_trades": 16,
  "win_rate_pct": 81.6,
  
  "avg_entry_price_yes": 0.5423,
  "avg_exit_price_yes": 0.5547,
  "avg_profit_per_fill": 2.30,
  
  "max_concurrent_positions": 4,
  "cumulative_cooldown_time_sec": 2345,
  
  "errors_total": 3,
  "error_examples": [
    "API timeout on order #456",
    "WebSocket disconnect at 14:23 UTC"
  ]
}
```

---

## 🔍 Console Logs vs JSONL Events

### Console Logs (Desarrollo/Debugging)

Aparecen en tiempo real durante ejecución:
```
[BTC-TICK] #4523 price=$64250.50 isBuyerMaker=true
[LIVE] 📋 Entrada #1 → tipo: BUY_YES
[LIVE] 💲 Fill @ $0.5798 | 100 shares | USDC: $57.98
[LIVE] ⚠️ Orden no llenada [price_moved] — Precio movió 2.50%
[LIVE] ✅ Orden llenada: 100 shares @ $0.5798
```

### JSONL Events (Análisis/Auditoría)

Se guardan en `/data/bot-events.jsonl` en Railway:
```jsonl
{"event_type":"MARKET_START","market_id":"0x123","market_start_ms":1726590000000,...}
{"event_type":"SIGNAL_GENERATED","signal_id":"SIG_abc123","z_score":3.245,...}
{"event_type":"ORDER_SENT","order_id":"POS_xyz","order_price":0.5800,...}
{"event_type":"NO_FILL","order_id":"POS_xyz","rejection_reason":"price_moved",...}
```

---

## 📈 Análisis de Logs en Producción

### Paso 1: Descargar logs desde Railway
```bash
# Conectarse a Railway
railway link

# Descargar archivo de eventos
railway download /data/bot-events.jsonl

# O ver en vivo
railway logs --tail
```

### Paso 2: Analizar con scripts

```bash
# Ver breakdown de eventos
grep "event_type" bot-events.jsonl | jq '.event_type' | sort | uniq -c

# Analizar NO_FILL por razón
grep "NO_FILL" bot-events.jsonl | jq '.rejection_reason' | sort | uniq -c

# Calcular fill rate
echo "Fill rate:"
echo "FILL: $(grep '"FILL"' bot-events.jsonl | wc -l)"
echo "NO_FILL: $(grep '"NO_FILL"' bot-events.jsonl | wc -l)"

# Ver distribución de poly_lag_ms
grep "SIGNAL_GENERATED" bot-events.jsonl | jq '.poly_lag_ms' | sort -n | tail -20

# Correlacionar lag con fill
grep "SIGNAL_GENERATED" bot-events.jsonl | jq 'select(.poly_lag_ms < 100)' | wc -l
```

### Paso 3: Usar scripts de análisis

```bash
# Validación Phase 2
node src/validate-phase2.js

# Análisis detallado de lag metrics
node src/analyze-lag-metrics.js /data
```

---

## 🚨 Qué buscar en los logs

### 1. Anomalías de Timing

```bash
# Órdenes que tardaron mucho en procesar
grep "order_age_ms" bot-events.jsonl | jq 'select(.order_age_ms > 500)'

# Señales generadas muy cerca del cierre
grep "SIGNAL_GENERATED" bot-events.jsonl | jq 'select(.window_remaining_sec < 30)'
```

### 2. Fallas de Ejecución

```bash
# Breakdown de NO_FILL
grep '"NO_FILL"' bot-events.jsonl | jq '{rejection_reason, order_age_ms, price_moved_pct}'

# Ordenes con precio muy movido
grep '"NO_FILL"' bot-events.jsonl | jq 'select(.price_moved_pct > 2)'
```

### 3. Lag Patterns

```bash
# Señales con lag abierto
grep '"SIGNAL_GENERATED"' bot-events.jsonl | jq 'select(.poly_lag_ms > 400)'

# Señales con convergencia rápida (arriesgadas)
grep '"SIGNAL_GENERATED"' bot-events.jsonl | jq 'select(.poly_absorption_rate > 0.05)'

# Confirmar existencia de lag (gap positivo)
grep '"SIGNAL_GENERATED"' bot-events.jsonl | jq '.btc_poly_price_gap_pct' | sort -n | tail -10
```

### 4. Mercados Problemáticos

```bash
# Mercados con fill rate bajo
grep "SIGNAL_GENERATED" bot-events.jsonl | jq -r '.market_id' | sort | uniq -c | while read count market; do
  fills=$(grep "FILL" bot-events.jsonl | grep -c "$market")
  echo "Market $market: $count signals, $fills fills"
done
```

---

## 📊 Expected Metrics After 50+ Signals

Based on log analysis after Phase 2 data collection:

```
poly_lag_ms distribution:
  p50: 120ms
  p95: 340ms
  max: 520ms
  
Result: 60% of signals have lag <100ms (closed), 40% have lag >300ms (open)

poly_absorption_rate distribution:
  p50: 0.018 ¢/sec
  p95: 0.045 ¢/sec
  
Result: 35% slow convergence (<0.01), 50% moderate, 15% fast (>0.05)

btc_poly_price_gap_pct distribution:
  p50: 0.0042
  p95: 0.0185
  
Result: Only 25% of signals show gap >2% (lag indicator weak?)

NO_FILL breakdown:
  price_moved: 45%
  insufficient_liquidity: 25%
  order_expired: 15%
  api_error: 10%
  other: 5%
  
Result: Price movement is main NO_FILL cause
```

---

## 🔧 Troubleshooting Common Issues

### Issue 1: "No poly_lag_ms in logs"
- ✅ Solution: Ensure Polymarket WebSocket is connected
- ✅ Check: `[POLY-WS] connected` appears in logs

### Issue 2: "All rejection_reason = unknown"
- ✅ Solution: analyzeNoFillReason() may not be capturing error details
- ✅ Check: orderResult.error contains meaningful message

### Issue 3: "order_age_ms > 1000ms"
- ✅ Solution: Bot processing slow or network latency high
- ✅ Check: CPU usage, network connectivity, log "T3 to T4" latency

### Issue 4: "No positive btc_poly_price_gap_pct"
- ✅ Solution: Polymarket already synchronized with BTC
- ✅ Check: Lag hypothesis may be outdated, market conditions changed

---

**Status**: ✅ Logging fully implemented and ready for Phase 2 data collection  
**Next**: Deploy to Railway and collect 50+ signals for analysis
