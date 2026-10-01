# Bitácora de operación del latency-bot

Registro de cada cambio de parámetros o código: qué se cambió, con qué evidencia y cuándo se
revierte. Lo leen y actualizan las rutinas automáticas (análisis por hora y revisión diaria),
así una sesión nueva sabe en qué estado está el bot sin depender del historial del chat.
Los cambios en `docs/` no reinician el bot (`watchPatterns` en `railway.toml`).

## Reglas de autonomía propuestas (pendientes de aprobación del usuario)

Propuesta del 01/10/2026. Todavía no están vigentes: hasta que el usuario las apruebe
explícitamente, cada cambio se propone y se aplica solo con su OK, salvo un error claro que
rompa el bot.

Se aplicarían sin preguntar:
- Arreglos de errores que rompen o degradan el bot.
- Cambios de parámetros o de código respaldados por datos: al menos 30 casos relevantes y
  mejora esperada clara, o un error evidente. Uno por vez, con criterio de reversión anotado
  acá antes de aplicarlo, y al menos 12 h entre cambios de parámetros para poder medirlos.
- Código nuevo detrás de una variable que por defecto no cambia el comportamiento.
- Como máximo un deploy de código cada 6 h, salvo arreglos urgentes. Antes de pushear:
  `node --check` de los archivos tocados y los tests que existan. Después: verificar que el
  deploy quede en SUCCESS y que el bot arranque sin errores; si no, revertir el commit.

Seguirían requiriendo confirmación explícita del usuario en el chat:
- Pasar a dinero real (`DRY_RUN=false`) o volver a paper desde real.
- Subir el tamaño de las órdenes o la exposición (`ORDER_SIZE_USDC`, `DYNAMIC_SIZE_SCALE`,
  `MAX_TOTAL_EXPOSURE_USDC`), activar `ELITE_MODE`, o desactivar límites de pérdida.
- Cualquier movimiento de fondos.

## Estado al 01/10/2026 13:40 UTC

- Modo: **paper** (`DRY_RUN=true`), deploy `a713fd32` (commit `0ced680`), región europe-west4.
- Orden: `ORDER_SIZE_USDC=4`, `DYNAMIC_SIZE_SCALE=0:5,200:6,700:15,1000:20` → ~$5 por trade.
- Filtros de entrada: `FAIR_GATE=agree` (precio ≥ 0.50), `FAIR_GATE_EDGE=0.06`,
  `MIN_ENTRY_PRICE=0.59`, máximo $0.80 (`MAX_GTC_ENTRY_ASK`/`MAX_ENTRY_PRICE`),
  `FAIR_VOL_MULT=1.4`, `BOOK_FILTER_ENABLED=false`, `CIRCUIT_BREAKER_LOSSES=5`.
- Resultado paper: 95G 35P, +$15.43 (balance $45.43). Desde el filtro del modelo
  (28/09 17:11): 117 trades, 91G (77.8%) contra 71.8% esperado sin ventaja, +$40.42,
  p≈0.07 (todavía no concluyente). Con precio ≥ $0.60: 108 trades, 81.5%, p≈0.03
  (elegido después de ver los datos, tomarlo con cuidado).

## Cambios aplicados

| Fecha (UTC) | Cambio | Evidencia | Revertir si |
|---|---|---|---|
| 01/10 11:53 | `FAIR_GATE_EDGE` 0.08 → 0.06 | Rechazos con 5–8 pts: 18 de 20 habrían ganado (≈ +$16) | Tras 30 trades que entraron con 6–8 pts, P&L negativo o acierto por debajo del precio promedio |
| 01/10 12:52 | `MIN_ENTRY_PRICE` 0.35 → 0.59 | Entradas < $0.60: 3G 6P, −$16.26 (9 trades) | Tras 20 señales rechazadas por el mínimo con resultado conocido, P&L hipotético positivo |
| 01/10 13:00 | `FAIR_VOL_MULT` se mantiene en 1.4 | 1.636 mercados: en 60–90% el modelo está calibrado; con 1.6 el filtro habría sacado 61 trades (50 ganados) | — |
| 01/10 13:45 | `watchPatterns` en `railway.toml` | Que la bitácora no reinicie el bot | Si un deploy necesario no se dispara |

## En observación

- Trades que entran con 6–8 pts de ventaja (desde 01/10 11:53): 2G 0P.
- Rechazos por `MIN_ENTRY_PRICE` (desde 01/10 12:52): anotar el resultado de cada mercado.
- Trades con más de 20 pts de ventaja del modelo: 4G 3P desde 28/09 (el modelo prometía ~88%).
  Candidato a filtro si se sostiene con más casos.
- Filtro de libro (no activo): con 10 s y umbral 0.30, ≈ +$9.6 en 22 trades. Esperar ~40.

## Preparación para dinero real

Antecedentes: en julio el live acertó ~52% contra 64% en paper y las órdenes GTC se
llenaron 29% de las veces; en septiembre el 72.8% de las órdenes no se llenó. El paper actual
supone que toda orden se llena al precio de venta del libro, así que la ejecución real es el
riesgo principal.

- [ ] Desactivar `ELITE_MODE` (apuesta hasta el 80% del saldo en una señal).
- [ ] Límite de pérdida diaria y pausa manual (kill switch) por variable.
- [ ] Cobro automático de posiciones ganadoras (redeem vía `builder-relayer-client`; necesita
      credenciales del relayer) o, mientras tanto, cobro manual diario en Polymarket.
- [ ] Registro de ejecución real: llenado, precio obtenido contra precio esperado, y el
      resultado hipotético de cada señal que no se llenó (para comparar paper contra real).
- [ ] Alertas por Discord: pausas, pérdida diaria, caídas, errores de órdenes.
- [ ] Verificar saldo, allowance y tamaño mínimo de orden con una orden chica.
- [ ] Criterios de salida a real acordados con el usuario (capital, pérdida diaria máxima).
