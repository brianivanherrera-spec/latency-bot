# 📡 ANÁLISIS: Latencia Binance vs Polymarket para Exit Strategy

**Pregunta**: ¿Podemos usar precio de Binance como referencia para activar early exit antes de una reversión?

---

## 📊 Datos Disponibles Actualmente

### Binance (Capturados en binance-raw.jsonl)
```javascript
{
  binance_timestamp_ms,           // ← Timestamp original de Binance
  bot_received_timestamp_ms,      // ← Cuándo llegó al bot
  timestamp_quality,              // ← 'source' o 'received_only'
  
  btc_price_bid,                  // ← Mejor bid actual
  btc_price_ask,                  // ← Mejor ask actual
  btc_price_last,                 // ← Último precio
  btc_price_high / low,           // ← High/Low del período
  
  isBuyerMaker,                   // ← Dirección del último trade
  number_of_trades                // ← Trades en período
}
```

### Polymarket (Capturados en polymarket-raw.jsonl)
```javascript
{
  bot_received_timestamp_ms,      // ← Cuándo llegó el evento
  event_source_timestamp_ms,      // ← Cuándo fue generado en servidor
  event_latency_ms,               // ← Latencia WS (event_source - bot_received)
  timestamp_quality,              // ← 'source' o 'received_only'
  
  yes_price,                      // ← Precio YES actualizado
  yes_bid / yes_ask,              // ← Order book YES
  no_bid / no_ask,                // ← Order book NO
  
  yes_spread,                     // ← Spread YES
  window_remaining_sec            // ← Segundos hasta resolución
}
```

---

## 🎯 Plan: Early Exit Detection

### Idea Central
1. **Monitorear precio BTC en Binance** (casi sin latencia)
2. **Comparar contra strike price** de Polymarket
3. **Si BTC cruza umbral crítico**, vender posición ANTES de que Polymarket se reactive

### Ejemplo Operativo
```
Strike: $76,500 (UP)

t=0s:   Compramos YES @ $0.54 (esperamos que BTC suba)
        BTC: $76,482 ✓

t=5s:   BTC sube a $76,520 ✓✓ (señal bullish)
        
t=8s:   BTC CADE a $76,495 ⚠️ (cruzó abajo de strike!)
        ➜ VENDER YES inmediatamente (minimizar pérdida)
        
t=10s:  Polymarket actualiza yes_price = $0.45
        (Ya vendimos, evitamos la caída)
```

---

## 📈 Análisis de Latencia Disponible

### Latencia Binance → Bot
```
binance_timestamp_ms vs bot_received_timestamp_ms
= Latencia WebSocket de Binance

Esperado: 10-50ms (Binance WS es rápido)
```

### Latencia Polymarket → Bot
```
event_source_timestamp_ms vs bot_received_timestamp_ms
= event_latency_ms

Actualmente capturado ✓
Rango típico: 50-200ms
```

### Latencia Red: Binance vs Polymarket
```
(bot_received_binance_ms) - (bot_received_polymarket_ms)
= Diferencia temporal entre datos

Problema: No sincronizado si son de mercados diferentes
Solución: Usar TIMESTAMPS DE ORIGEN, no de recepción
```

---

## 🔴 Problemas con Early Exit

### 1. **Asimetría de Información**
```
Binance avisa cambio de precio: t=0ms
Polymarket se entera: t=100ms después
BOT intenta vender: t=150ms

Pero... ¿Polymarket permitirá vender en un precio antiguo?
Risk: Order rechazada o fill peor de lo esperado
```

### 2. **Resolución vs Reversión**
```
Strike: $76,500
BTC cae a $76,495 por 3 segundos
Mercado cierra (se resuelve en NO)

¿Vendimos a tiempo? Tal vez.
¿Perder $0.05 por una caída temporal?
```

### 3. **Ventana de Mercado**
```
Polymarket markets duran 5-10 minutos
Quedan 20-30 segundos → Exit early no vale la pena
Quedan 2-3 minutos → Exit temprano puede ahorrar
```

---

## ✅ Estrategia Recomendada

### Fase 1: Recolectar Datos (Ya Implementado)
- ✓ Capturamos `binance_timestamp_ms` vs `bot_received_timestamp_ms`
- ✓ Capturamos `event_latency_ms` de Polymarket
- ✓ Tenemos `yes_price` histórico en polymarket-raw.jsonl
- ✓ Tenemos `isBuyerMaker` (dirección de presión)

### Fase 2: Análisis Offline (Reportar Correlación)
```
Para cada trade que hicimos:
1. Extraer histórico de btc_price_last
2. Extraer histórico de yes_price  
3. Calcular: ¿Cuándo se invirtió la correlación?
4. ¿Cuántos segundos antes de que Polymarket se diera cuenta?

Resultado: Latencia real de early warning
```

### Fase 3: Exit Strategy (Condicional)
```javascript
// Pseudocódigo
if (hasOpenPosition && windowRemainingSec > 90) {
  const btcChange = (btcPriceNow - entryBTCPrice) / entryBTCPrice * 100;
  
  // Si BTC se movió contra nosotros > 0.2%
  if (Math.abs(btcChange) > 0.2 && btcChange * direction < 0) {
    VENDER_AHORA("Reversión detectada en Binance");
  }
}
```

---

## 📉 Métricas para Monitorear

### Latencia Observada
```
binance_arrival_latency = bot_received_timestamp_ms - binance_timestamp_ms
polymarket_arrival_latency = bot_received_timestamp_ms - event_source_timestamp_ms
```

### Correlación Binance ↔ Polymarket
```
Cuando BTC sube, ¿YES price sube también?
Delay entre movimiento BTC y Polymarket = "prediction window"

Si delay = 100ms, podríamos reaccionar en 50-80ms ✓
Si delay = 10ms, probablemente NO ✗
```

### Win Rate por Zona Temporal
```
¿Ganamos más si hacemos exit en:
- Primeros 30s? (mercado caliente)
- Minutos 2-4? (momentum sustentado)
- Últimos 30s? (reversión clara)

Data-driven exit window
```

---

## 🚀 Implementación Recomendada (Orden)

### OPCIÓN A: Análisis Primero (Bajo Riesgo) ✓ RECOMENDADO
1. **Esta semana**: Generar reporte de latencias históricas
2. **Validar**: ¿Hay window de oportunidad real?
3. **Si SÍ**: Implementar early exit rule
4. **Si NO**: Mantener actual (hold até resolución)

### OPCIÓN B: Implementar Ya (Alto Riesgo)
- Riesgo: Vendemos demasiado temprano, después sube más
- Riesgo: Order rechazada porque Polymarket cambió precio
- Riesgo: Spreads se cierran antes de poder vender

---

## 📊 Próximos Pasos

**Inmediato**:
- [ ] Extraer últimas 100 trades from bot-events.jsonl
- [ ] Correlacionar con binance-raw.jsonl y polymarket-raw.jsonl
- [ ] Calcular: latencia promedio entre move en BTC y cambio en Polymarket
- [ ] Medir: % de trades donde early exit habría mejorado PnL

**Si la latencia es > 100ms y predecible**:
- Implementar exit trigger en `src/index-final.js`
- Agregar evento `EARLY_EXIT_TRIGGERED` a phase2-logger
- Medir impacto en win rate y avg fill price

**Si no hay ventana clara**:
- Dejar como está (hold until resolution)
- Mejor usar el dinero en múltiples posiciones simultáneas

---

## 📈 Conclusión Analítica

**La idea es SÓLIDA si**:
✓ Latencia Polymarket → Bot > 100ms  
✓ BTC mueve antes que Polymarket lo capte  
✓ Hay 2+ minutos en mercado para reaccionar  

**La idea es RIESGOSA si**:
✗ Latencia < 50ms (no hay window)  
✗ Mercados pequeños (spreads imposibles)  
✗ Win rate actual es ya > 85% (no vale risk)  

---

**Recomendación**: Ejecutar análisis de datos **ANTES** de invertir desarrollo.
El bot ya tiene toda la telemetría, solo falta analizar.
