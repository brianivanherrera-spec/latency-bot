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
| 01/10 18:40 | `FAIR_GATE_EDGE` 0.06 → 0.08 (vuelta atrás, OK del usuario) | Trades con 6–8 pts desde 11:53: 4G 5P, −$16.91; con ≥ 8 pts siguieron bien | — |
| 01/10 18:40 | Shadow: estrategia "ventana 60–120 s" (solo registro, `window` en SHADOW-JSON) | Backtest 1.706 mercados: 76% a $0.63, +13 ¢/token (91 casos) | Evaluar con ≥ 60 casos nuevos |
| 02/10 ~12:50 | Strike = TWAP 60 s de Chainlink en la apertura (`strike_source=chainlink_twap`), antes Binance en la apertura (errado $5–30+). Reintento cada 500 ms hasta 10 s sin señales; si no llega, Binance − base (`binance_ajustado`). Respaldo del FAIR, `[MARKET-RESULT]` y `[SIGNAL-MONITOR]` comparan Binance − base | Pedido del usuario: priceToBeat = TWAP RTDS en la apertura (al centavo); base Binance−Chainlink ≈ $17 | Si el `[STRIKE]` no coincide con el priceToBeat de Gamma al cierre |
| 02/10 ~17:30 | **Bloque A (revisión 02/10)**, solo arreglos, sin cambios de estrategia: (A1) `depthInfo` declarado fuera del `try` del live; (A2) snapshot `mkt` del mercado para todo el flujo de entrada (antes `cachedMarket` podía cambiar o quedar en null a mitad del flujo); (A3) `unhandledRejection`/`uncaughtException` con stack y Discord, `actualizarPrecioPolymarket` con try/catch y bandera de ocupado, callback de Binance protegido; (A4) timeouts en todos los fetch/axios (Gamma/CLOB 3 s, cliente CLOB 10 s, resto 5 s); (A5) NO_FILL ya no cuenta como pérdida (stats, racha de pérdidas y W/L del tracker, que al arrancar se reconstruye de signals.jsonl contando solo WIN/LOSS); (A6) `SIGNALS_FILE` → `SIGNAL_FILE` (resumen diario y tiempo de fill fallaban); (A7) el cierre del mercado lo hace la rotación (`endMarket`, `[MARKET-RESOLUTION]`, `MARKET_END` de phase2, vacía `marketSignalLog`), antes dependía de un evento WS que no llega (`[MKT] markets=50/0`); (A8) clave única para todo salvo `/health` (`?key=` o `Authorization: Bearer`), comparación en tiempo constante, `/phase2-status` cuenta líneas por stream. El valor por defecto de `DOWNLOAD_SECRET` sigue (lo saca el usuario después de cargar la clave nueva) | Revisión completa del código del 02/10 | Si el deploy no arranca limpio, o si `[MKT] markets=X/Y` no avanza en Y, o si el W/L del tracker no coincide con signals.jsonl |
| 01/10 13:00 | `FAIR_VOL_MULT` se mantiene en 1.4 | 1.636 mercados: en 60–90% el modelo está calibrado; con 1.6 el filtro habría sacado 61 trades (50 ganados) | — |
| 01/10 13:45 | `watchPatterns` en `railway.toml` | Que la bitácora no reinicie el bot | Si un deploy necesario no se dispara |
| 01/10 14:45 | Etapa 0 aprobada por el usuario: `ELITE_MODE=false` (y apagado por defecto en el código); `MAX_DAILY_LOSS_USDC` y `TRADING_PAUSED` nuevos, sin definir (no cambian nada en paper) | Protecciones para dinero real | — |

## En observación

- Liquidez en paper (desde 01/10 ~15:45): cuántas entradas quedan sin fill por falta de tokens en el mejor ask (`[PAPER-LIQ] … NO alcanza`).

- Saltos del modelo en la apertura (visto 01/10 20:35, 21:00, 21:05): con σ muy baja (~15e-6),
  FAIR pasa a 0.98–1.0 o 0.095 en los primeros 30–60 s sin que BTC se mueva y marca ventajas
  falsas de 30–47 pts. En 1.696 mercados, con σ < 25e-6 las señales del modelo con ≥ 8 pts
  aciertan 54% a $0.61 (pierden), contra 70% con σ 25–40. Los trades reales del bot con σ baja
  van bien (28, 82%). Propuesta pendiente de OK: piso de σ o tope a |z| al abrir, probado
  antes en shadow.
- Rechazos por `MIN_ENTRY_PRICE` (desde 01/10 12:52): anotar el resultado de cada mercado.
- Trades con más de 20 pts de ventaja del modelo: 4G 3P desde 28/09 (el modelo prometía ~88%).
  Candidato a filtro si se sostiene con más casos.
- Filtro de libro (no activo): con 10 s y umbral 0.30, ≈ +$9.6 en 22 trades. Esperar ~40.

## Preparación para dinero real

Antecedentes: en julio el live acertó ~52% contra 64% en paper y las órdenes GTC se
llenaron 29% de las veces; en septiembre el 72.8% de las órdenes no se llenó. El paper actual
supone que toda orden se llena al precio de venta del libro, así que la ejecución real es el
riesgo principal.

- [x] Modo ÉLITE eliminado del código (apostaba hasta el 80% del saldo con tope $0.97). Hecho 01/10, a pedido del usuario: siempre tamaño normal.
- [x] Paper exige liquidez: el mejor ask debe tener al menos los tokens de la orden (`PAPER_REQUIRE_DEPTH`, por defecto activo). Log `[PAPER-LIQ]` en cada intento. Hecho 01/10.
- [x] Límite de pérdida diaria (`MAX_DAILY_LOSS_USDC`, día UTC, sobrevive reinicios) y pausa manual (`TRADING_PAUSED=true`). Hecho 01/10; se definen al pasar a real.
- [x] `cancelOrder` recibía `{ orderId }` en 3 lugares (la API pide `orderID`): el cancel por timeout, el de la FOK residual y el del retry-loop no cancelaban. Corregido 01/10.
- [x] **Envío de órdenes reales** (01/10, el usuario prioriza asegurar el fill): `DUAL_FILL_ORDER=true` ya no manda FAK + GTC + GTD juntas. Ahora en secuencia: FAK a ask + 1 centavo; si falta, UNA sola GTD por el remanente al mismo precio que vence al cierre; se sigue cada 2 s hasta el cierre, ahí se cancela y se suma lo llenado (total o parcial). Nunca hay dos órdenes vivas a la vez. Probado con un cliente simulado (lleno total, parcial, sin fill, GTD rechazada). Falta verlo con una orden real.
- [ ] Cobro automático de posiciones ganadoras (redeem vía `builder-relayer-client`; necesita
      credenciales del relayer) o, mientras tanto, cobro manual diario en Polymarket.
- [ ] Registro de ejecución real: llenado, precio obtenido contra precio esperado, y el
      resultado hipotético de cada señal que no se llenó (para comparar paper contra real).
- [ ] Alertas por Discord: pausas, pérdida diaria, caídas, errores de órdenes.
- [ ] Verificar saldo, allowance y tamaño mínimo de orden con una orden chica.
- [ ] Criterios de salida a real acordados con el usuario (capital, pérdida diaria máxima).
