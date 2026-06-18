# Latency Bot — Roadmap & Estado Actual

## Estado actual (Junio 2026)
- Bot corriendo en **PAPER TRADING** en Railway (Servidor A)
- Capital live: $0 — se agotó en primeras pruebas live (Jun 12-15)
- **652 trades acumulados con resultado** en signals.jsonl (22 días de datos)
- WR paper horas libres: **63.2%** | WR live real: bajo por bugs (ya corregidos)
- PnL acumulado paper (con $5/trade): **$1,032**
- Próximo live: cuando se recargue capital (mes que viene)

---

## Bugs corregidos ✅

### Críticos (afectaban live vs paper)
1. **FOK → GTC con polling** — el FOK rechazaba 87% de órdenes por falta de liquidez instantánea. GTC pone la orden en el book y espera hasta 60s
2. **Tracker post-fill** — el tracker abría posición ANTES de confirmar fill. Ahora solo se abre después de GTC matched
3. **Paper fill rate simulado** — paper asumía 100% fill rate. Ahora simula 75% (PAPER_FILL_RATE=0.75) para ser realista
4. **GTC timeout bug duplicado** — doble check contradictorio en index-final.js. Eliminado
5. **Size check antes de Discord** — mandaba alerta de orden que luego rechazaba. Movido antes
6. **Modo live/paper en signals.jsonl** — cada trade ahora guarda `mode: "live"` o `"paper"`

### Filtros y calibración
7. **MAX_SIGNAL_SCORE=89** — score 90-99 tiene solo 53% WR (señales en momentos extremos). Ahora bloqueado
8. **MIN_SECONDS_REMAINING=60** — bajado de 90s a 60s para más ventana de entrada
9. **Discord non-blocking** — setImmediate + fire-and-forget, no bloquea ejecución
10. **COOLDOWN_SECONDS=60** — bajado de 360→90→60 para más trades/día
11. **Hour blocking actualizado** — UTC 0,1,2,6,7,9,10,11,16,17,18,19,20,22,23 bloqueados
12. **Signal Score gate 60-89** — calibrado con 652 trades reales

---

## Variables Railway actuales

| Variable | Valor | Descripción |
|---|---|---|
| `DRY_RUN` | `true` | Cambiar a `false` para live |
| `ORDER_SIZE_USDC` | `3` | $3/trade = 5 tokens mínimo Polymarket |
| `COOLDOWN_SECONDS` | `60` | 1 minuto entre trades |
| `MIN_SIGNAL_SCORE` | `60` | Score mínimo para entrar |
| `MAX_SIGNAL_SCORE` | `89` | Score máximo (>89 = señal extrema, evitar) |
| `TRADING_HOURS_ENABLED` | `true` | Horas bloqueadas activas |
| `TRADING_HOURS_BLOCKED_UTC` | `0,1,2,9,10,11,16,17,18,19,20,22,23` | Horas con WR <60% |
| `IMBALANCE_MAX` | `0.3` | Imbalance máximo permitido |
| `CIRCUIT_BREAKER_LOSSES` | `3` | Losses seguidos → pausa |
| `CIRCUIT_BREAKER_PAUSE_MIN` | `30` | Minutos de pausa tras CB |
| `GTC_TIMEOUT_SECONDS` | `60` | Segundos esperando fill GTC |
| `PAPER_FILL_RATE` | `0.75` | Fill rate simulado en paper |
| `MIN_SECONDS_REMAINING` | `60` | Segundos mínimos en mercado para entrar |
| `PAPER_CAPITAL` | `50` | Capital inicial paper |
| `ZSCORE_THRESHOLD` | `1.5` | Z-score mínimo |
| `MIN_EDGE_PCT` | `0.3` | Edge mínimo para operar |

---

## Horas libres (11 horas UTC)

| UTC | ARG | WR histórico (652 trades) | Trades/día |
|---|---|---|---|
| 03 | 00hs | 68% | 1.9 |
| 04 | 01hs ⭐ | **75%** | 2.0 |
| 05 | 02hs | 69% | 2.2 |
| 06 | 03hs | 58% | 2.0 |
| 07 | 04hs | 56% | 2.3 |
| 08 | 05hs | 57% | 2.2 |
| 12 | 09hs ⭐ | **71%** | 2.5 |
| 13 | 10hs ⭐ | **64%** | 2.9 |
| 14 | 11hs | 60% | 2.4 |
| 15 | 12hs | 58% | 3.0 |
| 21 | 18hs | 61% | 2.1 |

**Horas doradas:** UTC 04 (ARG 01hs) y UTC 12 (ARG 09hs)

---

## Plan de escala (próximo live)

### Checklist go live
- [ ] Cargar capital en Polymarket (mínimo $30)
- [ ] Cambiar `DRY_RUN=false` en Railway
- [ ] Verificar `ORDER_SIZE_USDC=3` (5 tokens mínimo)
- [ ] Arrancar UTC 03-04 (ARG 00-01hs) — mejor franja

### Escala de capital
| Capital | Order size | Tokens | PnL/día est. | PnL/mes est. |
|---|---|---|---|---|
| $30 | $3 | 5 | $21 | $634 |
| $60 | $5 | 9 | $35 | $1,056 |
| $150 | $10 | 19 | $70 | $2,113 |
| $300 | $20 | 39 | $141 | $4,225 |
| $500 | $50 | 99 | $353 | $10,563 |

*Basado en 63% WR, 28 trades/día horas libres, fill rate 75%*

### Hito $1,000
Con reinversión total desde $30:
- Día 2: ~$75 → subir a $5/trade
- Día 6: ~$280 → subir a $20/trade
- Día 9: ~$1,000 → retirar $500, dejar $500 + $30 reserva

---

## Problemas pendientes

### Alta prioridad
1. **Conversión 11.2%** — de 535 señales, solo 60 se ejecutan. Con los fixes de cooldown (60s) y MIN_SECONDS_REMAINING (60s) debería subir a ~18-20%. Monitorear en próxima sesión paper
2. **Score 90-99 tiene 53% WR** — ya bloqueado con MAX_SIGNAL_SCORE=89. Investigar por qué señales extremas fallan
3. **BTC lateral = CB en cascada** — cuando BTC se mueve menos de $100 en una hora, el bot entra en rachas de losses y el CB se dispara repetidamente. Posible fix: filtro de volatilidad mínima de BTC

### Media prioridad
4. **UP trades peores que DOWN** — 65% WR en ambos ahora, pero en BTC alcista el bot genera más UP con RSI alto que falla. Monitorear si el sesgo vuelve
5. **Fill rate GTC en madrugada** — UTC 03-05 tiene menos liquidez. Monitorear cuántos GTC se llenan vs timeout en esas horas

### Baja prioridad
6. **Endpoint de descarga signals.jsonl** — para no depender de Railway Volumes UI
7. **Alertas de balance bajo** — Discord alert cuando balance < $10

---

## Historial de WR por período

| Período | Trades | WR | Nota |
|---|---|---|---|
| May 25-28 | 121 | 53% | Sin filtros |
| Jun 01-04 | 187 | 63% | Con RSI + horas |
| Jun 04-06 | 231 | 63.6% | Con signal score |
| Jun 06-09 | 323 | 62.6% | Discord non-blocking |
| Jun 09-11 | 421 | 63.2% | Todos los filtros |
| **Jun 16-18** | **652** | **72.7%** | **MAX_SCORE + MIN_SECS** |

