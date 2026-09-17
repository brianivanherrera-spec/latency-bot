# 📊 Polymarket Lag Detection System

**Fecha**: 2026-09-17  
**Propósito**: Medir si el lag de Polymarket (400ms median) todavía existe al momento de generar una señal  
**Status**: ✅ Implementado (medición solamente, sin filtros)

---

## 🎯 Problema

El edge del bot es que Polymarket tarda ~400ms en absorber movimientos de BTC que ya ocurrieron en Binance.

**Pregunta crítica**: ¿Cuando generamos una señal, todavía existe ese lag o ya se cerró?

Si el lag ya se cerró (Polymarket ya se actualizó), nuestra señal está generada "tarde" y el edge desaparece.

---

## 📡 Tres Métricas de Medición

### Métrica 1: `poly_lag_ms`

**Qué mide**: Cuántos milisegundos hace que Polymarket NO actualizó su precio

**Fórmula**:
```
poly_lag_ms = now_ms - last_poly_update_ms
```

**Interpretación**:
- `poly_lag_ms < 100ms` → Polymarket acaba de actualizar → **lag CERRADO**
- `poly_lag_ms 100-300ms` → Polymarket se actualizó hace poco → **lag PARCIAL**
- `poly_lag_ms > 400ms` → Polymarket llevaría un tiempo sin actualizar → **lag ABIERTO** (pero poco probable en trades activos)

**Ejemplo**:
```json
{
  "poly_lag_ms": 87,
  "interpretation": "Polymarket actualizó hace 87ms — gap ya se cerró"
}
```

**Uso para calibración**:
- Si la mayoría de señales tienen `poly_lag_ms < 50ms` → el bot está llegando tarde, hay que acelerar
- Si hay mezcla de <100ms y >300ms → hay períodos de oportunidad y períodos de cierre

---

### Métrica 2: `poly_absorption_rate`

**Qué mide**: Cuán rápido se está moviendo el precio de Polymarket (centavos por segundo)

**Fórmula**:
```
last_poly_price = price in last update (5 ticks ago)
first_poly_price = price 5 ticks ago
elapsed_sec = time between first and last update
poly_absorption_rate = |last - first| / elapsed_sec
```

**Interpretación**:
- `poly_absorption_rate < 0.01` → Precio quieto → **lag todavía explotable**
- `poly_absorption_rate 0.01-0.05` → Precio convergiendo → **edge MEDIO**
- `poly_absorption_rate > 0.05` → Precio convergiendo activamente → **edge CERRÁNDOSE**

**Ejemplo**:
```json
{
  "poly_absorption_rate": 0.012,
  "interpretation": "Polymarket sube 1.2¢ por segundo"
}
```

**Uso para calibración**:
- Si rate es alta en señales de entrada → el mercado está activo, mejor esperar
- Si rate es baja → es buen momento para entrar (menos competencia)

---

### Métrica 3: `btc_poly_price_gap_pct`

**Qué mide**: La diferencia entre lo que "debería" valer el token de Polymarket según BTC vs lo que vale en realidad

**Fórmula**:
```
btc_strike = price strike del mercado (ej. 64,000)
btc_current = precio BTC ahora (ej. 64,250)
btc_move_pct = (btc_current - btc_strike) / btc_strike

poly_current = precio YES (si signal=UP) o NO (si signal=DOWN)

btc_poly_gap_pct = btc_move_pct - poly_current
```

**Interpretación**:
- `btc_poly_gap_pct > 0.02` (> 2%) → **Polymarket ATRASADO** (lag real existe, hay edge)
- `btc_poly_gap_pct ≈ 0` → Polymarket sincronizado con BTC
- `btc_poly_gap_pct < -0.02` → Polymarket ADELANTADO (ya se movió más que BTC)

**Ejemplo**:
```json
{
  "btc_strike": 64000,
  "btc_current": 64250,
  "btc_move_pct": 0.0391,
  "poly_yes_price": 0.58,
  "btc_poly_gap_pct": -0.0009,
  "interpretation": "Polymarket adelantado: BTC subió 3.91% pero YES sube menos de lo que debería"
}
```

**Uso para calibración**:
- Gap positivo grande → **confirma lag real**, edge existe
- Gap cercano a 0 → Polymarket ya lo absorbió, edge cerrado
- Gap negativo → Polymarket se adelantó (sobrecompensó)

---

## 📍 Dónde Se Captura

### Durante SIGNAL_GENERATED

Cuando el bot detecta una señal Z-score, calcula y logguea:

```json
{
  "event_type": "SIGNAL_GENERATED",
  "signal_id": "SIG_abc123",
  "event_timestamp_ms": 1726590234567,
  
  "btc_price_snapshot": 64250.50,
  "yes_price_snapshot": 0.58,
  
  "poly_lag_ms": 87,
  "poly_absorption_rate": 0.012,
  "btc_poly_price_gap_pct": -0.0009,
  
  "z_score": 3.2,
  "edge_detected_pct": 2.5,
  "volatility_60s": 0.015
}
```

### Durante ORDER_SENT

Cuando se envía la orden, se repiten las métricas (el lag puede haber cambiado en los milisegundos entre signal y order):

```json
{
  "event_type": "ORDER_SENT",
  "order_id": "POS_xyz789",
  "signal_id": "SIG_abc123",
  "event_timestamp_ms": 1726590234890,
  
  "poly_lag_ms": 215,
  "poly_absorption_rate": 0.014,
  "btc_poly_price_gap_pct": -0.0015
}
```

---

## 🔍 Cómo Analizar los Datos

### Paso 1: Extraer métricas de eventos

```bash
# Ver últimas 20 señales con sus lag metrics
grep SIGNAL_GENERATED /data/bot-events.jsonl | tail -20 | jq '.{signal_id, poly_lag_ms, poly_absorption_rate, btc_poly_price_gap_pct}'
```

**Ejemplo de salida**:
```json
{
  "signal_id": "SIG_001",
  "poly_lag_ms": 42,
  "poly_absorption_rate": 0.008,
  "btc_poly_price_gap_pct": 0.045
}
{
  "signal_id": "SIG_002",
  "poly_lag_ms": 187,
  "poly_absorption_rate": 0.021,
  "btc_poly_price_gap_pct": 0.012
}
{
  "signal_id": "SIG_003",
  "poly_lag_ms": 523,
  "poly_absorption_rate": 0.035,
  "btc_poly_price_gap_pct": -0.018
}
```

### Paso 2: Calcular estadísticas

```bash
# Lag promedio
grep SIGNAL_GENERATED /data/bot-events.jsonl | jq '.poly_lag_ms' | awk '{s+=$1; c++} END {print "Avg lag:", s/c, "ms"}'

# % de señales con lag < 100ms (gap cerrado)
grep SIGNAL_GENERATED /data/bot-events.jsonl | jq 'select(.poly_lag_ms < 100)' | wc -l

# Correlación: lag vs fill rate
# (señales con lag alto ¿llenan más o menos?)
```

### Paso 3: Identificar patrones

**Pregunta**: ¿Cuándo tenemos mejor edge?

```bash
# Filtrar: señales donde hay gap positivo alto (> 2%)
grep SIGNAL_GENERATED /data/bot-events.jsonl | jq 'select(.btc_poly_price_gap_pct > 0.02)' | wc -l

# Filtrar: señales donde absorption rate es baja (< 0.01)
grep SIGNAL_GENERATED /data/bot-events.jsonl | jq 'select(.poly_absorption_rate < 0.01)' | wc -l
```

---

## 📊 Umbrales Propuestos para Filtrado (Siguiente Fase)

Con estos datos, la próxima fase será agregar filtros condicionales:

```javascript
// PROPUESTO (NO IMPLEMENTADO YÚN):

const POLY_LAG_MIN_MS = 50; // Solo si Poly no actualizó hace >50ms
const POLY_ABSORPTION_MAX = 0.03; // Solo si velocidad < 3¢/seg
const BTC_POLY_GAP_MIN = 0.01; // Solo si gap > 1%

if (sig._poly_lag_ms < POLY_LAG_MIN_MS) {
  logger.warn('[SKIP] lag ya cerrado');
  return;
}
if (sig._poly_absorption_rate > POLY_ABSORPTION_MAX) {
  logger.warn('[SKIP] Poly convergiendo muy rápido');
  return;
}
if (sig._btc_poly_price_gap_pct < BTC_POLY_GAP_MIN) {
  logger.warn('[SKIP] Poly ya absorbió el move de BTC');
  return;
}

// → ENTRAR
```

**IMPORTANTE**: Los umbrales exactos deben calibrarse con datos reales. Esta es solo la estructura.

---

## 🔧 Implementación Técnica

### Archivos Modificados

**src/index-final.js**:

1. **Línea ~936**: Agregó tracking de timestamps de Polymarket
   - `lastPolyUpdateMs`: timestamp del último update
   - `polyPriceHistory[]`: buffer circular de últimos 5 precios con timestamps

2. **Línea ~1351**: Cálculo de las 3 métricas cuando se genera señal
   - `poly_lag_ms`: diferencia de timestamps
   - `poly_absorption_rate`: cambio de precio / tiempo
   - `btc_poly_price_gap_pct`: BTC move % - token price

3. **Línea ~1421**: Agregó campos al evento `SIGNAL_GENERATED`
   - Nuevo: `poly_lag_ms`, `poly_absorption_rate`, `btc_poly_price_gap_pct`

4. **Línea ~2249**: Agregó campos al evento `ORDER_SENT`
   - Mismo set de 3 métricas (para context de timing)

### Overhead Computacional

- **Muy bajo**: Cálculos simples (3 divisiones + 1 resta)
- **Memoria**: Buffer circular de 5 precios ~150 bytes
- **Latencia**: < 1ms adicional por signal

---

## 🚀 Próximos Pasos

### Fase 1: Recolectar datos (ACTUAL)
✅ Capturar 3 métricas sin filtrar
✅ Loguear en eventos SIGNAL_GENERATED y ORDER_SENT

### Fase 2: Análisis (Pendiente)
- [ ] Ejecutar 50-100 trades vivos
- [ ] Extraer métricas de `bot-events.jsonl`
- [ ] Calcular p50, p95, min, max de cada métrica
- [ ] Correlacionar con fill rate y PnL

### Fase 3: Filtrado (Condicional)
- [ ] Si gap positivo existe → agregar filtro `btc_poly_gap_min`
- [ ] Si lag cierre es correlación con NO_FILL → agregar filtro `poly_lag_ms`
- [ ] Si absorption rate es predictor → agregar filtro `poly_absorption_max`

### Fase 4: Optimización (Opcional)
- [ ] Dinamizar umbrales por tipo de mercado
- [ ] Ajustar posición size según lag metrics
- [ ] Usar para timing de exits

---

## 📝 Ejemplo de Logs

```
[BTC-TICK] #4523 price=$64250.50 isBuyerMaker=true

[Z-SCORE] Signal detected: direction=UP, zscore=3.2

SIGNAL_GENERATED: {
  signal_id: "SIG_xyz789"
  z_score: 3.2
  edge_detected_pct: 2.5
  
  btc_price_snapshot: 64250.50
  yes_price_snapshot: 0.58
  
  poly_lag_ms: 87,              ← Polymarket actualizó hace 87ms
  poly_absorption_rate: 0.012,  ← Subiendo 1.2¢/seg
  btc_poly_price_gap_pct: -0.0009  ← Polymarket adelantado (gap negativo)
}

[LIVE] 💲 Entry decision: BUY YES @ $0.58

ORDER_SENT: {
  order_id: "POS_abc123"
  poly_lag_ms: 215,  ← Pasaron 128ms → lag creció
  poly_absorption_rate: 0.014,
  btc_poly_price_gap_pct: -0.0015
}
```

---

**Generado**: 2026-09-17  
**Branch**: `claude/code-analysis-pqoez0`  
**Estado**: Medición activa, sin filtros aplicados
