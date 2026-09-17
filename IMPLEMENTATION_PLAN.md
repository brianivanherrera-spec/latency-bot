# 🎯 PLAN DE IMPLEMENTACIÓN - 5 MEJORAS CRÍTICAS

**Base**: Análisis de 2,852 señales (Aug 19 – Sep 17 2026)
**Status**: 72.8% NO_FILL rate en Live vs 23.5% en Paper
**Objetivo**: Reducir NO_FILL rate y mejorar win rate

---

## 📋 MEJORA #1: Filtros de Señal

### Cambios Requeridos:

**1.1 Rechazar signalScore < 40**
- **Ubicación**: `src/index-final.js` línea ~1350 (después de generar signal)
- **Evidencia**: win_rate 68%, PnL negativo en live
- **Implementación**:
```javascript
if (sig.signalScore < 40) {
  logger.warn(`[SKIP] Signal score too low: ${sig.signalScore} < 40 threshold`);
  logMarketSignal(sig, `LOW_SCORE (${sig.signalScore})`);
  return;
}
```
- **Logging**: Phase 2 event `SIGNAL_REJECTED` con razón `LOW_SCORE`

**1.2 Rechazar UP + RSI 70-80**
- **Ubicación**: `src/index-final.js` línea ~1350 (mismo lugar)
- **Evidencia**: 0/2 wins, −$44 PnL
- **Implementación**:
```javascript
const isRSIOverbought = sig.direction === 'UP' && sig.rsi >= 70 && sig.rsi < 80;
if (isRSIOverbought) {
  logger.warn(`[SKIP] Overbought RSI: UP signal with RSI=${sig.rsi.toFixed(2)}`);
  logMarketSignal(sig, `OVERBOUGHT_RSI`);
  return;
}
```
- **Logging**: Phase 2 event `SIGNAL_REJECTED` con razón `OVERBOUGHT_RSI`

**1.3 Priorizar imbalance < 0.3**
- **Ubicación**: `src/index-final.js` línea ~1945 (donde se calcula `finalExposure`)
- **Evidencia**: 96% win rate vs 80% en imbalance alto
- **Implementación**:
```javascript
const strongImbalance = Math.abs(bookImb) < 0.3;
const sizeMult = strongImbalance ? 1.5 : 1.0;  // 50% larger size
const finalExposure = exposure * sizeMult;

if (strongImbalance) {
  logger.info(`[SIZE-UP] Strong imbalance ${bookImb.toFixed(3)}: sizing up 1.5x`);
}
```
- **Logging**: Phase 2 `ORDER_SENT` incluir `size_multiplier`

---

## 📍 MEJORA #2: NO_FILL Rate Logging

### Cambios Requeridos:

**2.1 Logging Detallado de Intento de Orden**
- **Ubicación**: `src/index-final.js` línea ~2050-2150 (donde se envía orden)
- **Implementación**: Nueva función `logOrderAttempt()`
```javascript
function logOrderAttempt(market, signal, orderPrice, size, side, tokenId) {
  const ts = Date.now();
  logger.info(`[ORDER-ATTEMPT] ${ts}ms | ${signal.direction} | price=$${orderPrice} size=${size} | market=${market.id}`);
  
  phase2Logger.logBotEvent('ORDER_ATTEMPT', {
    event_timestamp_ms: ts,
    market_id: market.id,
    signal_id: signal.id,
    signal_direction: signal.direction,
    signal_score: signal.signalScore,
    order_price: orderPrice,
    order_size: size,
    order_side: side,
    token_id: tokenId,
    btc_price_snapshot: btcPriceNow,
    yes_price_snapshot: market.yesPrice,
    no_price_snapshot: market.noPrice,
  });
}
```

**2.2 Capturar Respuesta de Polymarket**
- **Ubicación**: `src/index-final.js` línea ~2100-2150 (en el try/catch de sendOrder)
- **Implementación**: Log timestamps exactos
```javascript
const sendTs = Date.now();
const response = await poly.clobClient?.placeOrder(...);
const receivedTs = Date.now();
const latencyMs = receivedTs - sendTs;

phase2Logger.logBotEvent('ORDER_RESPONSE', {
  event_timestamp_ms: receivedTs,
  order_send_timestamp_ms: sendTs,
  order_latency_ms: latencyMs,
  order_id: response?.id,
  response_status: response?.status,
  fill_status: response?.fills?.length > 0 ? 'FILLED' : 'PARTIAL_OR_EMPTY',
  filled_size: response?.fills?.reduce((sum, f) => sum + f.size, 0) || 0,
});
```

**2.3 Razón de Rechazo en Catch**
- **Ubicación**: `src/index-final.js` línea ~2150-2200 (catch block)
- **Implementación**: Parse error message
```javascript
catch (e) {
  logger.error(`[ORDER-FAILED] ${e.message}`);
  
  const rejectReason = parseRejectReason(e.message);  // TBD: implement parser
  
  phase2Logger.logBotEvent('ORDER_REJECTED', {
    event_timestamp_ms: Date.now(),
    error_message: e.message,
    reject_reason: rejectReason,  // e.g., "INSUFFICIENT_LIQUIDITY", "INVALID_PRICE", etc.
    market_id: cachedMarket.id,
    order_price: orderPrice,
  });
}
```

---

## 🕐 MEJORA #3: Timestamp de Fuente en Polymarket

### Cambios Requeridos:

**3.1 Extraer timestamp de payload WebSocket**
- **Ubicación**: `src/polymarket-ws.js` línea ~150-200 (handler de mensaje)
- **Implementación**:
```javascript
_onMessage(data) {
  const receivedTs = Date.now();
  const payload = JSON.parse(data);
  
  // Extraer timestamp de fuente si existe
  const sourceTs = payload.timestamp || payload.ts || payload.event_time || null;
  const timestampQuality = sourceTs ? 'source' : 'received_only';
  const eventLatencyMs = sourceTs ? (receivedTs - sourceTs) : null;
  
  // Enriquecer payload con metadata de timestamp
  const enrichedPayload = {
    ...payload,
    _event_received_timestamp_ms: receivedTs,
    _event_source_timestamp_ms: sourceTs,
    _timestamp_quality: timestampQuality,
    _event_latency_ms: eventLatencyMs,
  };
  
  this._processMessage(enrichedPayload);
}
```

**3.2 Pasar timestamp al logging de eventos**
- **Ubicación**: `src/phase2-logger.js` función `logPolymarketRaw()`
- **Implementación**:
```javascript
function logPolymarketRaw(data, market, strikes) {
  const record = {
    // ... existing fields ...
    
    // Timestamps mejorados
    bot_received_timestamp_ms: data._event_received_timestamp_ms || Date.now(),
    event_source_timestamp_ms: data._event_source_timestamp_ms,
    timestamp_quality: data._timestamp_quality || 'received_only',
    event_latency_ms: data._event_latency_ms,
  };
  
  // ... rest of function
}
```

**3.3 Actualizar Phase2 diagnostics**
- **Ubicación**: `src/phase2-diagnostics.js`
- **Agregá**: Reporte de `timestamp_quality` distribution
```
[PHASE2-DIAG] Timestamp Quality:
  - source: 78% (events with precise timestamps)
  - received_only: 22% (events without source timestamp)
  - avg_event_latency_ms: 45ms
```

---

## 📊 MEJORA #4: Métricas Diarias en Logs

### Cambios Requeridos:

**5.1 Agregar función DAILY_SUMMARY**
- **Ubicación**: Nueva función en `src/phase2-logger.js` o en `src/index-final.js`
- **Implementación**:
```javascript
function logDailySummary(stats) {
  const record = {
    event_type: 'DAILY_SUMMARY',
    event_timestamp_ms: Date.now(),
    
    // Trades
    trades_executed: stats.tradesExecuted,
    trades_filled: stats.tradesFilled,
    trades_nofill: stats.tradesNoFill,
    
    // Win/Loss
    wins: stats.wins,
    losses: stats.losses,
    win_rate: stats.winRate,  // percentage 0-100
    
    // PnL
    pnl_neto: stats.pnlNeto,
    pnl_gross: stats.pnlGross,
    pnl_fees: stats.pnlFees,
    
    // Execution
    no_fill_count: stats.tradesNoFill,
    no_fill_rate: stats.noFillRate,  // percentage 0-100
    avg_fill_latency_ms: stats.avgFillLatencyMs,
  };
  
  phase2Logger.logBotEvent('DAILY_SUMMARY', record);
  logger.info(`[DAILY] Executed=${stats.tradesExecuted} Wins=${stats.wins} WinRate=${(stats.winRate*100).toFixed(2)}% PnL=$${stats.pnlNeto.toFixed(2)}`);
}
```

**5.2 Llamar al cierre del día**
- **Ubicación**: `src/index-final.js` (agregar timer al inicio)
- **Implementación**:
```javascript
const scheduleDailySummary = () => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  
  const msUntilMidnight = tomorrow - now;
  
  setTimeout(() => {
    const stats = compileSessionStats();
    logDailySummary(stats);
    scheduleDailySummary();  // Schedule next day
  }, msUntilMidnight);
};

scheduleDailySummary();
```

**5.3 Función compileSessionStats()**
- **Ubicación**: Mismo archivo
- **Implementación**:
```javascript
function compileSessionStats() {
  const closedPositions = Array.from(closedPositionsLog.values());
  const executed = closedPositions.filter(p => p.fill_result !== 'NO_FILL');
  const filled = executed.filter(p => p.pnl > 0 || p.pnl === 0);
  const noFill = closedPositions.filter(p => p.fill_result === 'NO_FILL');
  
  return {
    tradesExecuted: closedPositions.length,
    tradesFilled: filled.length,
    tradesNoFill: noFill.length,
    wins: filled.filter(p => p.pnl > 0).length,
    losses: filled.filter(p => p.pnl < 0).length,
    winRate: filled.length > 0 ? 
      filled.filter(p => p.pnl > 0).length / filled.length : 0,
    pnlNeto: closedPositions.reduce((sum, p) => sum + p.pnl, 0),
    pnlGross: closedPositions.reduce((sum, p) => sum + Math.abs(p.pnl), 0),
    pnlFees: closedPositions.reduce((sum, p) => sum + (p.fees || 0), 0),
    noFillRate: closedPositions.length > 0 ? 
      noFill.length / closedPositions.length : 0,
    avgFillLatencyMs: executed.length > 0 ?
      executed.reduce((sum, p) => sum + (p.fill_latency_ms || 0), 0) / executed.length : 0,
  };
}
```

---

## 📁 VOLUMEN BORRADO

**Ubicación**: ¿Dónde estaba el volumen? (proporcionar ruta/contexto)
**Acción**: 
1. Buscar en git history si está en commits viejos
2. Recuperar del .gitignore o backup si existe
3. Recrear si es derivado (estadísticas diarias, etc.)

---

## 🚀 ORDEN DE IMPLEMENTACIÓN

**Fase 1 (2-3 horas)**: Mejoras #1 + #2
- Filtros de señal (quick win)
- Logging detallado NO_FILL

**Fase 2 (1-2 horas)**: Mejora #3
- Timestamp de fuente WebSocket

**Fase 3 (1-2 horas)**: Mejora #4
- Daily summary

**Fase 4 (0.5 horas)**: Recuperar volumen

---

## ✅ CRITERIOS DE ÉXITO

- [ ] NO_FILL rate reducido a < 40% en live (vs 72.8% actual)
- [ ] Win rate mejorado a > 85% (vs 68-80% actual)
- [ ] Timestamp quality: > 80% con `source` timestamps
- [ ] DAILY_SUMMARY logs presentes en phase2 eventos

---

**Status**: Listo para implementación
**Next**: Confirmar ubicación del volumen borrado
