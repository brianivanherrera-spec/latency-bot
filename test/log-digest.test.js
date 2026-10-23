/**
 * Resumen por hora de los logs [RESUMEN] (src/log-digest.js).
 * Uso: node test/log-digest.test.js
 */
'use strict';
const assert = require('assert');
const { LogDigest, msToNextEmit } = require('../src/log-digest');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const has = (txt, part, msg) => ok(txt.includes(part), `${msg || part}\n  en: ${txt}`);

const T0 = Date.UTC(2026, 9, 16, 13, 20, 0);
const d = new LogDigest(T0);
const mkt = 'Oct 16, 9:35AM-9:40AM ET';
const bal = (pnl, w, l, at, fi, r, rw, rl, r2, r2w, r2l, open = 0) =>
  `[PAPER-B] Balance B: ${pnl} | W:${w} L:${l} (58.5%) | intentos ${at}, llenadas ${fi}, sin fill ${at - fi}, abiertas ${open} | a +400ms llenaban 80 (solo a 400 ms: 1) | con el libro REST: ${r} (${rw}-${rl}); 2 llenadas que con REST no llenaban, 0 que solo llenaba el REST | límite justo | con el REST a +200ms: ${r2} (${r2w}-${r2l}); 1 llenadas que con el REST a +200ms no llenaban, 0 que solo llenaba ese REST (desde 2026-10-12T12:35 UTC) | desde 2026-10-08T14:49 UTC`;

// Balance B al arrancar = base de la primera ventana
d.observe('info', 'PAPER-B', bal('+$21.88', 48, 34, 93, 82, '+$6.85', 44, 33, '+$10.26', 41, 30).slice('[PAPER-B] '.length));
// B: un intento que pierde y uno que gana
d.observe('info', 'PAPER-B', `DOWN ${mkt} | 45 s restantes | ask $0.49 vs precio justo anclado 60.1% (ventaja 9.6 pts) | ask hace 3 s $0.48 | ask a +400ms $0.49`);
d.observe('info', 'PAPER-B', `LOSS DOWN ${mkt} @ $0.49 ×10 → −$4.57 (comisión $0.18) | P&L B +$17.31 (48-35)`);
d.observe('info', 'PAPER-B', `UP Oct 16, 9:40AM-9:45AM ET | 60 s restantes | ask $0.40 vs precio justo anclado 55.0% (ventaja 12.0 pts) | NO ENTRA: segunda conexión distinta`);
d.observe('info', 'PAPER-B', `WIN UP Oct 16, 9:45AM-9:50AM ET @ $0.55 ×10 → +$4.32 (comisión $0.18) | P&L B +$21.63 (49-35)`);
d.observe('info', 'PAPER-B', bal('+$21.63', 49, 35, 95, 84, '+$7.10', 45, 34, '+$10.01', 42, 31).slice('[PAPER-B] '.length));
// A: una ganada y una pérdida anticipada
d.observe('info', 'TRACKER', '[WIN] Posicion cerrada: POS_1');
d.observe('info', 'TRACKER', '   Resultado: YES | PnL: +$1.2 | comisión $0.0500');
d.observe('info', 'TRACKER', '   P&L Total acumulado: +$14.10 | W:270 L:101');
d.observe('info', 'TRACKER', '[LOSS] [POSITION-MONITOR] Posicion cerrada anticipadamente: POS_2');
d.observe('info', 'TRACKER', '   Razón: stop | PnL: $-3.2');
d.observe('info', 'TRACKER', '   P&L Total acumulado: +$10.90 | W:270 L:102');
// Salud
d.observe('warn', 'POLY-WS', '[WATCHDOG] muda: 2100 ms sin datos de los tokens y la segunda recibió datos hace 120 ms — reconectando');
d.observe('warn', 'POLY-WS', '[WATCHDOG] top viejo: Sí $0.51 con un dato del servidor de hace 4200 ms y la segunda $0.55 de hace 80 ms, 3 s seguidos — reconectando');
d.observe('warn', 'POLY-WS', 'Desconectado (code=1013 slow consumer)');
d.observe('info', 'LOOP', 'corte 1013 | lag p50=1ms p99=900ms máx=900ms | CPU 99%');
d.observe('info', 'WS-DUAL', 'WS1 cortada (code=1013) | WS2 conectada');
d.observe('warn', 'BINANCE-WS', '[WATCHDOG] Binance sin datos hace 12000ms y sin pong en 3000ms — reconectando');
d.observe('info', 'BINANCE-WS', '[WATCHDOG] Binance: 6000 ms sin operaciones, contestó el ping en 40 ms — sigue conectado');
d.observe('warn', 'POLYBOLT', '[POLYBOLT] Sin datos (10 s) — reconectando');
d.observe('info', 'MAIN', `[STRIKE] ${mkt} | strike_source=chainlink_twap (rtds) | strike TWAP=$67000.00 | Binance@apertura=$67010.00 | diferencia=+10.00 | base BN−CL=$9.00 | strike=$67000.00 | espera=1.4s`);
d.observe('warn', 'MAIN', `[STRIKE] ${mkt} | strike_source=binance | strike TWAP=n/a | Binance@apertura=$67010.00 | diferencia=n/a | base BN−CL=n/a | strike=$67001.00 | espera=2.3s`);
d.observe('info', 'PTB', `[PTB-CHECK] ${mkt} | real=UP | priceToBeat=67000.00 | Δ vs spot=+3.10 TWAP60=+0.00 RTDS=+0.00 | predice: spot=UP TWAP60=UP RTDS=UP ptb+TWAP=UP ptb+RTDS=UP | PolyBolt=+0.00 (pred. UP)`);
d.observe('info', 'PTB', `[PTB-CHECK] ${mkt} | real=DOWN | priceToBeat=67000.00 | Δ vs spot=−1.00 TWAP60=-1.20 RTDS=-1.20 | predice: spot=DOWN TWAP60=DOWN RTDS=DOWN ptb+TWAP=DOWN ptb+RTDS=DOWN | PolyBolt=-1.20 (pred. DOWN)`);
d.observe('info', 'BOOK-CHECK', '[BOOK-CHECK] últimos 15 min, libro del WS vs API REST de Polymarket (Sí y No, cada 30 s): n=60 | iguales 58 (96.7%) | 1¢ de diferencia 2 (3.3%)');
d.observe('info', 'BOOK-CHECK', '[BOOK-CHECK] últimos 15 min, libro del WS vs API REST de Polymarket (Sí y No, cada 30 s): n=60 | iguales 59 (98.3%) | 1¢ de diferencia 1 (1.7%)');
d.observe('warn', 'BOOK-CHECK', '[BOOK-CHECK] ⚠️ Sí WS $0.50 vs REST $0.52 (WS al día: diferencia REAL)');
d.observe('info', 'LOOP', 'lag p50=1.1ms p99=12.4ms máx=30ms | bloqueos>200ms=0 (peor 0ms) | CPU 7% | heap 80MB | retraso WS p50=40ms p99=300ms máx=900ms (n=500)');
d.observe('info', 'LOOP', 'lag p50=1.1ms p99=60.0ms máx=90ms | bloqueos>200ms=0 (peor 0ms) | CPU 9% | heap 80MB | retraso WS p50=40ms p99=1200ms máx=3500ms (n=500)');
d.observe('info', 'SERIE', `[SERIE btc15m] ${mkt} | ganó UP | strike $67000.00 | 900 muestras (890 con modelo; REST p50 80 ms`);
d.observe('info', 'SERIE', `[SERIE eth5m] ${mkt} | ganó DOWN | strike $2500.00 | 300 muestras (0 con modelo; REST p50 80 ms`);
d.observe('info', 'SERIE', `[SERIE eth15m] ${mkt} | ganó UP | strike $2500.00 | 900 muestras (899 con modelo; REST p50 80 ms`);
d.observe('info', 'BACKTEST', '[BACKTEST-B-HIPOTESIS] (i) n=16 …');
d.observe('warn', 'RTDS', 'Alta latencia: 900ms');
d.observe('warn', 'POLY-WS', 'Reconectando en 1000ms...');
d.observe('warn', 'CHAINLINK-SPOT', '[SPOT] Desconectado (1006). Reconectando...');
d.observe('warn', 'BINANCE-WS', 'Coinbase desconectado (1006). Reconectando en 1000ms...');
d.observe('warn', 'MAIN', '[PAPER] ⚠️ Sin fill: ask $0.80 > precio de orden $0.77');
d.observe('warn', 'FOO', 'algo raro 1 pasó');
d.observe('warn', 'FOO', 'algo raro 2 pasó');
d.observe('error', 'MAIN', '[ERROR] se rompió algo');
d.observe('info', 'SERIE', '[SERIE btc15m] [PAPER-B15] ✅ cuenta en paper con la regla de B en vivo: límite justo margen 2 pts | Balance B15: +$0.00 (0-0), intentos 0, llenadas 0, sin fill 0, abiertas 0 | desde 2026-10-16T15:00 UTC');
d.observe('info', 'SERIE', '[SERIE btc15m] [PAPER-B15] UP Oct 16, 1:30PM-1:45PM ET | 100 s restantes | ask $0.50 vs precio justo anclado 64.5% (ventaja 12.7 pts) | orden 8 a $0.60 | ask a +200ms $0.50 → lleno a $0.50 (ventaja al precio pagado 12.7 pts) | Balance B15: +$0.00 (0-0), intentos 1, llenadas 1, sin fill 0, abiertas 1 | desde 2026-10-16T15:00 UTC');
d.observe('info', 'SERIE', '[SERIE btc15m] [PAPER-B15] DOWN Oct 16, 1:45PM-2:00PM ET | 90 s restantes | ask $0.45 vs precio justo anclado 60.0% (ventaja 11.2 pts) | orden 9 a $0.56 | ask a +200ms $0.60 → no llena | Balance B15: +$0.00 (0-0), intentos 2, llenadas 1, sin fill 1, abiertas 1 | desde 2026-10-16T15:00 UTC');
d.observe('info', 'SERIE', '[SERIE btc15m] [PAPER-B15] LOSS UP Oct 16, 1:30PM-1:45PM ET @ $0.50 ×8 → −$4.14 (comisión $0.14) | Balance B15: −$4.14 (0-1), intentos 2, llenadas 1, sin fill 1, abiertas 0 | desde 2026-10-16T15:00 UTC');
// Cuenta B15 de ETH 15 min: va en su propio ítem y no se mezcla con la de BTC
d.observe('info', 'SERIE', '[SERIE eth15m] [PAPER-B15] DOWN Oct 16, 1:30PM-1:45PM ET | 80 s restantes | ask $0.60 vs precio justo anclado 72.0% (ventaja 10.3 pts) | orden 8 a $0.65 | ask a +200ms $0.60 → lleno a $0.60 (ventaja al precio pagado 10.3 pts) | Balance B15: +$0.00 (0-0), intentos 1, llenadas 1, sin fill 0, abiertas 1 | desde 2026-10-19T21:00 UTC');
d.observe('info', 'SERIE', '[SERIE eth15m] [PAPER-B15] WIN DOWN Oct 16, 1:30PM-1:45PM ET @ $0.60 ×8 → +$3.06 (comisión $0.14) | Balance B15: +$3.06 (1-0), intentos 1, llenadas 1, sin fill 0, abiertas 0 | desde 2026-10-19T21:00 UTC');
// Cuenta B1H (BTC horario, 23/10): su propio ítem, con su etiqueta
d.observe('info', 'SERIE', '[SERIE btc1h] [PAPER-B1H] UP Oct 16, 9AM ET | 60 s restantes | ask $0.55 vs precio justo anclado 66.0% (ventaja 9.2 pts) | orden 9 a $0.62 | ask a +200ms $0.55 → lleno a $0.55 (ventaja al precio pagado 9.2 pts) | Balance B1H: +$0.00 (0-0), intentos 1, llenadas 1, sin fill 0, abiertas 1 | desde 2026-10-23T16:00 UTC');
d.observe('info', 'SERIE', '[SERIE btc1h] [PAPER-B1H] LOSS UP Oct 16, 9AM ET @ $0.55 ×9 → −$5.11 (comisión $0.16) | Balance B1H: −$5.11 (0-1), intentos 1, llenadas 1, sin fill 0, abiertas 0 | desde 2026-10-23T16:00 UTC');
d.observe('info', 'SERIE', '[SERIE btc1h] Oct 16, 9AM ET | ganó DOWN | strike $100000.00 | 3599 muestras (0 con modelo; REST p50 80 ms');
d.observe('info', 'RESUMEN', '[RESUMEN] cuentas — no se cuenta a sí mismo: [WATCHDOG] muda:');

const [c1, s1] = d.report(T0 + 3600000);
has(c1, '[RESUMEN] cuentas 13:20-14:20 UTC (desde el arranque)', 'ventana y arranque');
has(c1, 'A: 1-1 −$2.00; total +$10.90 (270-102)', 'A de la hora y total');
has(c1, 'B: 1-1 −$0.25 (', 'B de la hora');
has(c1, '(intentos 2, llenadas 2; REST +$0.25 (1-1), REST +200ms −$0.25 (1-1))', 'diferencias del Balance B');
has(c1, 'total +$21.63 (49-35), REST +$7.10 (45-34), REST +200ms +$10.01 (42-31), abiertas 0', 'B total');
has(c1, `pérdidas B: DOWN ${mkt} a $0.49 (45 s, 9.6 pts) −$4.57`, 'pérdida de B con T y ventaja');
ok(!c1.includes('9:40AM-9:45AM'), 'el NO ENTRA no cuenta como intento');
has(c1, 'B15: intentos 2, llenadas 1, 0-1 −$4.14; total −$4.14 (0-1), intentos 2, llenadas 1, abiertas 0; pérdidas: UP Oct 16, 1:30PM-1:45PM ET a $0.50 −$4.14', 'cuenta B15');
has(s1, 'atrasada 0, muda 1, top viejo 1, en pausa 0', 'reconexiones (y no se cuenta a sí mismo)');
has(s1, 'cortes WS1 1 (1013 1)', 'cortes de la principal');
has(s1, 'PolyBolt silencios 1; Binance reconexiones 1 (tope 0, sin pong 1), ping contestado 1', 'feeds');
has(s1, 'strike 2 (no chainlink 1, espera máx 2.3 s)', 'strike');
has(s1, 'PTB-CHECK 2 (Δ≠0 1, máx RTDS 1.20, PolyBolt 1.20)', 'PTB');
has(s1, 'BOOK-CHECK mín 96.7% prom 97.5%, diferencias REALES 1', 'BOOK-CHECK');
has(s1, 'LOOP 2 min: retraso WS p99 máx 1200 ms, máx 3500 ms; lag p99 máx 60 ms; CPU máx 9%; minutos fuera de umbral 1', 'LOOP sin la línea del corte');
has(c1, 'B15 ETH: intentos 1, llenadas 1, 1-0 +$3.06; total +$3.06 (1-0), intentos 1, llenadas 1, abiertas 0', 'cuenta B15 de ETH aparte');
ok(c1.indexOf('B15: ') < c1.indexOf('B15 ETH: '), 'B15 de BTC primero');
has(s1, 'SERIE btc15m 1, eth15m 1 (0 con modelo 0), eth5m 1 (0 con modelo 1), btc1h 1 (0 con modelo 1), 429 0; corrió backtest sí, ejecución no', 'series y corridas');
has(c1, 'B1H: intentos 1, llenadas 1, 0-1 −$5.11; total −$5.11 (0-1), intentos 1, llenadas 1, abiertas 0; pérdidas: UP Oct 16, 9AM ET a $0.55 −$5.11', 'cuenta B1H aparte');
ok(c1.indexOf('B15 ETH: ') < c1.indexOf('B1H: '), 'B1H después de las de 15 min');
has(s1, 'WARN 14, ERROR 1', 'conteo de WARN/ERROR');
has(s1, '×2 "[FOO] algo raro 1 pasó"', 'WARN desconocidos agrupados');
has(s1, 'ERROR ×1 "[MAIN] [ERROR] se rompió algo"', 'ERROR en otros');
ok(!s1.includes('Alta latencia') && !s1.includes('code=1013'), 'los WARN conocidos no van a otros');
ok(!/Reconectando en 1000ms|SPOT\] Desconectado|Coinbase desconectado|Sin fill/.test(s1), 'las reconexiones de rutina tampoco');

// Segunda ventana: vacía, la base del B pasa al último Balance B
d.observe('info', 'PAPER-B', bal('+$21.63', 49, 35, 96, 84, '+$7.10', 45, 34, '+$10.01', 42, 31, 1).slice('[PAPER-B] '.length));
const [c2, s2] = d.report(T0 + 7200000);
has(c2, '[RESUMEN] cuentas 14:20-15:20 UTC |', 'segunda ventana sin "desde el arranque"');
has(c2, 'B: 0-0 +$0.00 (intentos 1, llenadas 0; REST +$0.00 (0-0), REST +200ms +$0.00 (0-0))', 'base = último Balance B de la ventana anterior');
has(c2, 'abiertas 1', 'posición abierta');
has(c2, 'pérdidas B: ninguna');
has(c2, 'B15: intentos 0, llenadas 0, 0-0 +$0.00; total −$4.14 (0-1)', 'B15 sin movimiento: queda el total');
has(c2, 'B15 ETH: intentos 0, llenadas 0, 0-0 +$0.00; total +$3.06 (1-0)', 'B15 ETH sigue en el resumen con su total');
has(s2, 'muda 0, top viejo 0', 'contadores en cero');
has(s2, 'LOOP 0 min: retraso WS p99 máx n/a', 'sin datos: n/a');
has(s2, 'BOOK-CHECK n/a');
has(s2, 'otros: ninguno');

// Próxima emisión a los :20 UTC
ok(msToNextEmit(Date.UTC(2026, 9, 16, 13, 19, 0)) === 60000, 'falta 1 min');
ok(msToNextEmit(Date.UTC(2026, 9, 16, 13, 20, 0)) === 3600000, 'justo a los :20 → la próxima hora');
ok(msToNextEmit(Date.UTC(2026, 9, 16, 23, 50, 0)) === 30 * 60000, 'pasa de día');

console.log(`log-digest: ${n} ok`);
