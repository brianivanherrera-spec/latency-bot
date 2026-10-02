# CHANGELOG - Latency Bot

## [2.1.0] - 2026-05-16

### 🔧 Fixes Críticos

#### Fix #1: Edge Calculation Realista
**Problema**: Edges de 100-135% (imposibles en Polymarket)

**Causa raíz**:
- El cálculo usaba precio base 0.50 como referencia
- Cuando Polymarket ya había movido significativamente (ej. YES=0.215), el bot calculaba:
  ```
  fairYes = 0.50 + adjustment = 0.60
  edge = (0.60 - 0.215) / 0.215 * 100 = 179% ❌
  ```

**Solución implementada** (`signal.js` líneas 146-224):
- Ajuste INCREMENTAL desde el precio actual de Polymarket
- Nueva fórmula:
  ```javascript
  if (direction === 'UP') {
    fairYes = Math.min(0.90, this.polyYesPrice + adjustment);
  } else {
    fairYes = Math.max(0.10, this.polyYesPrice - adjustment);
  }
  ```
- Edge ahora refleja solo el movimiento reciente, no el movimiento total

**Resultado esperado**: Edges realistas de 2-10%

---

#### Fix #2: Buffer de Tiempo del Mercado
**Problema**: Trades rechazados con mensaje "Mercado YA CERRADO hace 193s"

**Causa raíz**:
- Buffer de 60 segundos era insuficiente
- Delay entre detección de señal y ejecución causaba expiración

**Solución implementada** (`index-final.js` línea 124):
```javascript
if (segsRestantes < 120) { // antes: 60
  logger.warn(`[SKIP] ⏱️ Solo ${segsRestantes}s restantes — muy tarde (mínimo 120s)`);
  return;
}
```

**Resultado esperado**: Menos rechazos por tiempo insuficiente

---

#### Fix #3: Parámetros de Configuración
**Problema**: Baja conversión de señales a trades (0.44%)

**Cambios implementados** (`config.js`):

| Parámetro | Antes | Ahora | Razón |
|-----------|-------|-------|-------|
| `ZSCORE_THRESHOLD` | 1.2 | 1.5 | Reducir señales débiles |
| `MOVE_PCT_THRESHOLD` | 0.03% | 0.04% | Filtrado más estricto |
| `POLY_SENSITIVITY` | 2.5 | 5.0 | Mejor captura de movimientos |
| `MIN_EDGE_PCT` | 3% | 2.5% | Mayor conversión sin sacrificar calidad |
| `MAX_PRICE_AGE_MS` | 3000ms | 5000ms | Reducir rechazos por staleness |

**Resultado esperado**: Conversión de señales 2-3% (vs 0.44% anterior)

---

### 🗑️ Archivos Eliminados

**Código obsoleto**:
- `src/index.js`
- `src/index-fixed.js`
- `src/index-simple.js`
- `src/index-v3.js`
- `src/index-latency-arb.js`
- `src/index-latency-arb-OLD.js`
- `src/index-websocket.js`
- `src/index-websocket-v2.js`
- `src/polymarket-ws.js`
- `src/risk-manager.js`
- `src/stop-loss.js`
- `src/test-signal.js`

**Documentación obsoleta**:
- `CAMBIOS_IMPLEMENTADOS.md`
- `CORRECCIONES_V2.md`
- `DEPLOYMENT_GUIDE.md`
- `GO_LIVE_GUIDE.md`
- `WEBSOCKET_README.md`
- `WEBSOCKET_V2_README.md`
- `scripts/` (directorio completo)

**Archivos mantenidos**:
- `src/index-final.js` → Main entry point
- `src/signal.js` → Motor de señales (CORREGIDO)
- `src/polymarket.js` → CLOB API client
- `src/binance.js` → Coinbase WebSocket
- `src/tracker.js` → P&L tracking
- `src/logger.js` → Logging
- `src/config.js` → Config (ACTUALIZADO)
- `package.json`
- `railway.toml`
- `README.md` (REESCRITO)

---

## [2.0.0] - 2026-05-15

### Añadido
- Sistema de señales basado en Z-score y momentum
- WebSocket de Coinbase (Binance bloqueado en Railway)
- P&L Tracker con resolución automática de mercados
- Risk management (cooldown, exposure limits)
- Limit orders en Polymarket CLOB v2

### Resultados iniciales
- Win Rate: 63.9%
- Total P&L: +$91.45
- 61 trades ejecutados
- 13,850+ señales procesadas

---

## Plan de Testing

### Fase 1: Paper Trading (24-48h)
- [ ] Deployar a Railway con correcciones
- [ ] Monitorear edges reportados (deben estar en rango 2-10%)
- [ ] Verificar que no haya rechazos por "POLY_PRICE_STALE"
- [ ] Confirmar que trades se ejecutan con >120s de buffer
- [ ] Validar win rate >60%

### Fase 2: Live Trading (si Fase 1 exitosa)
- [ ] Configurar credenciales de Polymarket
- [ ] Depositar $25-50 inicial
- [ ] Setear `DRY_RUN=false`
- [ ] Monitorear 48h con capital real
- [ ] Escalar gradualmente según performance

---

## Métricas a Monitorear

### Indicadores de salud
- Edge promedio: 2-8% (óptimo)
- Win rate: >60%
- Conversión señales → trades: 2-3%
- Tiempo promedio de ejecución: <120s antes del cierre
- Rechazos por staleness: <5%

### Red flags
- Edges >15% (indica precio stale)
- Win rate <50% sostenido >24h
- Muchos rechazos por "mercado ya cerrado"
- Errores de conexión WebSocket

---

## Contacto

Para reportar issues o sugerencias, abrir un issue en GitHub.
