# 🎯 Latency Arbitrage Bot - Polymarket BTC Markets

Bot de trading algorítmico que explota el delay de latencia entre Coinbase WebSocket (precio real de BTC) y los mercados de Polymarket "Bitcoin Up or Down" de 5 minutos.

## 📊 Resultados (Paper Trading)

- **Win Rate**: 63.9% (39W / 22L)
- **Total P&L**: +$91.45 USD
- **Trades ejecutados**: 61
- **Señales procesadas**: 13,850+

## 🔧 Correcciones Implementadas (v2.1)

### ✅ Fix #1: Edge Calculation Realista
**Problema anterior**: Edges de 100-135% (físicamente imposibles)  
**Causa**: Calculaba edge contra precio base 0.50 en lugar del precio actual de Polymarket  
**Solución**: Ajuste incremental desde el precio actual
```javascript
// ANTES: fairYes = 0.50 + adjustment → Edge vs 0.50
// AHORA: fairYes = polyYesPrice + adjustment → Edge vs precio actual
```
**Resultado**: Edges realistas de 2-10%

### ✅ Fix #2: Buffer de Tiempo
**Problema anterior**: Intentaba operar con solo 60s antes del cierre del mercado  
**Causa**: Delay entre detección de señal y ejecución  
**Solución**: Buffer aumentado a 120 segundos  
**Resultado**: Menos trades rechazados por "mercado ya cerrado"

### ✅ Fix #3: Parámetros Optimizados
```
ZSCORE_THRESHOLD: 1.2 → 1.5 (menos señales débiles)
MOVE_PCT_THRESHOLD: 0.03% → 0.04% (filtrado más estricto)
POLY_SENSITIVITY: 2.5 → 5.0 (mejor captura de movimientos)
MIN_EDGE_PCT: 3% → 2.5% (mayor conversión)
MAX_PRICE_AGE_MS: 3000ms → 5000ms (menos rechazos por staleness)
```

## 🚀 Deployment

### Variables de Entorno (Railway)

**Modo de operación:**
```bash
DRY_RUN=true  # Paper trading (default)
DRY_RUN=false # Live trading con fondos reales
```

**Credenciales Polymarket** (solo para live):
```bash
POLY_PRIVATE_KEY=0x...
POLY_API_KEY=...
POLY_API_SECRET=...
POLY_PASSPHRASE=...
```

**Parámetros de señal** (opcional, usa defaults optimizados):
```bash
ZSCORE_THRESHOLD=1.5
MOVE_PCT_THRESHOLD=0.04
POLY_SENSITIVITY=5.0
MIN_EDGE_PCT=2.5
MAX_PRICE_AGE_MS=5000
```

### Deploy a Railway

1. **Conectar repo**:
   ```bash
   railway link
   ```

2. **Configurar variables** en Railway Dashboard → Settings → Variables

3. **Deploy**:
   ```bash
   git push
   ```

4. **Monitorear logs**:
   ```bash
   railway logs
   ```

## 📁 Estructura del Código

```
src/
├── index-final.js  # Main entry point
├── signal.js       # Motor de señales (Z-score + edge calculation)
├── polymarket.js   # Cliente CLOB API v2
├── binance.js      # Coinbase WebSocket (precio BTC)
├── tracker.js      # P&L tracking
├── logger.js       # Logging
└── config.js       # Configuración centralizada
```

## 🔍 Cómo Funciona

1. **WebSocket Coinbase**: Recibe ticks de BTC/USD en tiempo real
2. **Signal Engine**: Calcula Z-score y momentum sobre ventana de 300 ticks
3. **Edge Detection**: Compara precio "justo" vs precio actual de Polymarket
4. **Risk Management**: Cooldown 3min, max 10 posiciones, exposure limits
5. **Execution**: Limit orders en Polymarket CLOB
6. **P&L Tracking**: Monitorea resolución de mercados cada 60s

## 📈 Próximos Pasos

1. ✅ Monitorear 24-48h en paper mode con nuevos parámetros
2. ✅ Verificar que edges sean realistas (2-10%)
3. ✅ Confirmar win rate >60%
4. 🎯 Si resultados son consistentes → ir a live con $25-50 inicial
5. 🎯 Escalar gradualmente según compounding

## ⚠️ Notas Importantes

- Railway bloquea `polymarket.com` → usa Gamma API para precios
- Mercados de 5min son volátiles → buffer de 120s es crítico
- Edge >15% indica precio stale → rechazar
- Cooldown de 3min evita overtrading

## 📊 Estrategia Matemática

1. **Buffer deslizante** de 300 ticks (~10-30 segundos)
2. **Z-Score**: detecta cuando el precio se aleja N desviaciones estándar de la media
3. **Momentum**: calcula movimiento % en ventana corta
4. **Presión de compra**: ratio de buy vs sell en últimos 50 ticks
5. **Velocidad**: valida que el movimiento sea rápido (no gradual)
6. **Edge calculation**: ajusta precio "justo" INCREMENTALMENTE desde precio actual de Polymarket
7. Si todos los filtros pasan → señal UP o DOWN → limit order en Polymarket

## 📞 Soporte

Issues en GitHub o contacto directo.
