/**
 * Segunda conexión al WS de Polymarket, solo de medición (src/ws-probe.js), con un WebSocket falso.
 * Uso: node test/ws-probe.test.js
 */
'use strict';
process.env.LOG_FILE = 'off';
const assert = require('assert');
const { EventEmitter } = require('events');
const { WsProbe, MsHist } = require('../src/ws-probe');
const { BookCheck } = require('../src/book-check');
const { PolymarketWS } = require('../src/polymarket-ws');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); passed++; };
const flush = () => new Promise(r => setImmediate(r));

// WebSocket falso: guarda lo que se manda y deja emitir eventos a mano
const sockets = [];
class FakeWS extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; this.readyState = 0; this.closed = false; sockets.push(this); }
  send(x) { this.sent.push(x); }
  close() { this.closed = true; }
  terminate() { this.closed = true; this.emit('close', 1006, ''); }
  open() { this.readyState = 1; this.emit('open'); }
  msg(obj) { this.emit('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
}

let clock = 1_800_000_000_000;
const now = () => clock;
const T0 = clock;

// Conexión principal falsa con lo que la segunda lee de ella
const main = {
  _connected: true, _socketTokensKey: 'Y|N', _gotBookSinceHandshake: true, _handshakeAt: T0, _yesTokenId: 'Y', _noTokenId: 'N',
  _marketEndTs: T0 + 300000, _topOfBook: new Map(), _mirror: null, setMirror(m) { this._mirror = m; },
};
const pc = (ts, asset, hash, bid, ask) => ({ event_type: 'price_change', market: 'M', timestamp: String(ts), price_changes: [{ asset_id: asset, price: '0.5', size: '10', side: 'BUY', hash, best_bid: String(bid), best_ask: String(ask) }] });

(async () => {
  // ─── Histograma ───────────────────────────────────────────────────────────────────────────────
  const h = new MsHist();
  for (let i = 1; i <= 100; i++) h.add(i);
  eq([h.q(0.5), h.q(0.99), h.max, h.n], [50, 99, 100, 100], 'p50/p99/máx exactos debajo de 1 s');
  h.add(4321);
  ok(h.q(1) === 4321 && h.max === 4321, 'arriba de 1 s: borde del balde con tope en el máximo');
  h.add(-5); ok(h.q(0) === 0, 'negativo (reloj) cuenta como 0');
  eq(new MsHist().q(0.5), null, 'sin muestras');

  // ─── Suscripción: sigue los tokens de la principal ─────────────────────────────────────────────
  const p = new WsProbe({ WebSocketImpl: FakeWS, now, maxCloses: 3 });
  p.attach(main);
  ok(main._mirror === p, 'se engancha en la principal');
  eq(sockets.length, 1, 'abre una conexión con los tokens de la principal');
  const s1 = sockets[0];
  eq(s1.opts.perMessageDeflate, true, 'mismas opciones que la principal');
  s1.open();
  eq(JSON.parse(s1.sent[0]), { assets_ids: ['Y', 'N'], type: 'market', custom_feature_enabled: true }, 'handshake del canal market');
  ok(p.live && p.top('Y') === null, 'sin libro todavía');
  // Sin snapshot ni 2 s de asentamiento no compara mensajes
  p.mainEvents([pc(T0 - 10, 'Y', 'h0', 0.5, 0.51)], clock);
  eq(p._pend.size, 0, 'antes del libro de la segunda no anota');
  s1.msg([{ event_type: 'book', asset_id: 'Y', timestamp: String(clock - 20), bids: [{ price: '0.48', size: '5' }, { price: '0.50', size: '3' }], asks: [{ price: '0.53', size: '4' }, { price: '0.51', size: '2' }, { price: '0.52', size: '0' }] },
    { event_type: 'book', asset_id: 'N', timestamp: String(clock - 20), bids: [{ price: '0.49', size: '1' }], asks: [{ price: '0.50', size: '1' }] }]);
  await flush();
  eq(p.top('Y').bid, 0.50, 'top del snapshot: mejor bid'); eq(p.top('Y').ask, 0.51, 'mejor ask (ignora tamaño 0)');
  ok(p._gotBook, 'snapshot recibido');
  p.mainEvents([pc(clock, 'Y', 'h1', 0.5, 0.51)], clock);
  eq(p._pend.size, 0, 'menos de 2 s desde el handshake: no anota');
  clock += 2500;

  // ─── Quién llega antes ─────────────────────────────────────────────────────────────────────────
  const t = clock;
  p.mainEvents([pc(t - 30, 'Y', 'h2', 0.5, 0.51)], t);          // WS1 primero...
  clock = t + 5; s1.msg(pc(t - 30, 'Y', 'h2', 0.5, 0.51)); await flush(); // ...y WS2 5 ms después
  clock = t + 10; s1.msg(pc(t - 2000, 'N', 'h3', 0.49, 0.5)); await flush(); // WS2 primero...
  p.mainEvents([pc(t - 2000, 'N', 'h3', 0.49, 0.5)], t + 3010);  // ...y WS1 3 s después
  clock = t + 20; s1.msg(pc(t, 'Y', 'h4', 0.5, 0.51)); await flush();
  p.mainEvents([pc(t, 'Y', 'h4', 0.5, 0.51)], t + 20);           // empate
  p.mainEvents([pc(t, 'Y', 'h4', 0.5, 0.51)], t + 21);           // repetido por la principal: nueva pendiente
  p.mainEvents([{ event_type: 'best_bid_ask', asset_id: 'Y', timestamp: String(t), best_bid: '0.5', best_ask: '0.51' }], t + 30);
  clock = t + 35; s1.msg({ event_type: 'best_bid_ask', asset_id: 'Y', timestamp: String(t), best_bid: '0.5', best_ask: '0.51' });
  clock = t + 40; await flush(); // la llegada es la del evento 'message' (t+35), no la del proceso
  p.mainEvents([{ event_type: 'last_trade_price', asset_id: 'N', timestamp: String(t), price: '0.5', size: '7', side: 'BUY' }], t + 50);
  p.mainEvents([{ event_type: 'last_trade_price', asset_id: 'N', timestamp: String(t), price: '0.5', size: '7', side: 'BUY' }], t + 50); // repetido por la misma: se ignora
  eq([p.m.both, p.m.first1, p.m.first2, p.m.ties], [4, 2, 1, 1], 'pares: dos antes por WS1 (cambio y bba), uno por WS2 y un empate');
  ok(p.m.lead1.max === 5 && p.m.lead2.max === 3000, `ventajas: WS1 5 ms, WS2 3000 ms (${p.m.lead1.max}, ${p.m.lead2.max})`);
  ok(p.m.lag1.n >= 4 && p.m.lag2.n >= 4, 'retraso de cada conexión');
  ok(p.m.lag1.max >= 5010, `retraso máx de WS1 ≥ 5 s (${p.m.lag1.max})`);

  // ─── Llegaron por una sola ─────────────────────────────────────────────────────────────────────
  clock = t + 60;
  s1.msg(pc(t + 55, 'N', 'solo2', 0.49, 0.5)); await flush();
  clock = t + 9000; p._tick();
  eq([p.m.only1, p.m.only2], [0, 0], 'antes de 10 s siguen pendientes');
  clock = t + 10100; p._tick();
  eq([p.m.only1, p.m.only2], [2, 1], 'vencidas: el repetido y el trade por WS1, uno por WS2');
  eq(p._pend.size, 0, 'sin pendientes');

  // ─── Top distinto entre las dos ─────────────────────────────────────────────────────────────────
  main._topOfBook.set('Y', { bestBid: 0.67, bestAsk: 0.68, topTs: clock - 2400 });
  main._topOfBook.set('N', { bestBid: 0.49, bestAsk: 0.50, topTs: clock - 10 });
  s1.msg(pc(clock - 100, 'Y', 'h9', 0.60, 0.62)); await flush();
  p._tick(); clock += 1000; p._tick(); clock += 1000; p._tick(); clock += 1000; p._tick();
  eq(p.m.topDiff, [4, 0], 'Sí distinto 4 s, No igual');
  eq([p.m.stale1, p.m.stale2], [4, 0], 'el dato más viejo era el de WS1');
  eq(p.m.warns, 1, 'un aviso a los 3 s');
  main._topOfBook.set('Y', { bestBid: 0.60, bestAsk: 0.62, topTs: clock });
  p._tick();
  eq(p._diffRun, [0, 0], 'igual de nuevo: se reinicia la racha');

  // ─── Línea por minuto ─────────────────────────────────────────────────────────────────────────
  const r = p.report();
  ok(/^\[WS-DUAL\] retraso p50\/p99\/máx: WS1 \d+\/\d+\/\d+ ms \(n=\d+\), WS2 /.test(r), r);
  ok(/por las dos 4: antes por WS1 2 \(p99 5 ms, máx 5 ms\), antes por WS2 1 \(p99 3000 ms, máx 3000 ms\), empate 1/.test(r), r);
  ok(/solo por WS1 2, solo por WS2 1 \| top distinto Sí 4 s, No 0 s \(dato más viejo en WS1 4, en WS2 0\) \| cortes WS1 0, WS2 0 \| WS2 sin conexión 0 s \| /.test(r), r);
  // Agregado al final: ventaja típica y "solo por" por tipo, con su par por la otra conexión
  ok(/\| ventaja p50: WS1 5 ms, WS2 3000 ms \| /.test(r), r);
  ok(/\| solo por \(precio\/top\/trade\): WS1 1\/0\/1, WS2 1\/0\/0; con su par por la otra con otro timestamp: WS1 0\/0\/0, WS2 0\/0\/0$/.test(r), r);
  p._reset();
  eq([p.m.onlyT, p.m.pairT], [[{ p: 0, b: 0, t: 0 }, { p: 0, b: 0, t: 0 }], [{ p: 0, b: 0, t: 0 }, { p: 0, b: 0, t: 0 }]], 'reinicio por minuto');
  ok(/ventaja p50: WS1 —, WS2 — \| solo por \(precio\/top\/trade\): WS1 0\/0\/0, WS2 0\/0\/0; /.test(p.report()), 'minuto vacío');

  // ─── Mismo contenido con otro timestamp: "solo por" las dos, cada uno con su par ────────────────
  p._pend.clear(); p._solo.forEach(S => S.clear()); // sin el h9 de la sección anterior
  const u = clock;
  p.mainEvents([pc(u, 'Y', 'h7', 0.5, 0.51)], u);
  clock = u + 3; s1.msg(pc(u + 1, 'Y', 'h7', 0.5, 0.51)); await flush();         // mismo cambio, otro timestamp
  clock = u + 4; s1.msg({ event_type: 'best_bid_ask', asset_id: 'N', timestamp: String(u), best_bid: '0.3', best_ask: '0.31' }); await flush();
  clock = u + 10100; p._tick();
  eq([p.m.only1, p.m.only2], [1, 2], 'tres sin par de clave');
  eq([p.m.onlyT[0], p.m.onlyT[1]], [{ p: 1, b: 0, t: 0 }, { p: 1, b: 1, t: 0 }], 'por tipo');
  eq([p.m.pairT[0], p.m.pairT[1]], [{ p: 1, b: 0, t: 0 }, { p: 1, b: 0, t: 0 }], 'el cambio h7 llegó por las dos con otro timestamp; el top solo por WS2');
  eq([p._solo[0].size, p._solo[1].size], [0, 1], 'queda el top sin par (el par se borra al contarse)');
  clock += 20001; p._lastData = clock; p._tick(); // con datos: que no salte el control de 20 s sin datos
  eq([p._solo[0].size, p._solo[1].size], [0, 0], 'los "solo por" vencen a los 2×graceMs');
  p._reset();

  // ─── Ask de la segunda al decidir (A y B) ─────────────────────────────────────────────────────
  const sn = p.snap('Y');
  ok(sn && sn.ask === 0.51 && sn.age === 10100 + 20001 - 3, `snap con libro: ${JSON.stringify(sn)}`);
  eq(p.snap('X'), { ask: null }, 'token sin libro');
  eq(p.vs({ ask: 0.43, age: 120 }, 0.40, 0.43), '$0.43 (igual al REST, dato de hace 120 ms)', 'WS principal viejo, la segunda al día');
  eq(p.vs({ ask: 0.43, age: 5 }, 0.43, 0.43), '$0.43 (igual a los dos, dato de hace 5 ms)', 'las tres iguales');
  eq(p.vs({ ask: 0.40, age: 900 }, 0.40, 0.43), '$0.40 (igual al WS principal, dato de hace 900 ms)', 'atrasadas las dos');
  eq(p.vs({ ask: 0.42, age: 1 }, 0.40, 0.43), '$0.42 (a 1¢ del REST, dato de hace 1 ms)', 'a 1¢');
  eq(p.vs({ ask: 0.45, age: 1 }, 0.40, 0.43), '$0.45 (distinto de los dos, dato de hace 1 ms)', 'distinto');
  eq(p.vs({ ask: 0.45, age: 1 }, 0.40, null), '$0.45 (distinto del WS principal, sin REST, dato de hace 1 ms)', 'sin REST');
  eq([p.vs({ down: true }), p.vs({ off: true }), p.vs({ ask: null }), p.vs(null)], ['sin conexión', 'apagada', 'sin libro', 'sin dato'], 'estados');

  // ─── Cortes ─────────────────────────────────────────────────────────────────────────────────────
  p.mainClose(1013);
  eq(p.m.cuts1, [1013], 'corte de la principal');
  s1.emit('close', 1013, Buffer.from('slow consumer: send buffer full'));
  ok(!p.live && p.m.cuts2[0] === 1013 && p._reconnTimer, 'corte de la segunda: reconecta con espera');
  eq(p.top('Y'), null, 'caída: sin top');
  p._tick();
  eq(p.m.down2, 1, 'segundos caída con la principal conectada');
  clearTimeout(p._reconnTimer); p._reconnTimer = null;
  p._connect();
  const s2 = sockets[sockets.length - 1];
  ok(s2 !== s1, 'conexión nueva');
  s2.open();
  // Sin datos 20 s con el mercado abierto → reconecta (y cuenta para el tope)
  clock += 21000; p._tick();
  ok(sockets[sockets.length - 1] !== s2 && s2.closed, 'watchdog: sin datos → conexión nueva');
  ok(p.m.cuts2.includes('sin datos'), 'anotado');
  const s3 = sockets[sockets.length - 1];
  s3.open();
  s3.msg('INVALID OPERATION'); await flush();
  ok(!p.stopped && sockets[sockets.length - 1] !== s3, 'INVALID: reconecta (tercer corte de la hora, tope 3)');
  sockets[sockets.length - 1].emit('close', 1013, Buffer.from(''));
  ok(p.stopped, 'cuarto corte en una hora con tope 3: se apaga sola');
  ok(main._mirror === null, 'se desengancha de la principal');
  eq(p.report().endsWith('APAGADA'), true, 'la línea lo dice');
  const nSock = sockets.length;
  p.mainSubscribe('Y2', 'N2');
  eq(sockets.length, nSock, 'apagada: no vuelve a conectar');

  // ─── Mercado nuevo y mercado cerrado ───────────────────────────────────────────────────────────
  const q = new WsProbe({ WebSocketImpl: FakeWS, now });
  q.attach({ ...main, _mirror: null, setMirror(m) { this._mirror = m; } });
  const a1 = sockets[sockets.length - 1]; a1.open();
  q._pend.set('x', { side: 1, at: clock });
  q.mainSubscribe('Y', 'N', main._marketEndTs);
  ok(sockets[sockets.length - 1] === a1, 'mismos tokens: no reconecta');
  q.mainSubscribe('Y3', 'N3', clock + 300000);
  const a2 = sockets[sockets.length - 1];
  ok(a2 !== a1 && a1.closed && q._pend.size === 0, 'mercado nuevo: cierra la vieja, abre otra y limpia pendientes');
  a2.open();
  eq(JSON.parse(a2.sent[0]).assets_ids, ['Y3', 'N3'], 'handshake con los tokens nuevos');
  clock += 300001;
  a2.emit('close', 1000, Buffer.from('all subscribed assets resolved'));
  ok(!q._reconnTimer && q.m.cuts2.length === 0, 'mercado cerrado: no cuenta ni reconecta');
  q.stop();

  // Cerrar un socket que todavía conecta no tira 'error' sin manejar
  const z = new WsProbe({ WebSocketImpl: FakeWS, now });
  z.mainSubscribe('A', 'B', clock + 300000);
  const zs = sockets[sockets.length - 1];
  z.mainSubscribe('C', 'D', clock + 300000);
  zs.emit('error', new Error('WebSocket was closed before the connection was established'));
  ok(true, 'error después del cierre: manejado');
  z.stop();

  // ─── [BOOK-CHECK] con la segunda conexión ──────────────────────────────────────────────────────
  const top1 = new Map([['Y', { bestBid: 0.67, bestAsk: 0.68, updatedAt: Date.now(), topTs: null }], ['N', { bestBid: 0.32, bestAsk: 0.33, updatedAt: Date.now(), topTs: null }]]);
  const poly = { _connected: true, _yesTokenId: 'Y', _noTokenId: 'N', _topOfBook: top1, _lastLagMs: 20, _lastLagAt: Date.now() };
  const top2 = { Y: { bid: 0.60, ask: 0.62, topTs: null }, N: { bid: 0.32, ask: 0.33, topTs: null } };
  const probe = { top: tok => top2[tok] || null };
  const restBooks = { Y: { bids: [0.60], asks: [0.62] }, N: { bids: [0.38], asks: [0.40] } };
  const fetchFn = async (url) => {
    const b = restBooks[new URL(url).searchParams.get('token_id')];
    return { ok: true, json: async () => ({ timestamp: String(Date.now() - 15), bids: b.bids.map(x => ({ price: String(x), size: '10' })), asks: b.asks.map(x => ({ price: String(x), size: '10' })) }) };
  };
  const bc = new BookCheck({ polyWs: poly, probe, fetchFn, intervalMs: 0 });
  await bc.checkOnce();
  eq([bc.s.n, bc.s.more, bc.s.moreReal], [2, 2, 2], 'las dos diferencias del WS principal');
  eq([bc.s.n2, bc.s.same2, bc.s.more2, bc.s.fix2], [2, 1, 1, 1], 'WS2: Sí igual al REST, No igual al principal');
  const sum = bc.summary();
  ok(/\| WS2 \(medición\): igual al REST 1 de 2, más de 1¢ 1, sin dato 0; en las 2 diferencias de más de 1¢ del WS principal, WS2 coincidía con el REST \(±1¢\) en 1$/.test(sum), sum);
  const bc0 = new BookCheck({ polyWs: poly, fetchFn, intervalMs: 0 });
  ok(!/WS2/.test(bc0.summary()), 'sin segunda conexión el resumen no cambia');

  // ─── Ganchos en la conexión principal ──────────────────────────────────────────────────────────
  const pw = new PolymarketWS();
  const calls = [];
  pw.setMirror({ mainSubscribe: (...a) => calls.push(a) });
  pw.subscribe('Y', 'N', 123);
  eq(calls, [['Y', 'N', 123]], 'cada subscribe llega a la segunda');
  pw.setMirror({ mainSubscribe() { throw new Error('falla de la medición'); } });
  pw.subscribe('Y5', 'N5', 456);
  eq([pw._yesTokenId, pw._noTokenId], ['Y5', 'N5'], 'una falla de la segunda no cambia nada de la principal');
  pw.setMirror(null);
  pw.close();

  // ─── Reconexión de la principal por atraso (bitácora 14/10 ~23:40 ARG) ──────────────────────────
  // freshness() de la segunda: dato más fresco del segundo en curso o del anterior
  clock = 1_800_000_100_000;
  const main3 = { ...main, _socketTokensKey: 'A|B', _yesTokenId: 'A', _noTokenId: 'B', _handshakeAt: clock, _mirror: null };
  const pf = new WsProbe({ WebSocketImpl: FakeWS, now, maxCloses: 3 });
  pf.attach(main3);
  eq(pf.freshness(), { live: false }, 'sin conexión: no está al día');
  const sf = sockets[sockets.length - 1];
  sf.open();
  eq(pf.freshness(), { live: false }, 'sin libro todavía: no cuenta');
  sf.msg({ event_type: 'book', asset_id: 'A', market: 'M', timestamp: String(clock - 900), bids: [{ price: '0.4', size: '5' }], asks: [{ price: '0.42', size: '5' }] });
  await flush();
  ok(pf.freshness().minLag === null, 'el snapshot book no cuenta para el retraso');
  sf.msg(pc(clock - 40, 'A', 'h1', 0.4, 0.42));
  await flush();
  let fr = pf.freshness();
  eq([fr.live, fr.minLag, fr.lastDataAgo], [true, 40, 0], 'al día: el más fresco del segundo llegó con 40 ms');
  clock += 1000;
  ok(pf.freshness().minLag === 40, 'el segundo anterior todavía cuenta');
  clock += 1500;
  fr = pf.freshness();
  eq([fr.minLag, fr.lastDataAgo], [null, 2500], 'sin datos recientes: sin retraso medido');
  pf.stop();
  eq(pf.freshness(), { live: false }, 'apagada');

  // La principal: 3 s seguidos con el dato más fresco de cada segundo ≥ 1000 ms y la segunda al día → reconecta
  const lw = new PolymarketWS();
  let reconnects = 0;
  lw._forceReconnect = () => { reconnects++; };
  let peer = { live: true, lastDataAgo: 100, minLag: 25 };
  lw.setMirror({ freshness: () => peer });
  const L0 = 1_800_000_200_000;
  // segundo s con n mensajes de retraso lag (y uno más fresco si fresh); se evalúa al empezar el segundo s + 2
  const sec = (s, lag, n = 5) => { for (let i = 0; i < n; i++) lw._noteLag(L0 + s * 1000 + 100 + i * 50, lag + i * 10); };
  const check = s => lw._lagCheck(L0 + (s + 1) * 1000 + 30);
  const run = (from, lags, n) => lags.forEach((lag, k) => { sec(from + k, lag, n); check(from + k); });
  lw._lastWatchdogReconnect = 0;
  run(0, [1500, 1600], 5);
  eq([reconnects, lw._lagRun], [0, 2], 'dos segundos atrasados: todavía no');
  run(2, [1700], 5);
  eq(reconnects, 1, 'el tercero seguido reconecta');
  eq([lw._lagRun, lw._lagReconnects.length], [0, 1], 'racha a cero y una reconexión contada');
  check(2);
  eq(reconnects, 1, 'el mismo segundo no se evalúa dos veces');
  // Un segundo al día en el medio corta la racha
  lw._lastWatchdogReconnect = 0;
  run(10, [1500, 1500, 900, 1500, 1500], 5);
  eq([reconnects, lw._lagRun], [1, 2], 'un segundo con el dato más fresco en 900 ms corta la racha');
  // Un segundo sin mensajes (o con menos de 3) también la corta
  for (let k = 15; k < 20; k++) check(k); // el watchdog evalúa cada segundo, también los que no traen mensajes
  eq(lw._lagRun, 0, 'segundos sin mensajes: racha a cero');
  run(20, [1500, 1500], 5); check(22); run(23, [1500, 1500], 5);
  eq([reconnects, lw._lagRun], [1, 2], 'un segundo sin mensajes corta la racha');
  lw._lagRun = 0;
  run(30, [1500, 1500], 5); run(32, [1500], 2); run(33, [1500, 1500], 5);
  eq([reconnects, lw._lagRun], [1, 2], 'con 2 mensajes el segundo no cuenta');
  // La segunda también atrasada, sin datos recientes o caída: no reconecta (sería el servidor o el proceso)
  lw._lagRun = 0;
  for (const p2 of [{ live: true, lastDataAgo: 100, minLag: 800 }, { live: true, lastDataAgo: 2500, minLag: 25 }, { live: true, lastDataAgo: 100, minLag: null }, { live: false }, null]) {
    peer = p2; lw._lagRun = 0;
    run(40 + 10 * reconnects, [1500, 1500, 1500, 1500], 5);
  }
  eq(reconnects, 1, 'sin la segunda al día no reconecta');
  lw.setMirror(null); lw._lagRun = 0;
  run(120, [1500, 1500, 1500], 5);
  eq(reconnects, 1, 'sin segunda conexión no reconecta');
  // Con la segunda al día de nuevo, la racha que ya venía reconecta al segundo siguiente
  peer = { live: true, lastDataAgo: 100, minLag: 25 };
  lw.setMirror({ freshness: () => peer });
  run(130, [1500], 5);
  eq(reconnects, 2, 'la racha sigue y reconecta cuando la segunda está al día');
  // Como mucho una cada 10 s (el watchdog) y 6 por hora
  run(140, [1500, 1500, 1500], 5);
  eq(reconnects, 2, 'dentro de los 10 s del watchdog no reconecta otra vez');
  lw._lagReconnects = Array.from({ length: 6 }, (_, k) => L0 + 150_000 + k);
  lw._lastWatchdogReconnect = 0; lw._lagRun = 0;
  run(160, [1500, 1500, 1500], 5);
  eq([reconnects, lw._lagPausedLogged], [2, true], '6 en la última hora: en pausa');
  lw._lagReconnects = [L0 - 3_700_000]; lw._lagRun = 0;
  run(170, [1500, 1500, 1500], 5);
  eq([reconnects, lw._lagReconnects.length, lw._lagPausedLogged], [3, 1, false], 'las de hace más de una hora no cuentan');
  // Apagada por variable
  lw._lagReconnect.enabled = false; lw._lastWatchdogReconnect = 0; lw._lagRun = 0;
  run(180, [1500, 1500, 1500, 1500], 5);
  eq(reconnects, 3, 'WS_LAG_RECONNECT=off: no reconecta');
  // La reconexión limpia los baldes y la racha
  lw._lagReconnect.enabled = true; lw._lastWatchdogReconnect = 0; lw._lagRun = 0;
  run(190, [1500, 1500, 1500], 5);
  eq([reconnects, lw._lagCur, lw._lagDone, lw._lagRun], [4, null, null, 0], 'después de reconectar arranca de cero');
  // _handleMessage alimenta los baldes con hora local − timestamp del servidor
  const real = Date.now();
  lw._handleMessage({ event_type: 'best_bid_ask', asset_id: 'Z', timestamp: String(real - 1234), best_bid: '0.4', best_ask: '0.42' });
  ok(lw._lagCur && lw._lagCur.n === 1 && lw._lagCur.min >= 1234 && lw._lagCur.min < 1334, 'el mensaje del WS cuenta en el balde del segundo');
  lw._lagCur = null;
  lw._msgArrivedAt = real - 1000; // llegó hace 1 s y se procesa ahora: cuenta el retraso a la llegada
  lw._handleMessage({ event_type: 'best_bid_ask', asset_id: 'Z', timestamp: String(real - 1234), best_bid: '0.4', best_ask: '0.42' });
  lw._msgArrivedAt = null;
  ok(lw._lagCur && lw._lagCur.min === 234, 'el retraso es a la llegada, sin la espera del event loop');
  lw._lagCur = null;
  lw._handleMessage({ event_type: 'book', asset_id: 'Z', timestamp: String(real - 60000), bids: [], asks: [] });
  ok(lw._lagCur === null, 'el snapshot book no cuenta (su timestamp puede ser viejo)');
  lw.setMirror(null);
  lw.close();

  // Principal muda (bitácora 16/10 ~04:30 ARG): 2 s sin datos de los tokens con la segunda recibiendo → reconecta
  const sw = new PolymarketWS();
  let sre = 0;
  sw._forceReconnect = () => { sre++; };
  let sp = { live: true, lastDataAgo: 80, minLag: 20 };
  sw.setMirror({ freshness: () => sp });
  const S0 = Date.now();
  sw._gotBookSinceHandshake = true; sw._lastWatchdogReconnect = 0;
  sw._lastDataAt = S0 - 1999;
  eq([sw._silentCheck(S0), sre], [false, 0], '1,999 s sin datos: todavía no');
  sw._lastDataAt = S0 - 2000;
  eq([sw._silentCheck(S0), sre, sw._lagReconnects.length], [true, 1, 1], '2 s muda con la segunda recibiendo: reconecta y cuenta en el tope por hora');
  sw._lastWatchdogReconnect = 0;
  for (const p2 of [{ live: true, lastDataAgo: 600, minLag: 20 }, { live: false }, null]) { sp = p2; sw._lastDataAt = S0 - 5000; eq(sw._silentCheck(S0), false); }
  eq(sre, 1, 'con la segunda también callada o caída no reconecta (mercado quieto o el servidor)');
  sp = { live: true, lastDataAgo: 80, minLag: 20 }; sw._gotBookSinceHandshake = false; sw._lastDataAt = S0 - 5000;
  eq(sw._silentCheck(S0), false, 'antes del primer book del handshake no actúa (lo cubre el control de 5 s)');
  sw._gotBookSinceHandshake = true; sw._lagReconnects = Array.from({ length: 6 }, () => S0 - 1000);
  eq([sw._silentCheck(S0), sw._lagPausedLogged], [false, true], 'el tope de 6 por hora es el mismo de la reconexión por atraso');
  sw._lagReconnects = []; sw._lagReconnect.enabled = false;
  eq(sw._silentCheck(S0), false, 'WS_LAG_RECONNECT=off: tampoco');
  sw._topOfBook.set('T', { bestAsk: 0.5, updatedAt: Date.now() - 1500 });
  ok(sw.getTopAge('T') >= 1500 && sw.getTopAge('T') < 1700 && sw.getTopAge('X') === null, 'edad del top de la principal');
  sw.setMirror(null);
  sw.close();

  console.log(`ws-probe: ${passed} ok`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
