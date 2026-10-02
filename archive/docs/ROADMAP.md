# Latency Bot — Roadmap & Estado Actual

## Estado actual (Julio 2026)
- Bot en **PAPER TRADING** mientras se evalúa la estrategia live
- Capital live en Polymarket: **$30 USDC** listo para test
- **1,000+ trades** acumulados en signals.jsonl (paper + live)
- WR paper: **63.7%** (907 trades) | WR live estimado real: **~52%**
- PnL paper acumulado: **$3,941** | PnL live real: **+$33.34** (2 días)
- Balance Polymarket actual: **$63.34**

---

## Hallazgos del primer live (Jul 06-07)

### Problema identificado — Dirección vs Tendencia BTC
- UP live: **60% WR** ✅ (igual que paper)
- DOWN live: **7% WR** ⚠️ (paper tenía 65%)
- Causa: BTC subió $4,000 en 2 días → bot apostó DOWN contra tendencia
- Solución: **BTC_TREND_FILTER** — bloquea señales contra tendencia cuando BTC se mueve >$300/hora

### Fill rate real
- GTC fill rate: **29%** (vs 75% simulado en paper)
- Con precio alcista nadie vende NO tokens → GTC protege de losses involuntariamente
- El GTC actuó como filtro protector no diseñado

### Tracker incompleto
- Signals.jsonl mostró -$30 pero Polymarket mostró +$33
- Causa: redeploy de Railway borró posiciones de RAM
- Solución: **persistencia en disco** (/data/positions.json)

---

## Cambios aplicados Jul 07 (redeploy nocturno)

### Nuevas variables Railway
| Variable | Valor test | Descripción |
|---|---|---|
| `ORDER_TYPE` | `GTC` o `MARKET` | Tipo de orden |
| `BTC_TREND_FILTER` | `300` | Bloquea contra tendencia si BTC movió >$N/hora |
| `TRADING_HOURS_BLOCKED_UTC` | `0,1,2,6,9,10,11,16,17,18,19,20,22,23` | UTC 06 bloqueado |

### Código nuevo
1. **MARKET order** — fill 100% garantizado para test de WR real
2. **BTC_TREND_FILTER** — no apuesta DOWN si BTC subió >$300/hora (ni UP si bajó)
3. **Persistencia de posiciones** — tracker sobrevive redeploys (/data/positions.json)
4. **Endpoint /health mejorado** — expone stats en tiempo real

---

## Variables Railway completas

| Variable | Valor | Descripción |
|---|---|---|
| `DRY_RUN` | `false` | LIVE activo |
| `ORDER_SIZE_USDC` | `3` | $3/trade = 5-6 tokens |
| `ORDER_TYPE` | `GTC` | GTC o MARKET |
| `COOLDOWN_SECONDS` | `60` | 1 min entre trades |
| `MIN_SIGNAL_SCORE` | `60` | Score mínimo |
| `MAX_SIGNAL_SCORE` | `89` | Score máximo |
| `BTC_TREND_FILTER` | `300` | Filtro tendencia BTC |
| `PRICE_TOLERANCE` | `0.02` | Tolerancia de precio |
| `TRADING_HOURS_BLOCKED_UTC` | `0,1,2,6,9,10,11,16,17,18,19,20,22,23` | Horas bloqueadas |
| `GTC_TIMEOUT_SECONDS` | `60` | Timeout GTC |
| `PAPER_FILL_RATE` | `0.75` | Fill rate simulado paper |
| `MIN_BUFFER_SIZE` | `100` | Warmup ticks |
| `MIN_SECONDS_REMAINING` | `60` | Segundos mínimos en mercado |
| `CIRCUIT_BREAKER_LOSSES` | `3` | Losses para CB |
| `CIRCUIT_BREAKER_PAUSE_MIN` | `30` | Minutos pausa CB |
| `ZSCORE_THRESHOLD` | `1.5` | Z-score mínimo |
| `MIN_EDGE_PCT` | `0.3` | Edge mínimo |

---

## Plan de tests

### Test actual — Market order con $30
- Capital: $30 USDC en Polymarket
- `ORDER_TYPE=MARKET` → fill 100% garantizado
- `BTC_TREND_FILTER=300` → no apuesta contra tendencia
- Objetivo: confirmar WR real sin interferencia del fill rate
- Meta: 50+ trades para estadística confiable

### Escala progresiva (post-validación)
| Capital | Order | PnL/día est. | PnL/mes est. |
|---|---|---|---|
| $30 | $3 | $15-22 | $450-660 |
| $100 | $5 | $35-50 | $1,050-1,500 |
| $200 | $10 | $70-100 | $2,100-3,000 |
| $500 | $20 | $175-250 | $5,250-7,500 |
| $1,000+ | $50 | $437-600 | $13,000-18,000 |

---

## Pendientes

### Alta prioridad
1. **Validar WR real** con market order y BTC_TREND_FILTER — test en curso
2. **Dashboard web** — página HTML conectada a /health endpoint
3. **Migración a Vultr** — WebSocket Polymarket real, menos restricciones de red

### Media prioridad  
4. **Recalibrar signal score** — scores 80-89 tienen WR bajo en live
5. **ETH Up/Down** — segundo activo cuando BTC sea consistente

### Baja prioridad
6. **Descarga automática signals.jsonl** — endpoint /download/signals
7. **Alertas balance bajo** — Discord cuando balance < $15
