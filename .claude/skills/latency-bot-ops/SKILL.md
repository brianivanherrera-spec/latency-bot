---
name: latency-bot-ops
description: Método para operar el latency-bot (paper trading en los mercados "Bitcoin Up or Down" de 5 minutos de Polymarket) — informes de monitoreo, lectura de las cuentas A y B, backtest y criterios para adoptar o revertir cambios de estrategia. Usalo cuando haya que revisar cómo va el bot, analizar operaciones o pérdidas, proponer o aplicar un cambio de reglas, o preparar un deploy.
---

# Operar el latency-bot

Objetivo del usuario: que el bot gane plata, funcione solo y se monitoree. Respondé siempre
en español, con horarios en hora de Argentina (UTC−3).

## Límites (no se negocian)

- Siempre en paper (`DRY_RUN=true`). Pasar a real, mover fondos, subir tamaños o exposición
  (`ORDER_SIZE_USDC`, `DYNAMIC_SIZE_SCALE`, `MAX_TOTAL_EXPOSURE_USDC`), activar `ELITE_MODE` o
  quitar límites de pérdida: solo con OK explícito del usuario en el chat.
- Tamaño ~$5 por operación: no escalar (con más tamaño el fill empeora).
- El usuario vive en Argentina, bloqueada por Polymarket: nada que esquive el geobloqueo (ni
  VPN, ni servidor en otro país, ni cuenta de otra persona). PolyBolt, con la cuenta del
  usuario, solo para leer precios.
- No listar las variables de Railway ni imprimir secretos (`POLY_PRIVATE_KEY` y similares).
- No tocar `main`: trabajar en la rama de la sesión.

## Dónde está el estado

- `docs/ops/BITACORA.md`: reglas de autonomía y cada cambio con su evidencia y su criterio de
  reversión. Leela antes de cambiar algo y anotá ahí cada cambio (una fila por cambio).
- Railway, servicio `latency-bot`: logs con la herramienta `get-logs` del MCP de Railway, con
  filtros de texto acotados (`"[OPEN]" OR "[WIN]"`; el filtro por nivel no sirve: buscá
  `"[WARN]"` o `"[ERROR]"` como texto). Si el resultado es grande se guarda en un archivo:
  analizalo con `jq`. Con `limit` trae lo más reciente: partí las horas cargadas en dos.

## Las dos cuentas de paper

- **A — regla actual del bot**: señal de Binance + gate de precio justo (ventaja ≥ 8 pts),
  ask ≤ $0.79, como mucho 240 s antes del cierre, límite ask + 2¢, fill simulado a +400 ms.
  Líneas: `[OPEN]`, `[PAPER-DELAY]`, `[PAPER-REST]`, `[GATE-SOMBRA]` (qué decía la regla de B
  en ese momento), `[WIN]`/`[LOSS]`, `P&L simulado`. Su paper es optimista (supone que siempre
  llega primero): la referencia conservadora es la línea `[EJECUCION] PAPER con competencia`.
- **B — regla anclada** (`src/paper-b.js`): ventaja ≥ 8 pts neta de comisión contra el precio
  justo anclado al mercado, ask $0.30-0.70, entre 120 y 30 s antes del cierre, límite por precio
  justo. Su referencia es "con el libro REST" en `[PAPER-B] Balance B` (valúa cada llenada con
  el libro de la API REST).

## Informe de monitoreo

1. Deploy activo y reinicios (`list-deployments`). Los commits que solo tocan `docs/` o
   `.claude/` salen como SKIPPED: no reinician el bot.
2. Operaciones: `"[OPEN]" OR "PAPER-DELAY" OR "[WIN]" OR "[LOSS]" OR "PAPER-REST" OR
   "[PAPER-B]" OR "P&L Total" OR "P&L simulado" OR "[ERROR]" OR "SHUTDOWN"`.
3. Salud: `"[LOOP]" OR "CHAINLINK-DUAL" OR "BOOK-CHECK" OR "PTB-CHECK" OR "[STRIKE]" OR "[WARN]"`.
4. Escribí: tabla A vs B (en la hora y acumulado; B en paper y con el libro REST), qué
   funciona, qué no y qué cambiarías. Cada operación perdida, con su porqué (ask, segundos
   restantes, ventaja, qué decía la otra regla, cómo cerró BTC contra el strike).

Avisá si: el retraso del WS (`[LOOP]`, "retraso WS") pasa de p99 1 s o máx 3 s; hay más de
~20 cortes `1013` por hora o coinciden con decisiones; aparece "PolyBolt sin TWAP" o "sin
auth"; `strike_source` sale null o binance fuera de un reinicio; `[PTB-CHECK]` no da Δ $0.00;
`[BOOK-CHECK]` marca "WS al día: diferencia REAL" sin un corte o movimiento fuerte cerca.

## Adoptar o revertir una regla

- Solo con ventaja **fuera de muestra** (datos posteriores al diseño de la regla), **ejecución
  realista** (fill a +400 ms, libro REST, competencia) y **muestra suficiente** (≥ ~30 casos;
  para la regla de B: EV por acción > 0 y z ≥ 2 en test, y la cuenta B ganando en vivo con el
  libro REST).
- Primero en sombra o detrás de una variable que por defecto no cambia nada. El criterio de
  reversión se anota en la bitácora antes de aplicar el cambio.
- Un cambio por vez, al menos 12 h entre cambios de parámetros y como mucho un deploy de
  código cada 6 h (juntar cambios). Railway reinicia solo si cambian `src/`, `scripts/`,
  `package*.json` o `railway.toml`.
- Antes de pushear: `node --check` de cada archivo tocado y todas las suites
  (`for f in test/*.test.js; do node "$f" || break; done`). Después: deploy en SUCCESS y
  arranque sin errores; si no, revertir el commit.

## Trampas conocidas

- La regla que mejor da en los datos con que se eligió casi nunca se sostiene: mirá siempre
  la parte de test y el fuera de muestra del backtest (`scripts/backtest.js`, corre 2 min
  después de cada arranque y cada 12 h).
- El libro del WS de Polymarket puede llegar 1-3 s tarde, sobre todo cerca de los cortes
  `1013` ("precio viejo del WS"): compará con el REST (`[PAPER-REST]`, `[PAPER-B] REST`).
- Los mercados se resuelven con el TWAP de Chainlink (priceToBeat), no con el spot: un cierre a
  pocos dólares del strike puede salir al revés de lo que dice el precio spot.
- Las órdenes que no llenan suelen ser ganadoras (el precio se escapó a favor): un fill rate
  alto no es buena señal por sí solo.
