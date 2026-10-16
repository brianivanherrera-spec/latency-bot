/**
 * Segunda conexión al WS de mercado de Polymarket, SOLO de medición (plan del 12/10, punto d).
 *
 * Se suscribe a los mismos dos tokens (Sí/No) que la conexión principal, siguiendo cada subscribe
 * de esa (mercado nuevo = conexión nueva, porque Polymarket solo acepta el handshake como primer
 * mensaje), y no alimenta ninguna decisión ni las cuentas A/B. Sirve para saber si, cuando la
 * principal se atrasa (retraso de segundos antes de un corte 1013) o queda con un precio que el
 * REST no tiene, una conexión nueva al mismo servidor está al día: si es así, conviene usar la más
 * fresca de las dos; si se atrasan juntas, el problema es del servidor.
 *
 * Una línea [WS-DUAL] por minuto con:
 *  - retraso de entrega de cada conexión (hora local de llegada − timestamp del servidor), p50/p99/máx;
 *  - los mensajes que llegan por las dos (cada cambio de precio por su hash, best_bid_ask y trades con
 *    el mismo timestamp y contenido): por cuál llegó antes y por cuánto, y los que después de
 *    WS_PROBE_GRACE_MS (10 s) llegaron por una sola. Solo cuenta mientras las dos están suscriptas a
 *    los mismos tokens y recibiendo hace al menos 2 s (al reconectar, el server arranca a mandar
 *    en momentos distintos y eso no es un mensaje perdido);
 *  - segundos con el top de Sí o de No distinto entre las dos y cuál tenía el dato más viejo
 *    (timestamp del servidor del último mensaje de ese token); si dura 3 s, un WARN con los dos tops;
 *  - cortes de cada una (código) y segundos con la segunda caída.
 * Al final de la línea: la ventaja típica (p50) de cada una cuando llega primero, y los "solo por" por tipo
 * (cambio de precio / top / trade) con cuántos tuvieron su par por la otra conexión: el mismo contenido con
 * otro timestamp, también "solo por" (el servidor armó el mensaje distinto en cada conexión: no es un mensaje
 * perdido. En "top" el par puede ser casualidad: el mismo bid/ask se repite seguido).
 * En cada corte de la principal, una línea con el estado de la segunda en ese momento.
 * Desde el 14/10 (bitácora ~23:40 ARG) la principal le pregunta freshness() antes de reconectarse por atraso:
 * solo se reconecta si esta está al día (no cambia nada de A ni de B ni de esta conexión).
 * top(token) lo usa [BOOK-CHECK] para mostrar si, cuando el WS principal difiere del REST, la
 * segunda coincide con el REST o con la principal; snap(token) y vs() los usan [PAPER-REST] (A) y
 * [PAPER-B] REST para anotar el ask de la segunda al decidir y al llenar (solo registro).
 *
 * WS_PROBE=off la apaga. Se apaga sola si el servidor la corta más de WS_PROBE_MAX_CLOSES (20) veces
 * en una hora (los reconectes por mercado nuevo no cuentan).
 */
'use strict';
const WebSocket = require('ws');
const { Logger } = require('./logger');
const loopMonitor = require('./loop-monitor');

const logger = new Logger('WS-DUAL');
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const PING_MS = 10_000;
const SETTLE_MS = 2000;
const WATCHDOG_MS = 20_000;

// Histograma de ms (1 ms hasta 1 s, 10 ms hasta 30 s) con el máximo exacto: p50/p99 sin guardar
// cada muestra (por minuto llegan decenas de miles de mensajes por conexión)
class MsHist {
  constructor() { this.b = new Uint32Array(3901); this.n = 0; this.max = null; }
  add(ms) {
    if (!Number.isFinite(ms)) return;
    const v = Math.max(0, ms);
    this.b[v < 1000 ? Math.floor(v) : Math.min(3900, 1000 + Math.floor((v - 1000) / 10))]++;
    this.n++;
    if (this.max == null || v > this.max) this.max = v;
  }
  q(p) {
    if (!this.n) return null;
    const target = Math.max(1, Math.ceil(this.n * p));
    let acc = 0;
    for (let i = 0; i < this.b.length; i++) {
      acc += this.b[i];
      if (acc >= target) return Math.min(i < 1000 ? i : 1000 + (i - 999) * 10, this.max);
    }
    return this.max;
  }
}

const valid = x => (x != null && Number.isFinite(x) && x > 0 && x <= 1 ? x : null);
const samePx = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.0005);
const px = v => (v == null ? '—' : `$${Number(v).toFixed(v < 0.01 || v > 0.99 ? 3 : 2)}`);

class WsProbe {
  constructor({ url = WS_URL, WebSocketImpl = WebSocket, now = () => Date.now(), graceMs = num(process.env.WS_PROBE_GRACE_MS, 10000),
    maxCloses = num(process.env.WS_PROBE_MAX_CLOSES, 20), tieMs = 1, reportMs = 60000 } = {}) {
    Object.assign(this, { url, WS: WebSocketImpl, now, graceMs, maxCloses, tieMs, reportMs });
    this.ws = null;
    this.live = false;          // abierta y con handshake de los tokens actuales
    this.tokens = null; this.key = null; this.endTs = null;
    this.main = null;
    this.stopped = false;
    this._delay = 1000; this._reconnTimer = null; this._ping = null;
    this._handshakeAt = 0; this._lastData = 0; this._lastPong = 0; this._gotBook = false;
    this._closes = [];          // cortes del servidor en la última hora (para apagarse sola)
    this._mainCutAt = 0; this._cutAt = 0;
    this._top = new Map();      // token → { bestBid, bestAsk, updatedAt, topTs }
    this._pend = new Map();     // clave del mensaje → { side: 1 | 2, at } (llegó por una, falta la otra)
    this._solo = [new Map(), new Map()]; // "solo por" recientes de cada conexión: contenido sin timestamp → llegada
    this._diffRun = [0, 0];
    this._timers = [];
    this._invalidLogged = 0;
    this._lag2Cur = null; this._lag2Done = null; // retraso mínimo por segundo de esta conexión (para freshness)
    this._reset();
  }

  describe() {
    return `segunda conexión al WS de mercado de Polymarket, solo de medición: sigue los tokens de la principal y no entra a ninguna decisión; [WS-DUAL] cada minuto; se apaga sola con más de ${this.maxCloses} cortes en una hora (WS_PROBE=off la apaga)`;
  }

  _reset() {
    this.m = { lag1: new MsHist(), lag2: new MsHist(), both: 0, first1: 0, first2: 0, ties: 0, lead1: new MsHist(), lead2: new MsHist(),
      only1: 0, only2: 0, onlyT: [{ p: 0, b: 0, t: 0 }, { p: 0, b: 0, t: 0 }], pairT: [{ p: 0, b: 0, t: 0 }, { p: 0, b: 0, t: 0 }],
      topDiff: [0, 0], stale1: 0, stale2: 0, cuts1: [], cuts2: [], down2: 0, warns: 0 };
  }

  attach(main) {
    this.main = main;
    if (typeof main.setMirror === 'function') main.setMirror(this);
    if (main._yesTokenId && main._noTokenId) this.mainSubscribe(main._yesTokenId, main._noTokenId, main._marketEndTs);
    return this;
  }

  start() {
    const a = setInterval(() => this._safe(() => this._tick()), 1000);
    const b = setInterval(() => this._safe(() => { logger.info(this.report()); this._reset(); }), this.reportMs);
    for (const t of [a, b]) { if (t.unref) t.unref(); this._timers.push(t); }
    return this;
  }

  // Una falla de la medición nunca puede tirar el proceso del bot
  _safe(fn) {
    try { fn(); } catch (e) {
      if ((this._errLogged = (this._errLogged || 0) + 1) <= 5) logger.warn(`[WS-DUAL] error de la medición: ${e?.message || e}`);
    }
  }

  stop(reason = null) {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    clearTimeout(this._reconnTimer); this._reconnTimer = null;
    this._teardown();
    if (this.main && this.main._mirror === this) this.main._mirror = null;
    if (reason) logger.warn(`[WS-DUAL] segunda conexión apagada: ${reason}`);
  }

  // ─── Hooks de la conexión principal (PolymarketWS los llama dentro de try/catch) ─────────────
  mainSubscribe(yes, no, endTs = null) {
    if (this.stopped || !yes || !no) return;
    if (endTs) this.endTs = endTs;
    const key = `${yes}|${no}`;
    if (key === this.key) return;
    this.tokens = [yes, no]; this.key = key;
    this._top.clear(); this._pend.clear(); this._solo.forEach(S => S.clear()); this._diffRun = [0, 0];
    this._reconnect();
  }

  mainEvents(events, at) {
    if (this.stopped) return;
    const both = this._bothLive(at);
    for (const e of events) this._observe(1, e, at, both);
  }

  mainClose(code) {
    if (this.stopped) return;
    const now = this.now();
    this.m.cuts1.push(code);
    this._mainCutAt = now;
    const state = !this.live ? 'también caída'
      : `conectada, último dato hace ${now - this._lastData} ms${this._cutAt && now - this._cutAt < 30000 ? `, cortada hace ${Math.round((now - this._cutAt) / 1000)} s` : ''}`;
    logger.info(`[WS-DUAL] WS1 cortada (code=${code}) | WS2 ${state}`);
  }

  // ¿Está al día esta conexión? Lo usa la principal antes de reconectarse por atraso (polymarket-ws.js,
  // _lagCheck): { live, lastDataAgo (ms), minLag (retraso del dato más fresco del segundo en curso o del
  // anterior, ms) } | { live: false } | null (error). No cambia nada de ninguna conexión
  freshness() {
    try {
      if (this.stopped || !this.live || !this._gotBook) return { live: false };
      const now = this.now();
      const prev = Math.floor(now / 1000) - 1;
      let minLag = null;
      for (const b of [this._lag2Cur, this._lag2Done]) if (b && b.sec >= prev && (minLag == null || b.min < minLag)) minLag = b.min;
      return { live: true, lastDataAgo: now - this._lastData, minLag };
    } catch (_) { return null; }
  }

  _noteLag2(at, lag) {
    if (!Number.isFinite(lag)) return;
    const sec = Math.floor(at / 1000);
    const c = this._lag2Cur;
    if (!c || c.sec !== sec) { if (c) this._lag2Done = c; this._lag2Cur = { sec, min: lag }; }
    else if (lag < c.min) c.min = lag;
  }

  // Top de la segunda conexión, con la misma forma que lee [BOOK-CHECK] de la principal
  top(tokenId) {
    if (!this.live) return null;
    const r = this._top.get(tokenId);
    if (!r) return null;
    return { bid: r.bestBid, ask: r.bestAsk, age: this.now() - r.updatedAt, topTs: r.topTs };
  }

  // Ask de la segunda en un momento (decisión o fill de A y B), para compararlo después con el WS principal
  // y el REST: { ask, age } | { down } (caída) | { off } (apagada) | null (error)
  snap(tokenId) {
    try {
      if (this.stopped) return { off: true };
      if (!this.live) return { down: true };
      const r = this._top.get(tokenId);
      return r ? { ask: r.bestAsk, age: this.now() - r.updatedAt } : { ask: null };
    } catch (_) { return null; }
  }

  // Control al decidir (bitácora 16/10 ~04:30 ARG): ¿esta conexión muestra otro ask (≥ tol) con un dato al menos ms
  // más nuevo que el de la principal? → { ask, age, mainAge } o null. Lo usan A y B (STALE_GUARD); nunca tira
  staleVs(tokenId, mainAsk, mainAge, tol = 0.02, ms = 1000) {
    try {
      if (this.stopped || !this.live || mainAsk == null || mainAge == null) return null;
      const r = this._top.get(tokenId);
      if (!r || r.bestAsk == null) return null;
      const age = this.now() - r.updatedAt;
      if (Math.abs(r.bestAsk - mainAsk) < tol - 1e-9 || mainAge - age < ms) return null;
      return { ask: r.bestAsk, age, mainAge };
    } catch (_) { return null; }
  }

  // "$0.43 (igual al REST, dato de hace 120 ms)": el snap contra el ask del WS principal y el del REST del mismo momento
  vs(s, wsAsk, restAsk) {
    try {
      if (!s) return 'sin dato';
      if (s.off) return 'apagada';
      if (s.down) return 'sin conexión';
      if (s.ask == null) return 'sin libro';
      const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 0.0005;
      const rel = eq(s.ask, restAsk) ? (eq(s.ask, wsAsk) ? 'igual a los dos' : 'igual al REST')
        : eq(s.ask, wsAsk) ? 'igual al WS principal'
        : restAsk == null ? 'distinto del WS principal, sin REST'
        : Math.abs(s.ask - restAsk) <= 0.0105 ? 'a 1¢ del REST' : 'distinto de los dos';
      return `${px(s.ask)} (${rel}, dato de hace ${s.age} ms)`;
    } catch (_) { return 'sin dato'; }
  }

  // ─── Conexión ────────────────────────────────────────────────────────────────────────────────
  _bothLive(at = this.now()) {
    const M = this.main;
    return !!(this.live && this._gotBook && M && M._connected && M._socketTokensKey === this.key && M._gotBookSinceHandshake &&
      at - Math.max(this._handshakeAt, M._handshakeAt || 0) >= SETTLE_MS);
  }

  _teardown() {
    const ws = this.ws;
    this.ws = null; this.live = false; this._gotBook = false;
    clearInterval(this._ping); this._ping = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.on('error', () => {}); // cerrar un socket que todavía conecta emite 'error'
      ws.close();
    } catch (_) {}
  }

  _reconnect() {
    clearTimeout(this._reconnTimer); this._reconnTimer = null;
    this._teardown();
    this._delay = 1000;
    this._connect();
  }

  _schedule() {
    if (this.stopped || this._reconnTimer) return;
    const d = this._delay;
    this._delay = Math.min(this._delay * 2, 30000);
    this._reconnTimer = setTimeout(() => { this._reconnTimer = null; this._safe(() => this._connect()); }, d);
    if (this._reconnTimer.unref) this._reconnTimer.unref();
  }

  _connect() {
    if (this.stopped || !this.tokens || this.ws) return;
    let ws;
    try {
      // Mismas opciones que la principal (Polymarket no negocia permessage-deflate)
      ws = new this.WS(this.url, { maxPayload: 10 * 1024 * 1024, perMessageDeflate: true });
    } catch (e) {
      logger.warn(`[WS-DUAL] no se pudo crear la segunda conexión: ${e.message}`);
      this._schedule();
      return;
    }
    this.ws = ws;
    const tokens = this.tokens;
    ws.on('open', () => this._safe(() => {
      if (this.ws !== ws) return;
      try { ws.send(JSON.stringify({ assets_ids: tokens, type: 'market', custom_feature_enabled: true })); } catch (_) {
        try { ws.terminate(); } catch (_) {} // el 'close' que sigue reprograma la conexión
        return;
      }
      this._delay = 1000;
      this.live = true; this._gotBook = false;
      this._handshakeAt = this._lastData = this._lastPong = this.now();
      this._startPing(ws);
    }));
    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      const at = this.now();
      const raw = typeof data === 'string' ? data : data.toString();
      if (raw === 'PONG' || raw === 'pong') { this._lastPong = at; return; }
      loopMonitor.count('ws2_msgs');
      loopMonitor.count('ws2_kb', raw.length / 1024);
      // Como la principal: se procesa en la vuelta siguiente del event loop y la llegada queda en `at`
      setImmediate(() => { if (this.ws === ws) loopMonitor.time('ws2', () => this._safe(() => this._onRaw(raw, at))); });
    });
    ws.on('error', (e) => { if (this.ws === ws) this._lastErr = e?.message || String(e); }); // el 'close' que sigue cuenta el corte
    ws.on('close', (code, reason) => { if (this.ws === ws) this._safe(() => this._onClose(code, String(reason || ''))); });
  }

  _startPing(ws) {
    clearInterval(this._ping);
    this._ping = setInterval(() => this._safe(() => {
      if (this.ws !== ws) return;
      try { ws.send('PING'); } catch (_) {}
      if (this.now() - this._lastPong > PING_MS * 3) {
        logger.warn('[WS-DUAL] WS2 sin PONG en 30 s — reconectando');
        try { ws.terminate(); } catch (_) {}
      }
    }), PING_MS);
    if (this._ping.unref) this._ping.unref();
  }

  _onClose(code, reason) {
    const now = this.now();
    this.ws = null; this.live = false; this._gotBook = false;
    clearInterval(this._ping); this._ping = null;
    const ended = this.endTs && now >= this.endTs; // mercado cerrado: espera el subscribe del próximo
    if (!ended) {
      this.m.cuts2.push(code);
      this._cutAt = now;
      const main = this._mainCutAt && now - this._mainCutAt < 30000 ? `WS1 cortada hace ${Math.round((now - this._mainCutAt) / 1000)} s` : 'WS1 sin corte en los últimos 30 s';
      const err = this._lastErr ? `; error: ${this._lastErr.slice(0, 80)}` : '';
      logger.warn(`[WS-DUAL] WS2 (medición) desconectada (code=${code}${reason ? ` ${reason}` : ''}${err}) | ${main}`);
      if (this._countClose(now)) return;
    }
    this._lastErr = null;
    if (!ended) this._schedule();
  }

  // Corte o reconexión forzada que cuenta para apagarse sola (más de maxCloses en una hora)
  _countClose(now) {
    this._closes.push(now);
    while (this._closes.length && now - this._closes[0] > 3600000) this._closes.shift();
    if (this._closes.length <= this.maxCloses) return false;
    this.stop(`${this._closes.length} cortes en una hora`);
    return true;
  }

  _onRaw(raw, at) {
    if (raw.startsWith('INVALID')) {
      if (this._invalidLogged++ < 5) logger.warn(`[WS-DUAL] el server respondió "${raw.slice(0, 60)}" a la segunda conexión — reconectando`);
      if (!this._countClose(this.now())) this._reconnect();
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return; }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    this._lastData = at;
    const both = this._bothLive(at);
    for (const e of events) this._observe(2, e, at, both);
  }

  // ─── Medición ────────────────────────────────────────────────────────────────────────────────
  _observe(side, e, at, both) {
    if (!e || typeof e !== 'object') return;
    const type = e.event_type || e.type || '';
    const ts = Number(e.timestamp);
    if (ts > 1e12) (side === 1 ? this.m.lag1 : this.m.lag2).add(at - ts);
    if (side === 2 && ts > 1e12 && type !== 'book') this._noteLag2(at, at - ts);
    if (side === 2) this._applyTop(type, e, ts > 1e12 ? ts : null, at);
    if (!both) return;
    // Clave: tipo|timestamp del servidor|token|contenido
    if (type === 'price_change') {
      for (const c of Array.isArray(e.price_changes) ? e.price_changes : []) {
        if (c && c.asset_id) this._match(side, `p|${e.timestamp}|${c.asset_id}|${c.hash || `${c.price}|${c.size}|${c.side}`}`, at);
      }
    } else if (type === 'best_bid_ask') {
      this._match(side, `b|${e.timestamp}|${e.asset_id}|${e.best_bid}|${e.best_ask}`, at);
    } else if (type === 'last_trade_price') {
      this._match(side, `t|${e.timestamp}|${e.asset_id}|${e.price}|${e.size}|${e.side}`, at);
    }
  }

  _match(side, key, at) {
    const p = this._pend.get(key);
    if (!p) { this._pend.set(key, { side, at }); return; }
    if (p.side === side) return; // repetido por la misma conexión
    this._pend.delete(key);
    const d = at - p.at;
    const first = d >= 0 ? p.side : side, lead = Math.abs(d);
    this.m.both++;
    if (lead <= this.tieMs) this.m.ties++;
    else if (first === 1) { this.m.first1++; this.m.lead1.add(lead); }
    else { this.m.first2++; this.m.lead2.add(lead); }
  }

  // "Solo por" por tipo, y si la otra conexión trajo el mismo contenido con otro timestamp (también "solo por"
  // en ±graceMs): el servidor armó el mensaje distinto en cada conexión, no se perdió. Solo mira los "solo por"
  // (1-2 % de los mensajes), así que no suma costo por mensaje. En "top" el par puede ser casualidad
  _soloPair(k, v) {
    const s = v.side - 1, t = k[0];
    if (!(t in this.m.onlyT[s])) return;
    this.m.onlyT[s][t]++;
    const i = k.indexOf('|', 2);
    if (i < 0) return;
    const ck = t + k.slice(i); // sin el timestamp: "p|token|hash"
    const other = this._solo[1 - s], at = other.get(ck);
    if (at != null && Math.abs(at - v.at) <= this.graceMs) {
      other.delete(ck);
      this.m.pairT[s][t]++; this.m.pairT[1 - s][t]++;
    } else this._solo[s].set(ck, v.at);
  }

  _setTop(tok, bid, ask, ts, at) {
    if (!tok || !this.tokens || !this.tokens.includes(tok)) return;
    bid = valid(bid); ask = valid(ask);
    if (bid == null && ask == null) return;
    if (bid != null && ask != null && bid >= ask) return; // cruzado: la principal también lo descarta
    this._top.set(tok, { bestBid: bid, bestAsk: ask, updatedAt: at, topTs: ts });
  }

  _applyTop(type, e, ts, at) {
    if (type === 'book') {
      let bid = null, ask = null;
      for (const l of Array.isArray(e.bids) ? e.bids : []) { const p = parseFloat(l?.price), z = parseFloat(l?.size); if (p > 0 && p <= 1 && z > 0 && (bid == null || p > bid)) bid = p; }
      for (const l of Array.isArray(e.asks) ? e.asks : []) { const p = parseFloat(l?.price), z = parseFloat(l?.size); if (p > 0 && p <= 1 && z > 0 && (ask == null || p < ask)) ask = p; }
      if (this.tokens && this.tokens.includes(e.asset_id)) this._gotBook = true;
      this._setTop(e.asset_id, bid, ask, ts, at);
    } else if (type === 'price_change') {
      for (const c of Array.isArray(e.price_changes) ? e.price_changes : []) if (c) this._setTop(c.asset_id, parseFloat(c.best_bid), parseFloat(c.best_ask), ts, at);
    } else if (type === 'best_bid_ask') {
      this._setTop(e.asset_id, parseFloat(e.best_bid), parseFloat(e.best_ask), ts, at);
    }
  }

  _tick() {
    if (this.stopped) return;
    const now = this.now();
    // Pendientes vencidos: llegaron por una sola conexión (el Map está en orden de llegada)
    for (const [k, v] of this._pend) {
      if (now - v.at < this.graceMs) break;
      if (v.side === 1) this.m.only1++; else this.m.only2++;
      this._pend.delete(k);
      this._soloPair(k, v);
    }
    for (const S of this._solo) {
      for (const [k, at] of S) { if (now - at <= 2 * this.graceMs) break; S.delete(k); }
    }
    if (!this.tokens) return;
    const open = !this.endTs || now < this.endTs;
    if (!this.live) { if (open && this.main?._connected) this.m.down2++; return; }
    if (open && now - this._lastData > WATCHDOG_MS) {
      logger.warn(`[WS-DUAL] WS2 sin datos hace ${Math.round((now - this._lastData) / 1000)} s — reconectando`);
      this.m.cuts2.push('sin datos');
      if (!this._countClose(now)) this._reconnect();
      return;
    }
    this._compareTops(now);
  }

  // Top de Sí y de No: principal contra segunda, una vez por segundo
  _compareTops(now) {
    if (!this._bothLive(now)) { this._diffRun = [0, 0]; return; }
    this.tokens.forEach((tok, i) => {
      const a = this.main._topOfBook?.get(tok), b = this._top.get(tok);
      if (!a || !b || (samePx(a.bestBid, b.bestBid) && samePx(a.bestAsk, b.bestAsk))) { this._diffRun[i] = 0; return; }
      this.m.topDiff[i]++;
      if (a.topTs != null && b.topTs != null) {
        if (a.topTs < b.topTs) this.m.stale1++;
        else if (b.topTs < a.topTs) this.m.stale2++;
      }
      if (++this._diffRun[i] === 3 && this.m.warns++ < 2) {
        const age = r => (r.topTs != null ? `dato del servidor de hace ${now - r.topTs} ms` : 'sin hora del servidor');
        logger.warn(`[WS-DUAL] ⚠️ ${i === 0 ? 'Sí' : 'No'} distinto hace 3 s entre las dos conexiones: WS1 ${px(a.bestBid)}/${px(a.bestAsk)} (${age(a)}) vs WS2 ${px(b.bestBid)}/${px(b.bestAsk)} (${age(b)})`);
      }
    });
  }

  report() {
    const m = this.m;
    const lag = h => (h.n ? `${h.q(0.5)}/${h.q(0.99)}/${Math.round(h.max)} ms (n=${h.n})` : 'sin datos');
    const lead = h => (h.n ? ` (p99 ${h.q(0.99)} ms, máx ${Math.round(h.max)} ms)` : '');
    const cuts = a => (a.length ? a.join(', ') : '0');
    const p50 = h => (h.n ? `${h.q(0.5)} ms` : '—');
    const ty = o => `${o.p}/${o.b}/${o.t}`;
    // Lo agregado el 14/10 va al final para no cambiar lo que ya leían los informes
    return `[WS-DUAL] retraso p50/p99/máx: WS1 ${lag(m.lag1)}, WS2 ${lag(m.lag2)} | por las dos ${m.both}: antes por WS1 ${m.first1}${lead(m.lead1)}, antes por WS2 ${m.first2}${lead(m.lead2)}, empate ${m.ties} | solo por WS1 ${m.only1}, solo por WS2 ${m.only2} | top distinto Sí ${m.topDiff[0]} s, No ${m.topDiff[1]} s (dato más viejo en WS1 ${m.stale1}, en WS2 ${m.stale2}) | cortes WS1 ${cuts(m.cuts1)}, WS2 ${cuts(m.cuts2)} | WS2 sin conexión ${m.down2} s | ventaja p50: WS1 ${p50(m.lead1)}, WS2 ${p50(m.lead2)} | solo por (precio/top/trade): WS1 ${ty(m.onlyT[0])}, WS2 ${ty(m.onlyT[1])}; con su par por la otra con otro timestamp: WS1 ${ty(m.pairT[0])}, WS2 ${ty(m.pairT[1])}${this.stopped ? ' | APAGADA' : ''}`;
  }
}

module.exports = { WsProbe, MsHist };
