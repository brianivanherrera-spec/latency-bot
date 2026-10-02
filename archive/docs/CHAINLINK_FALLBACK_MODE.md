# 🚨 Chainlink RTDS Fallback Mode

**Status**: ✅ Implemented  
**Date**: 2026-09-17  
**Reason**: Chainlink RTDS subscription all 6 formats rejected

---

## 📋 El Problema

Chainlink RTDS está rechazando todas las suscripciones:

```
FORMAT_A-ALT (topic + type + filters=OBJECT)        ❌ Invalid request body
FORMAT_A (topic + type + filters=JSON_STRING)       ❌ Invalid request body
FORMAT_B (topic + symbol)                           ❌ Invalid request body
FORMAT_B-UPPER (topic + symbol uppercase)           ❌ Invalid request body
FORMAT_C (topic only)                               ❌ Invalid request body
FORMAT_D (topic + asset_pair)                       ❌ Invalid request body
```

**Resultado**: Chainlink RTDS no disponible, bot pierde acceso a precios TWAP 30s/60s

---

## ✅ La Solución: BINANCE_ONLY_MODE

Cuando Chainlink RTDS agota todos los 6 formatos, el bot:

1. **Emite evento 'fallback'** → `clRTDS.emit('fallback', { reason: '...' })`
2. **Establece flag global** → `global.BINANCE_ONLY_MODE = true`
3. **Cierra conexión** → Graceful disconnect del WebSocket
4. **Continúa operando** → Bot sigue funcionando con Binance solamente

### Impacto

| Dato | Con Chainlink | Con Fallback |
|------|---------------|--------------|
| BTC precios (Binance) | ✅ | ✅ |
| TWAP 30s (Chainlink) | ✅ | ❌ |
| TWAP 60s (Chainlink) | ✅ | ❌ |
| Polymarket precios | ✅ | ✅ |
| Señales de trading | ✅ | ✅ (parciales) |
| Fills/NO_FILLS | ✅ | ✅ |
| Logging | ✅ | ✅ |

---

## 🔧 Código Implementado

### chainlink-rtds.js
```javascript
_subscribe() {
  if (this.currentFormatIndex >= this.subscriptionFormats.length) {
    this.logger.error('[CHAINLINK-RTDS] All subscription formats exhausted, giving up');
    this.logger.warn('[CHAINLINK-RTDS] ⚠️ FALLBACK: Entering BINANCE_ONLY_MODE');
    
    // Emitir evento para que index-final.js lo capture
    this.emit('fallback', { 
      mode: 'BINANCE_ONLY', 
      reason: 'All subscription formats rejected' 
    });
    
    // Cerrar WebSocket gracefully
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    return;
  }
  // ... continuar con siguiente formato
}
```

### index-final.js
```javascript
// Inicializar flag
global.BINANCE_ONLY_MODE = false;

// Escuchar evento de fallback
clRTDS.on('fallback', (fallbackInfo) => {
  global.BINANCE_ONLY_MODE = true;
  logger.error(`[CHAINLINK-FALLBACK] ${fallbackInfo.reason} - Operating in BINANCE_ONLY_MODE`);
});

clRTDS.connect();
```

---

## 📊 Logs Esperados

Cuando Chainlink RTDS falla, verás:

```
[CHAINLINK-RTDS] ✓ Connected to Polymarket RTDS
[CHAINLINK-RTDS] Attempt 1/6: FORMAT_A-ALT (topic + type + filters as OBJECT)
[CHAINLINK-RTDS] ⚠ Invalid request body for FORMAT_A-ALT
[CHAINLINK-RTDS] ✗ Current format rejected, trying next format...
[CHAINLINK-RTDS] Attempt 2/6: FORMAT_A (official: topic + type + filters as JSON string)
...
[CHAINLINK-RTDS] Attempt 6/6: FORMAT_D (asset_pair)
[CHAINLINK-RTDS] ⚠ Invalid request body for FORMAT_D
[CHAINLINK-RTDS] ✗ Current format rejected, trying next format...
[CHAINLINK-RTDS] All subscription formats exhausted, giving up
[CHAINLINK-RTDS] ⚠️ FALLBACK: Entering BINANCE_ONLY_MODE - Chainlink RTDS unavailable
[CHAINLINK-FALLBACK] All subscription formats rejected - Operating in BINANCE_ONLY_MODE
```

---

## 🔍 Verificar Estado

Para verificar si el bot está en fallback mode:

```bash
# En los logs
railway logs | grep "BINANCE_ONLY_MODE"

# O programáticamente en index-final.js
if (global.BINANCE_ONLY_MODE) {
  logger.warn('⚠️ Bot operating without Chainlink data');
}
```

---

## 🚀 Próximos Pasos

### Corto Plazo (Inmediato)
1. ✅ **Fallback implementado** - Bot puede funcionar sin Chainlink
2. ✅ **Graceful degradation** - Evita crash completo
3. ✅ **Logging claro** - Fácil de detectar en logs

### Mediano Plazo (24-48h)
- [ ] **Investigar raíz del problema de Chainlink**
  - ¿API cambió formato?
  - ¿Credenciales revocadas?
  - ¿Endpoint down?
- [ ] **Comunicar con Chainlink/Polymarket** sobre endpoint correcto
- [ ] **Actualizar formatos** cuando se sepa el correcto

### Largo Plazo (Si Chainlink no se recupera)
- [ ] **Remover dependencia de Chainlink RTDS**
- [ ] **Usar solo Binance TWAP calculado localmente**
- [ ] **Ajustar estrategia de trading** sin TWAP de Chainlink

---

## ⚠️ Limitaciones en BINANCE_ONLY_MODE

**Señales de trading**:
- ✅ Siguen generándose (basadas en Binance Z-score)
- ⚠️ Pueden ser menos confiables sin Chainlink TWAP

**Ejecución**:
- ✅ Polymarket orders se envían normalmente
- ✅ Fills se detectan y registran
- ✅ NO_FILL diagnostics funcionan

**Análisis**:
- ✅ Todo se logguea en bot-events.jsonl
- ⚠️ MarketRecorder tendrá `events_chainlink_30s=0` y `events_chainlink_60s=0`

---

## 📝 Estado Actual

**Bot**: En Railway con Chainlink RTDS fallido  
**Modo**: BINANCE_ONLY_MODE activo  
**Riesgo**: Bajo - bot sigue operando con degradación mínima  
**Acción**: Investigar y resolver problema de Chainlink

---

## Commit Hash
`65f6b3a` - Add Chainlink RTDS fallback mode for BINANCE_ONLY operation
