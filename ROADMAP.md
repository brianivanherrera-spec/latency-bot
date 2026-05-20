# Latency Bot — Roadmap & Ideas Pendientes

## Estado actual (Mayo 2026)
- Bot corriendo en **PAPER TRADING** en Railway
- Capital real disponible: $4.68 USDC en Polymarket
- Win rate overnight más reciente: 75% (30W/10L, 40 trades)
- Signal logger activo guardando en Railway Volume `/data/signals.jsonl`
- Filtro de horarios activo basado en backtest de 2531 mercados históricos

---

## Próximos pasos inmediatos

### Esta semana
- Dejar paper trading acumular 200-300 trades sin tocar nada
- Signal logger guardando: zscore, movePct, imbalance, RSI, spread, tickFreq, hora AR, resultado

### Fin de semana (cuando haya datos)
- Descargar `signals.jsonl` del Railway Volume
- Analizar qué indicadores correlacionan realmente con wins:
  - ¿Z-score alto mejora win rate?
  - ¿RSI extremo (<20 o >80) ayuda?
  - ¿Imbalance tiene señal real o es ruido?
  - ¿Qué horas nuestras señales son más precisas (no solo el backtest)?
- Identificar los pesos reales de cada factor

### Semana siguiente
- Decisión de go live basada en datos reales
- Implementar signal score dinámico (ver abajo)
- Recargar capital si el paper trading confirma 65%+ win rate sostenido

---

## Mejoras planificadas

### 1. Signal Score Dinámico (ALTA PRIORIDAD)
**Qué es:** en lugar de apostar siempre el mismo monto, el bot calcula
un score de confianza y apuesta en proporción.

**Lógica:**
```
score = zscore_weight + imbalance_weight + rsi_weight + hour_weight + spread_weight

Score 50-65% → $1 por trade
Score 65-75% → $3 por trade  
Score 75-85% → $7 por trade
Score 85%+   → $15 por trade
```

**Por qué no implementar todavía:** los pesos deben basarse en datos
reales del signal logger. Sin datos, los pesos son inventados y pueden
multiplicar las pérdidas en lugar de las ganancias.

**Cuándo implementar:** cuando tengamos 200+ trades en signals.jsonl
y sepamos el win rate real por cada indicador.

**Impacto esperado:** si el score es bueno, multiplica ganancias en
trades de alta confianza sin aumentar el riesgo en trades débiles.

---

### 2. Edge Decay Measurement (ALTA PRIORIDAD)
**Qué es:** medir cuánto tiempo tarda Polymarket en corregir su precio
después de que Coinbase se mueve.

**Por qué es importante:** define si Railway alcanza o necesitamos VPS
en Nueva York. Si el edge dura 3-5 segundos, Railway está bien.
Si dura 300ms, necesitamos VPS urgente.

**Implementación:** agregar al signal logger snapshots del precio de
Polymarket en T+0, T+1s, T+2s, T+5s después de cada señal.

**Cómo implementarlo:**
```javascript
// En index-final.js, después de detectar señal:
const polySnapshot = {
  t0: cachedMarket.yesPrice,      // precio al momento de la señal
  btcPrice: sig.currentPrice,
  timestamp: Date.now(),
};
// 1 segundo después:
setTimeout(() => { polySnapshot.t1 = getCurrentPolyPrice(); }, 1000);
// 2 segundos después:
setTimeout(() => { polySnapshot.t2 = getCurrentPolyPrice(); }, 2000);
// 5 segundos después:
setTimeout(() => { polySnapshot.t5 = getCurrentPolyPrice(); }, 5000);
// Guardar en signal logger junto con la señal
```

---

### 3. ETH Markets (MEDIA PRIORIDAD)
**Qué es:** replicar la misma estrategia en mercados ETH Up/Down 5min
de Polymarket usando la señal de ETH-USD de Coinbase.

**Por qué:** duplica las oportunidades sin agregar complejidad.
ETH y BTC están correlacionados pero no siempre se mueven juntos,
lo que da señales independientes.

**Implementación:** segundo WebSocket ETH-USD + buscar mercados
`eth-updown-5m-*` en paralelo al bot de BTC.

**Cuándo:** cuando el bot de BTC esté en live generando ganancias
consistentes.

---

### 4. Correlación BTC/ETH como señal anticipatoria (MEDIA PRIORIDAD)
**Qué es:** cuando ETH se mueve fuerte y BTC todavía no lo siguió,
BTC generalmente lo sigue en 30-60 segundos. Usar ETH como señal
adicional para confirmar o filtrar señales de BTC.

**Implementación:** segundo WebSocket ETH-USD, calcular si ETH se
movió en la misma dirección en los últimos 30s.

---

### 5. VPS Nueva York (BAJA PRIORIDAD AHORA)
**Qué es:** mover el bot de Railway (us-west) a un VPS en NY/NJ
más cercano a los servidores de Polymarket (AWS us-east-1).

**Impacto:** latencia de ~400ms → ~150ms. Importante cuando el
capital sea suficiente para que esos 250ms importen.

**Costo:** ~$6/mes en Hetzner o Vultr.

**Cuándo:** cuando el balance llegue a $100+ y los trades sean $10+.

---

### 6. Circuit Breaker (MEDIA PRIORIDAD)
**Qué es:** si el bot pierde 3 trades seguidos, se pausa
automáticamente por 30-60 minutos.

**Por qué:** las rachas malas suelen ocurrir cuando el mercado
cambió de régimen (lateral, reversión de tendencia). Una pausa
automática protege el capital.

**Implementación:** contador de losses consecutivos en index-final.js.
Si llega a 3, setea una variable `pauseUntil = Date.now() + 30*60*1000`.

---

### 7. Rolling Analytics / Degradación del Edge (BAJA PRIORIDAD)
**Qué es:** calcular el win rate de las últimas N señales (ventana
deslizante) y compararlo con el histórico. Si cae mucho, alertar.

**Por qué:** si más bots hacen lo mismo o Polymarket mejora su
latencia, el edge se comprime gradualmente. Detectarlo temprano
permite ajustar parámetros antes de perder capital.

**Implementación:** en el análisis de signals.jsonl, calcular win
rate rolling de últimas 20, 50, 100 señales y comparar tendencia.

---

## Escala de capital recomendada

| Balance Poly | ORDER_SIZE_USDC | Ganancia esperada/día |
|-------------|----------------|----------------------|
| $4-10       | $1             | $2-5                 |
| $10-25      | $2             | $5-12                |
| $25-50      | $4             | $10-25               |
| $50-100     | $8             | $20-50               |
| $100-200    | $15            | $40-100              |
| $200+       | $25            | $80-200              |

*Basado en 65% win rate y ~30 trades/día*

---

## Variables clave en Railway

| Variable | Valor actual | Descripción |
|----------|-------------|-------------|
| DRY_RUN | true | Paper trading (cambiar a false para live) |
| ORDER_SIZE_USDC | 1 | Monto por trade |
| PAPER_CAPITAL | 4.68 | Capital inicial para simulación |
| DATA_DIR | /data | Directorio del Railway Volume |
| DISCORD_WEBHOOK_URL | configurado | Alertas de trades |
| ZSCORE_THRESHOLD | 1.5 | Umbral Z-score para señal |
| MOVE_PCT_THRESHOLD | 0.04 | Movimiento mínimo % |
| MIN_EDGE_PCT | 0.8 | Edge mínimo vs precio Polymarket |
| COOLDOWN_SECONDS | 360 | Segundos entre trades |
| TRADING_HOURS_ENABLED | true | Filtro de horarios activo |
| POLY_PRIVATE_KEY | configurado | Private key de la wallet |
| POLY_FUNDER_ADDRESS | configurado | Deposit wallet address |

---

## Arquitectura del bot

```
Coinbase WebSocket (BTC-USD tick data)
    ↓
SignalEngine (zscore + momentum + macro trend + orderbook)
    ↓
Filtros (warmup + timing + horario + imbalance)
    ↓
PolymarketClient (CLOB V2, POLY_1271, deposit wallet)
    ↓
Tracker + SignalLogger (/data/signals.jsonl)
    ↓
Discord Alerts + Railway Logs
```

---

## Historial de decisiones importantes

- **Railway bloqueaba Binance** → cambiamos a Coinbase WebSocket
- **POLY SDK roto para cuentas nuevas** → implementamos bypass con balance cache update
- **Rachas malas de madrugada** → agregamos filtro de horarios basado en backtest
- **Tracker inflado vs balance real** → agregamos consulta real al CLOB
- **Reinicios de Railway perdían cooldown** → warmup de 200 ticks
- **Filtro confirmación Polymarket eliminado** → contradecía la estrategia de latency arb

---
*Última actualización: Mayo 2026*
