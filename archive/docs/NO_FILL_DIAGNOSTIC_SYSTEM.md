# 📊 Sistema de Diagnóstico NO_FILL Mejorado

**Fecha**: 2026-09-17  
**Propósito**: Identificar razones específicas del 72.8% de NO_FILL rate en live trading  
**Status**: ✅ Implementado

---

## 🎯 Problema Resuelto

Antes: El bot loggueba `NO_FILL` pero con `rejection_reasons: null` → **imposible diagnosticar por qué no se ejecutan las órdenes**

Después: Sistema de categorización automática de 7 razones específicas de rechazo + 2 campos de timing/precios

---

## 📋 Categorías de Rechazo (7 tipos)

### 1. **price_moved** 
- **Qué significa**: El precio de Polymarket cambió significativamente entre que se generó la señal y que se intentó ejecutar
- **Threshold**: > 2% de movimiento
- **Indicador**: `price_moved_pct` en logs
- **Ejemplo en logs**: 
  ```
  rejection_reason: "price_moved"
  price_moved_pct: 2.5
  poly_price_at_signal: 0.5400
  poly_price_at_attempt: 0.5535
  ```

### 2. **insufficient_liquidity**
- **Qué significa**: No hay suficiente liquidez al precio requerido
- **Casos**:
  - Ask price demasiado alto (`ask_too_high`)
  - FAK agotó reintentos (`fak_exhausted`)
- **Indicador**: Libro de órdenes sin profundidad al precio
- **Ejemplo**: `rejection_reason: "insufficient_liquidity"`

### 3. **order_expired**
- **Qué significa**: La orden no se llenó dentro del tiempo límite (timeout GTC)
- **Timeout por defecto**: 60 segundos (configurable con `GTC_TIMEOUT_SECONDS`)
- **Indicador**: Order en libro pero sin fill cuando vence el timeout
- **Ejemplo**: `rejection_reason: "order_expired"`

### 4. **api_error**
- **Qué significa**: Error devuelto por la API de Polymarket
- **Casos comunes**:
  - `trading_disabled` (mantenimiento: HTTP 503)
  - Saldo insuficiente (`not enough balance`)
  - Allowance insuficiente
  - Errores generales de API
- **Indicador**: `error_code` en logs (ej. 503)
- **Ejemplo**:
  ```
  rejection_reason: "api_error"
  detail: "API error: trading disabled (mantenimiento)"
  error_code: 503
  ```

### 5. **market_closed**
- **Qué significa**: El mercado ya cerró al momento de intentar entrar
- **Indicador**: Timestamp del mercado vs timestamp del intento
- **Ejemplo**: `rejection_reason: "market_closed"`

### 6. **size_rejected**
- **Qué significa**: El tamaño de la orden fue rechazado (ej. menor que mínimo Polymarket)
- **Mínimo Polymarket**: 5 tokens
- **Ejemplo**: `rejection_reason: "size_rejected"`

### 7. **order_resting_without_fill** (variante de `order_expired`)
- **Qué significa**: Orden en libro (`status=live`) pero no se llenó antes del timeout
- **Diferencia con `order_expired`**: orden no venció por timeout, sino que fue rechazada en estado live
- **Ejemplo**: `rejection_reason: "order_resting_without_fill"`

### 8. **unknown**
- **Qué significa**: No se pudo categorizar (cualquier otro error)
- **Acción**: Incluir `raw_error` en logs para análisis manual
- **Ejemplo**:
  ```
  rejection_reason: "unknown"
  raw_error: "Unexpected response from API"
  ```

---

## 🕐 Campos Nuevos en Eventos NO_FILL

### 1. **order_age_ms**
- **Descripción**: Milisegundos entre que se generó la señal (T3) y que se envió la orden (T4)
- **Fórmula**: `order_age_ms = T4 - T3`
- **Rango normal**: 50-500ms (en live trading, con latencia de red)
- **Qué significa**:
  - `order_age_ms < 100ms`: orden enviada muy rápido
  - `order_age_ms > 500ms`: hubo retraso en procesamiento
- **Uso**: Identificar si llegamos tarde porque tardó el bot en procesar, no por Polymarket

### 2. **poly_price_at_attempt**
- **Descripción**: Precio YES/NO de Polymarket en el exacto momento de intentar ejecutar
- **Captura**: Del snapshot de WebSocket más reciente al moment del ORDER_SENT
- **Comparar con**: `poly_price_at_signal` (precio cuando se generó la señal)
- **Cálculo disponible**: `price_moved_pct = |attempt - signal| / signal * 100`

### 3. **poly_price_at_signal**
- **Descripción**: Precio YES/NO de Polymarket cuando se generó la señal
- **Captura**: De `sig.getPolyPrice()` o `sig._initialPolyPrice`
- **Usa**: Para calcular `price_moved_pct`

### 4. **rejection_reason** (categorizado)
- **Tipo**: Enum de 8 valores
- **Valores**: `price_moved | insufficient_liquidity | order_expired | api_error | market_closed | size_rejected | order_resting_without_fill | unknown`

### 5. **rejection_detail**
- **Descripción**: Mensaje descriptivo con contexto específico
- **Ejemplo**: `"Ask price demasiado alto → no hay liquidez al precio requerido"`

---

## 📊 Dónde Ver los Nuevos Datos

### Archivo: `/data/bot-events.jsonl` (Phase 2 Logging)

Cada evento NO_FILL ahora incluye:

```json
{
  "event_type": "NO_FILL",
  "order_id": "POS_abc123",
  "signal_id": "SIG_xyz789",
  "market_id": "0x123...",
  "fill_result": "NO_FILL",
  "order_price": 0.54,
  "order_size": 50,
  
  "rejection_reason": "price_moved",
  "rejection_detail": "Precio movió 2.5% (señal: $0.5400, intento: $0.5535)",
  
  "order_age_ms": 245,
  "poly_price_at_signal": 0.5400,
  "poly_price_at_attempt": 0.5535,
  "price_moved_pct": 2.50,
  
  "yes_price_snapshot": 0.5535,
  "no_price_snapshot": 0.4465,
  "yes_bid_snapshot": 0.5500,
  "yes_ask_snapshot": 0.5535,
  
  "event_timestamp_ms": 1726590234567,
  "btc_price_snapshot": 64250.50,
  "official_strike_price": 64000,
  
  "market_start_ms": 1726590000000,
  "market_end_ms": 1726590300000
}
```

### Archivo: `/data/fills.jsonl` (Detailed Fill Telemetry)

Cada NO_FILL en fills.jsonl también captura:

```json
{
  "posId": "POS_abc123",
  "timestamp": 1726590234567,
  "fill_result": "NO_FILL",
  "order_status": "live",
  "order_price": 0.54,
  "best_ask": 0.5535,
  
  "rejection_reason": "Precio movió 2.5% (señal: $0.5400, intento: $0.5535)",
  "time_to_fill_ms": null,
  
  "order_size": 50,
  "size_filled": 0,
  
  "signal_direction": "UP",
  
  "latencies": {
    "t3_price_decision_ms": 1726590234100,
    "t4_order_sent_ms": 1726590234345,
    "t5_order_accepted_ms": 1726590234380,
    "t6_order_resting_ms": 1726590234380,
    "t7_order_filled_ms": null,
    
    "t3_to_t4_ms": 245,
    "t4_to_t5_ms": 35,
    "t5_to_t6_ms": 0,
    "t6_to_t7_ms": null
  }
}
```

---

## 🔍 Cómo Diagnosticar el 72.8% NO_FILL

### Paso 1: Obtener el último fichero de eventos

```bash
# Railway
railway download /data/bot-events.jsonl

# O localmente en desarrollo
cat /data/bot-events.jsonl | grep NO_FILL | head -20
```

### Paso 2: Analizar distribución de razones

```bash
# Ver breakdown por tipo de rechazo
grep NO_FILL /data/bot-events.jsonl | jq '.rejection_reason' | sort | uniq -c

# Ejemplo de salida esperada:
#  145 "price_moved"
#  312 "insufficient_liquidity"
#   89 "order_expired"
#   52 "api_error"
#   18 "market_closed"
#    4 "unknown"
```

### Paso 3: Investigar por razón

**Si la mayoría son `price_moved`:**
- Problema: El precio de Polymarket se mueve antes de que llegue la orden
- Solución: Analizar `order_age_ms` para ver si es latencia del bot o del mercado
- Acción: Revisar velocidad de procesamiento de señales

**Si la mayoría son `insufficient_liquidity`:**
- Problema: No hay profundidad de libro al precio requerido
- Solución: Ver `poly_price_at_attempt` vs `poly_price_at_signal`
- Acción: Implementar libro más profundo o precios más flexibles

**Si hay `api_error` con código 503:**
- Problema: Polymarket en mantenimiento
- Solución: Agrega retry logic con backoff
- Acción: Esperar y reintentar

**Si predominan `order_expired`:**
- Problema: GTC timeout (orden no se llena en 60s)
- Solución: Aumentar timeout o usar mejor imbalance
- Acción: Cambiar `GTC_TIMEOUT_SECONDS` o mejorar señales

---

## 📈 Métricas Derivadas

Con estos datos ahora puedes calcular:

```javascript
// NO_FILL por razón (%)
const noFillByReason = {};
events
  .filter(e => e.event_type === 'NO_FILL')
  .forEach(e => {
    const reason = e.rejection_reason || 'unknown';
    noFillByReason[reason] = (noFillByReason[reason] || 0) + 1;
  });

// Orden age promedio para NO_FILL
const avgOrderAge = events
  .filter(e => e.event_type === 'NO_FILL' && e.order_age_ms != null)
  .reduce((sum, e) => sum + e.order_age_ms, 0) / count;

// % de órdenes donde precio se movió > 1%
const priceMoveHigh = events
  .filter(e => e.event_type === 'NO_FILL' && (e.price_moved_pct || 0) > 1)
  .length / total * 100;
```

---

## 🛠️ Variables de Configuración

No hay nuevas variables de configuración. El sistema funciona automáticamente capturando:

- **Thresholds fijos**:
  - `priceMovedThreshold = 0.02` (2%) → configurable en `analyzeNoFillReason()`
  - `GTC_TIMEOUT_SECONDS = 60` (env var existente)

---

## ✅ Cambios Implementados

### Archivos Modificados

1. **src/signal-logger.js**
   - ✅ Función `analyzeNoFillReason()` para categorizar rechazos
   - ✅ Análisis basado en: error code, status, precio, mercado
   - ✅ Exporta función para uso en index-final.js

2. **src/index-final.js** (3 secciones)
   - ✅ Línea ~2270-2290: Captura de NO_FILL en live trading
     - Calcula `order_age_ms`
     - Captura `poly_price_at_signal` y `poly_price_at_attempt`
     - Usa `analyzeNoFillReason()` para categorización
   - ✅ Línea ~2330-2360: Event NO_FILL en Phase 2 Logger
     - Agrega `rejection_reason`, `rejection_detail`
     - Agrega `order_age_ms`, `poly_price_at_signal`, `poly_price_at_attempt`, `price_moved_pct`
   - ✅ Línea ~2505-2565: Captura de NO_FILL por exception/error
   - ✅ Línea ~2576-2604: Captura de NO_FILL en paper mode (simulado)

---

## 🚀 Próximos Pasos

### Corto Plazo (24-48 horas)
1. Deployer cambios al bot en Railway
2. Recolectar datos de varios trades
3. Ejecutar análisis de distribución de razones
4. Generar reporte de `NO_FILL breakdown by reason`

### Mediano Plazo (análisis de datos)
1. Medir latencia promedio de `order_age_ms` por tipo de mercado
2. Identificar si es bot slow (> 200ms) o market movement
3. Correlacionar `price_moved_pct` con Z-score de señal
4. Medir `insufficient_liquidity` vs imbalance strength

### Largo Plazo (optimizaciones)
1. Si `price_moved` es mayoría → optimizar velocidad de procesamiento
2. Si `insufficient_liquidity` es mayoría → mejorar order book strategy
3. Si `order_expired` es mayoría → ajustar tolerancia de precio
4. Si `api_error` es significativo → agregar retry logic

---

## 📝 Logs Esperados

Con esta implementación, verás logs como:

```
[LIVE] ⚠️ Orden no llenada [price_moved] — Precio movió 2.50% (señal: $0.5400, intento: $0.5535)
[LIVE] ⚠️ Orden no llenada [insufficient_liquidity] — Ask price demasiado alto → no hay liquidez al precio requerido
[LIVE] ⚠️ Orden no llenada [order_expired] — GTC timeout: orden no se llenó dentro del tiempo límite
[LIVE] ⚠️ Orden no llenada [api_error] — API error: trading disabled (mantenimiento)
```

---

## ✨ Beneficios

✅ **Visibilidad**: De 620 NO_FILL eventos → categoría específica de rechazo  
✅ **Diagnóstico**: Root cause analysis automatizado  
✅ **Actionable**: Cada categoría sugiere solución diferente  
✅ **Tracking**: Métricas de timing (`order_age_ms`) para optimizar latencia  
✅ **Scalable**: Sistema extensible para agregar más categorías si es necesario

---

**Generado**: 2026-09-17  
**Branch**: `claude/code-analysis-pqoez0`

