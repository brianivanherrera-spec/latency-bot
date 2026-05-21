# Latency Bot — Roadmap & Ideas Pendientes

## Estado actual (Mayo 2026)
- Bot corriendo en **PAPER TRADING** en Railway
- Capital real disponible: $1.68 USDC en Polymarket (recargar el lunes)
- Win rate última sesión: 68.4% (39W/18L, 57 trades, 20 horas continuas)
- Signal logger v2 activo guardando en Railway Volume `/data/signals.jsonl`
- Filtro de horarios activo basado en backtest de 2531 mercados históricos
- Todos los filtros activos y estables sin reinicios en 20+ horas

---

## Plan inmediato

### Lunes
1. **Descargar signals.jsonl del Railway Volume:**
   - Railway → tu servicio → Volumes → descargar `/data/signals.jsonl`
   - Copiar el archivo a la carpeta del repo
   - Correr: `node analyze_signals.js signals.jsonl`
   - El script muestra win rate por hora, Z-score, RSI, imbalance, edge decay

2. **Decisión de go live:**
   - Si el análisis confirma 65%+ WR sostenido → recargar $25 en Polymarket
   - Configurar `DRY_RUN=false`, `ORDER_SIZE_USDC=3`, `MAX_TOTAL_EXPOSURE_USDC=10`
   - Actualizar `PAPER_CAPITAL` con el nuevo capital

3. **Escala gradual de capital:**

| Balance Poly | ORDER_SIZE_USDC | Ganancia esperada/día |
|-------------|----------------|----------------------|
| $4-10       | $1             | $2-5                 |
| $10-25      | $2             | $5-12                |
| $25-50      | $4             | $10-25               |
| $50-100     | $8             | $20-50               |
| $100-200    | $15            | $40-100              |
| $200+       | $25            | $80-200              |

*Basado en 65% win rate y ~30 trades/día*

**Regla importante:** nunca subir el size si perdés 3 seguidos — bajás a $1 y esperás.

---

## Lo que está implementado

### Señales y filtros (en cascada)
1. **Z-score ≥ 1.5** — movimiento estadísticamente anómalo
2. **Movimiento ≥ 0.04%** — movimiento real, no ruido
3. **Warmup 200 ticks** — espera ~3 min tras reinicio
4. **Timing mínimo 90s** — no entrar si quedan menos de 90s al cierre
5. **Tendencia macro** — no apostar DOWN si BTC lleva 2.5 min subiendo (y viceversa)
6. **Filtro de horarios** — bloquea horas con WR histórico < 45% (backtest 2531 mercados)
7. **Orderbook imbalance** — si compradores dominan (+0.3), no apostar DOWN

### Indicadores calculados (para análisis futuro)
- **RSI(14)** sobre buffer de precios
- **Orderbook imbalance** — ratio bid/ask quantity de Coinbase
- **Spread ratio** — spread actual vs promedio
- **Tick frequency** — ticks en últimos 10s (proxy de volumen)

### Signal Logger v2 — campos guardados en signals.jsonl
- `filled_price` — precio exacto de entrada
- `zscore, movePct, imbalance, rsi, spreadRatio, tickFreq` — todos los indicadores
- `consecutive_losses` — losses seguidos al momento de la señal
- `btc_price_entry` — precio BTC al disparo
- `poly_price_t0/t1/t2/t5` — precio Polymarket en T+0,1,2,5s (edge decay)
- `btc_price_change_30s` — cambio de BTC 30s después (momentum)
- `trade_duration_seconds` — duración del trade
- `result / pnl` — resultado y ganancia/pérdida

### Infraestructura
- **Railway** — hosting, redeploy automático desde GitHub
- **Railway Volume** — `/data` para persistencia de signals.jsonl entre reinicios
- **Discord Webhooks** — alertas en cada señal con dirección, precio, edge, tiempo
- **GitHub** — `brianivanherrera-spec/latency-bot`, rama `main`

### Scripts disponibles
- `node backtest.js` — descarga 30 días de mercados históricos y analiza
- `node analyze_signals.js [archivo]` — analiza signals.jsonl del Volume

---

## Variables clave en Railway

| Variable | Valor actual | Descripción |
|----------|-------------|-------------|
| DRY_RUN | true | Paper trading (false para live) |
| ORDER_SIZE_USDC | 3 | Monto por trade |
| PAPER_CAPITAL | 25 | Capital inicial para simulación |
| MAX_TOTAL_EXPOSURE_USDC | 100 | Máximo simultáneo |
| DATA_DIR | /data | Directorio del Railway Volume |
| DISCORD_WEBHOOK_URL | configurado | Alertas de trades |
| ZSCORE_THRESHOLD | 1.5 | Umbral Z-score |
| MOVE_PCT_THRESHOLD | 0.04 | Movimiento mínimo % |
| MIN_EDGE_PCT | 0.8 | Edge mínimo vs precio Polymarket |
| COOLDOWN_SECONDS | 360 | Segundos entre trades |
| TRADING_HOURS_ENABLED | true | Filtro de horarios activo |
| TRADING_HOURS_BLOCKED_UTC | 0,12,16,20,23 | Horas bloqueadas |
| POLY_PRIVATE_KEY | configurado | Private key de la wallet |
| POLY_FUNDER_ADDRESS | configurado | Deposit wallet address |

---

## Mejoras planificadas

### 1. Signal Score Dinámico (ALTA PRIORIDAD — implementar post-análisis)
En lugar de apostar siempre el mismo monto, calcular un score de confianza:

```
score = zscore_weight + imbalance_weight + rsi_weight + hour_weight + spread_weight

Score 50-65% → $1
Score 65-75% → $3
Score 75-85% → $7
Score 85%+   → $15
```

**Cuándo:** después de analizar signals.jsonl con 200+ trades y saber
el peso real de cada indicador sobre el win rate.

---

### 2. Circuit Breaker (ALTA PRIORIDAD — implementar lunes)
Si el bot pierde 3 trades seguidos, pausar 30 minutos automáticamente.

```javascript
// En index-final.js, antes de ejecutar:
if (signalLogger.getConsecutiveLosses() >= 3) {
  logger.warn('[CIRCUIT BREAKER] 3 losses seguidos — pausando 30min');
  lastTradeTime = now + 30 * 60 * 1000;
  return;
}
```

Ya tenemos `getConsecutiveLosses()` en el signal logger. Es 5 líneas.

---

### 3. Size Dinámico por Hora (ALTA PRIORIDAD — implementar con datos)
Una vez que `analyze_signals.js` confirme qué horas son buenas:

```javascript
const hourSizes = {
  9: 8, 11: 8, 14: 5, 16: 5,   // horas buenas
  // resto: ORDER_SIZE_USDC default
};
const exposure = hourSizes[argHour] || config.ORDER_SIZE_USDC;
```

---

### 4. ETH Markets (MEDIA PRIORIDAD)
Replicar la misma estrategia en mercados ETH Up/Down 5min.
Mismo signal engine, segundo WebSocket ETH-USD, buscar `eth-updown-5m-*`.
Duplica oportunidades sin agregar complejidad.
**Cuándo:** cuando el bot de BTC esté en live generando ganancias.

---

### 5. VPS Nueva York (MEDIA PRIORIDAD)
Mover el bot de Railway (us-west) a VPS en NY/NJ más cerca de Polymarket
(AWS us-east-1). Latencia: ~400ms → ~150ms.
Costo: ~$6/mes en Hetzner o Vultr.
**Cuándo:** cuando el balance llegue a $100+ y los trades sean $10+.

---

### 6. Correlación BTC/ETH (BAJA PRIORIDAD)
Cuando ETH se mueve fuerte y BTC no lo siguió todavía, BTC lo sigue
en 30-60 segundos. Segundo WebSocket ETH-USD como señal anticipatoria.

---

### 7. Rolling Analytics (BAJA PRIORIDAD)
Win rate de las últimas N señales (ventana deslizante). Si cae mucho
vs el histórico, alertar degradación del edge.

---

## Arquitectura del bot

```
Coinbase WebSocket (BTC-USD tick data)
    ↓
SignalEngine
  - Z-score sobre buffer 300 ticks
  - Momentum (movePct, velocity)
  - Tendencia macro (últimos 150 ticks)
  - Orderbook imbalance (bid/ask qty)
  - RSI(14), spread ratio, tick frequency
    ↓
Filtros en cascada
  1. Warmup 200 ticks
  2. Filtro horario (UTC bloqueados)
  3. Cooldown 6 minutos
  4. Edge mínimo 0.8%
  5. Timing mínimo 90s
  6. Imbalance filter
    ↓
PolymarketClient (CLOB V2, POLY_1271, deposit wallet)
    ↓
Signal Logger v2 (/data/signals.jsonl)
  - Indicadores completos
  - Edge decay Polymarket T+0/1/2/5s
  - BTC snapshot 30s después
  - Consecutive losses
    ↓
Tracker + Discord Alerts + Railway Logs
```

---

## Historial de decisiones importantes

| Fecha | Decisión | Por qué |
|-------|----------|---------|
| May 17 | Railway bloqueaba Binance → Coinbase WebSocket | Coinbase no bloqueado |
| May 18 | POLY SDK roto para cuentas nuevas | Bypass con balance cache update (POLY_1271) |
| May 18 | Rachas malas de madrugada | Warmup 200 ticks + timing 90s |
| May 18 | Tracker inflado vs balance real | Consulta real al CLOB cada 5 min |
| May 19 | Filtro confirmación Polymarket eliminado | Contradecía latency arb — el edge es que Poly está atrasado |
| May 19 | Filtro horarios implementado | Backtest 2531 mercados reveló diferencias enormes |
| May 20 | Railway Volume montado en /data | Persistencia de signals.jsonl entre reinicios |
| May 20 | Signal Logger v2 | Edge decay, consecutive losses, BTC snapshot 30s |
| May 20 | ORDER_SIZE_USDC hardcodeado en $5 | Fix: ahora lee la variable de Railway correctamente |

---
*Última actualización: Mayo 2026*
