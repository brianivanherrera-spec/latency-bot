/**
 * Resumen por hora de los logs — [RESUMEN] (solo registro).
 *
 * El chequeo programado pasó a cada 6 h: en vez de leer cientos de líneas por tema
 * ([LOOP] y [WS-DUAL] salen cada minuto), lee estas dos líneas por hora. Mira cada línea
 * que pasa por el Logger, cuenta eventos y guarda máximos; no cambia nada del bot.
 *
 *   [RESUMEN] cuentas HH:20-HH:20 UTC | A … | B … | pérdidas B … | B15 (paper de BTC 15 min) … | B15 ETH (paper de ETH 15 min) … | B1H (paper de BTC horario) …
 *   [RESUMEN] salud HH:20-HH:20 UTC | reconexiones … | 1013 … | BOOK-CHECK … | LOOP … | WARN/ERROR …
 *
 * Sale a los :20 UTC de cada hora (el chequeo corre a los :22). LOG_DIGEST=off lo apaga.
 */
'use strict';

const ENABLED = String(process.env.LOG_DIGEST || 'on').toLowerCase() !== 'off';
const EMIT_MINUTE = 20;

// logger.js usa este módulo, así que el Logger se pide recién al emitir
let _logger = null;
const emitLine = msg => {
  if (!_logger) { const { Logger } = require('./logger'); _logger = new Logger('RESUMEN'); }
  _logger.info(msg);
};

const num = s => Number(String(s).replace('−', '-').replace(',', '.'));
const signed = (sign, v) => (sign === '−' || sign === '-' ? -1 : 1) * num(v);
const usd = v => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const hhmm = t => new Date(t).toISOString().slice(11, 16);

// Contadores simples: clave → patrón sobre "[PREFIJO] cuerpo"
const COUNTS = [
  ['atrasada', /\[WATCHDOG\] atrasada:/],
  ['muda', /\[WATCHDOG\] muda:/],
  ['topViejo', /\[WATCHDOG\] top viejo:/],
  ['pausa', /reconexión por atraso en pausa/],
  ['ws1_1013', /\[LOOP\] corte 1013/],
  ['ws1Cortes', /\[WS-DUAL\] WS1 cortada/],
  ['ws2Caidas', /WS2 \(medición\) desconectada/],
  ['polybolt', /\[POLYBOLT\] Sin datos/],
  ['bnReco', /\[WATCHDOG\] Binance .*reconectando/],
  ['bnTope', /\[WATCHDOG\] Binance .*tope de .*reconectando/],
  ['bnSinPong', /\[WATCHDOG\] Binance .*sin pong.*reconectando/],
  ['bnPingOk', /\[WATCHDOG\] Binance: .*contestó el ping/],
  ['staleGuard', /\[STALE-GUARD\]/],
  ['distinto3s', /distinto hace 3 s entre las dos conexiones/],
  ['skipStrike', /\[SKIP\] .*Strike sin TWAP/],
  ['serieBtc15m', /\[SERIE btc15m\] .* muestras/],
  ['serieEth5m', /\[SERIE eth5m\] .* muestras/],
  ['eth0modelo', /\[SERIE eth5m\] .*muestras \(0 con modelo/],
  ['serieEth15m', /\[SERIE eth15m\] .* muestras/],
  ['eth15_0modelo', /\[SERIE eth15m\] .*muestras \(0 con modelo/],
  ['serieBtc1h', /\[SERIE btc1h\] .* muestras/],
  ['btc1h_0modelo', /\[SERIE btc1h\] .*muestras \(0 con modelo/],
  ['serieSol15m', /\[SERIE sol15m\] .* muestras/],
  ['sol15_0modelo', /\[SERIE sol15m\] .*muestras \(0 con modelo/],
  ['serie429', /respondió 429/],
  ['bookReal', /diferencia REAL/],
  ['backtest', /\[BACKTEST-B-HIPOTESIS\]/],
  ['ejecucion', /\[EJECUCION\] PAPER a \+/],
];

// WARN/ERROR conocidos (ver el prompt del chequeo): se cuentan pero no van a "otros"
const KNOWN = [
  /Alta latencia/, /Gap .* en TWAP/, /getBalanceAllowance falló/, /Binance sin datos hace siempre/,
  /Libro cruzado descartado/, /Mercado ya cerrado/, /MIN_ENTRY_PRICE/, /Segunda entrada/, /LATE_ENTRY/,
  /code=(1000|1001|1005|1006|1013|4003)\b/, /Sin TWAP del RTDS hace/, /Sin precios del RTDS hace/,
  /libro moviéndose/, /diferencia REAL/, /Error actualizando precio/, /sin datos de los tokens hace 15 s/,
  /\[WATCHDOG\] (atrasada|muda|top viejo):/, /reconexión por atraso en pausa/, /\[POLYBOLT\] Sin datos/,
  /\[WATCHDOG\] (Binance|Coinbase) .*reconectando/, /\[STALE-GUARD\]/, /distinto hace 3 s/,
  /WS2 \(medición\) desconectada/, /\[STRIKE\] /, /\[SKIP\] /,
  // Reconexiones de rutina que salían en "otros" todas las horas (21/10): el WS de Polymarket, el RTDS/spot de
  // Chainlink, PolyBolt, Coinbase, y el "sin fill" de A en paper
  /\[POLY-WS\] Reconectando en \d+ms/, /\[(RTDS|SPOT)\] Desconectado \((1001|1006)\)\. Reconectando/,
  /\[POLYBOLT\] Desconectado \((1001|1006)\)/, /Coinbase desconectado \((1001|1006)\)/, /\[PAPER\] ⚠️ Sin fill:/,
];

const B15_LABEL = { btc15m: 'B15', eth15m: 'B15 ETH', btc1h: 'B1H', sol15m: 'B15 SOL' };

class LogDigest {
  constructor(now = Date.now()) {
    this.bootAt = now;
    this.lastA = null;      // último "P&L Total acumulado" de A
    this.lastB = null;      // último "Balance B" parseado
    this.baseB = null;      // Balance B al cerrar la ventana anterior (para las diferencias)
    this.attempts = new Map(); // "UP mercado" → {secs, edge} del intento de B
    this.lastB15 = {};      // id de la serie (btc15m, eth15m) → último "Balance B15" de su cuenta en paper
    this._reset(now);
  }

  _reset(now) {
    this.since = now;
    this.c = Object.fromEntries(COUNTS.map(([k]) => [k, 0]));
    this.warn = 0; this.error = 0;
    this.others = new Map(); // clave normalizada → {n, ex, level}
    this.a = { w: 0, l: 0, pnl: 0 };
    this.b = { w: 0, l: 0, pnl: 0, losses: [] };
    this.b15 = {};          // id de la serie → { att, fill, w, l, pnl, losses } de la ventana
    this._aPending = false;
    this.strike = { n: 0, notCl: 0, maxWait: null };
    this.ptb = { n: 0, maxRtds: null, maxPb: null, nonZero: 0 };
    this.book = { n: 0, min: null, sum: 0 };
    this.loop = { n: 0, lagP99: null, cpu: null, wsP99: null, wsMax: null, bad: 0 };
  }

  observe(level, prefix, body) {
    if (prefix === 'RESUMEN') return;
    const line = `[${prefix}] ${body}`;
    for (const [k, re] of COUNTS) if (re.test(line)) this.c[k]++;
    if (level === 'warn' || level === 'error') this._warnError(level, line);
    if (line.includes('[PAPER-B15]') || line.includes('[PAPER-B1H]')) this._b15(line);
    else if (prefix === 'TRACKER') this._a(line);
    else if (prefix === 'PAPER-B') this._b(line);
    else if (prefix === 'LOOP') this._loop(line);
    else if (prefix === 'BOOK-CHECK') this._book(line);
    else if (line.includes('[PTB-CHECK]')) this._ptb(line);
    else if (line.includes('[STRIKE] ')) this._strike(line);
  }

  _warnError(level, line) {
    if (level === 'warn') this.warn++; else this.error++;
    if (level === 'warn' && KNOWN.some(re => re.test(line))) return;
    const key = line.replace(/\d+([.,]\d+)?/g, '#').slice(0, 90);
    const o = this.others.get(key);
    if (o) { o.n++; return; }
    if (this.others.size < 50) this.others.set(key, { n: 1, ex: line.slice(0, 160), level });
  }

  _a(line) {
    if (/\[(WIN|LOSS)\] .*Posicion cerrada/.test(line)) { this._aPending = true; return; }
    let m;
    if (this._aPending && (m = /(?:Resultado: \S+|Razón: .*?) \| PnL: \+?\$(-?[\d.]+)/.exec(line))) {
      const v = num(m[1]);
      this.a.pnl += v; if (v >= 0) this.a.w++; else this.a.l++;
      this._aPending = false;
    } else if ((m = /P&L Total acumulado: \+?\$(-?[\d.]+) \| W:(\d+) L:(\d+)/.exec(line))) {
      this.lastA = { pnl: num(m[1]), w: +m[2], l: +m[3] };
    }
  }

  _b(line) {
    let m;
    if ((m = /\[PAPER-B\] (UP|DOWN) (.+?) \| (\d+) s restantes \| .*?\(ventaja (-?[\d.]+) pts\)/.exec(line)) && !line.includes('NO ENTRA')) {
      this.attempts.set(`${m[1]} ${m[2]}`, { secs: +m[3], edge: num(m[4]) });
      if (this.attempts.size > 20) this.attempts.delete(this.attempts.keys().next().value);
    } else if ((m = /\[PAPER-B\] (WIN|LOSS) (UP|DOWN) (.+?) @ \$([\d.]+) ×[\d.]+ → ([+−-])\$([\d.]+)/.exec(line))) {
      const v = signed(m[5], m[6]);
      this.b.pnl += v;
      if (m[1] === 'WIN') this.b.w++;
      else {
        this.b.l++;
        const at = this.attempts.get(`${m[2]} ${m[3]}`);
        if (this.b.losses.length < 8) this.b.losses.push(`${m[2]} ${m[3]} a $${m[4]}${at ? ` (${at.secs} s, ${at.edge} pts)` : ''} ${usd(v)}`);
      }
    } else if ((m = /Balance B: ([+−-])\$([\d.]+) \| W:(\d+) L:(\d+)/.exec(line))) {
      const s = { pnl: signed(m[1], m[2]), w: +m[3], l: +m[4] };
      const t = /intentos (\d+), llenadas (\d+), sin fill (\d+), abiertas (\d+)/.exec(line);
      if (t) Object.assign(s, { attempts: +t[1], filled: +t[2], noFill: +t[3], open: +t[4] });
      const r = /con el libro REST: ([+−-])\$([\d.]+) \((\d+)-(\d+)\)/.exec(line);
      if (r) s.rest = { pnl: signed(r[1], r[2]), w: +r[3], l: +r[4] };
      const r2 = /con el REST a \+(\d+)ms: ([+−-])\$([\d.]+) \((\d+)-(\d+)\)/.exec(line);
      if (r2) s.rest2 = { ms: +r2[1], pnl: signed(r2[2], r2[3]), w: +r2[4], l: +r2[5] };
      if (!this.baseB) this.baseB = s; // primera del arranque: base de la primera ventana
      this.lastB = s;
    }
  }

  // Una cuenta por serie: el id sale del prefijo [SERIE <id>] (sin prefijo, btc15m)
  _b15(line) {
    let m;
    const id = /\[SERIE (\w+)\]/.exec(line)?.[1] || 'btc15m';
    const B = this.b15[id] || (this.b15[id] = { att: 0, fill: 0, w: 0, l: 0, pnl: 0, losses: [] });
    if ((m = /\[PAPER-B(?:15|1H)\] (WIN|LOSS) (UP|DOWN) (.+?) @ \$([\d.]+) ×\d+ → ([+−-])\$([\d.]+)/.exec(line))) {
      const v = signed(m[5], m[6]);
      B.pnl += v;
      if (m[1] === 'WIN') B.w++; else { B.l++; if (B.losses.length < 8) B.losses.push(`${m[2]} ${m[3]} a $${m[4]} ${usd(v)}`); }
    } else if (/\[PAPER-B(?:15|1H)\] (UP|DOWN) .* s restantes/.test(line)) {
      B.att++;
      if (/ → lleno a /.test(line)) B.fill++;
    }
    if ((m = /Balance B(?:15|1H): ([+−-])\$([\d.]+) \((\d+)-(\d+)\), intentos (\d+), llenadas (\d+), sin fill (\d+), abiertas (\d+)/.exec(line))) {
      this.lastB15[id] = { pnl: signed(m[1], m[2]), w: +m[3], l: +m[4], attempts: +m[5], filled: +m[6], open: +m[8] };
    }
  }

  _loop(line) {
    if (line.includes('corte 1013')) return;
    const L = this.loop;
    const mx = (k, v) => { if (Number.isFinite(v) && (L[k] == null || v > L[k])) L[k] = v; };
    let m;
    const lag = (m = /lag p50=\S+ p99=([\d.]+)ms/.exec(line)) ? num(m[1]) : null;
    const cpu = (m = /CPU (\d+)%/.exec(line)) ? +m[1] : null;
    const ws = /retraso WS p50=\d+ms p99=(\d+)ms máx=(\d+)ms/.exec(line);
    if (lag == null && cpu == null && !ws) return;
    L.n++;
    mx('lagP99', lag); mx('cpu', cpu);
    if (ws) { mx('wsP99', +ws[1]); mx('wsMax', +ws[2]); }
    if ((lag != null && lag > 50) || (cpu != null && cpu > 25) || (ws && (+ws[1] > 1000 || +ws[2] > 3000))) L.bad++;
  }

  _book(line) {
    const m = /iguales \d+ \(([\d.]+)%\)/.exec(line);
    if (!m) return;
    const v = num(m[1]);
    this.book.n++; this.book.sum += v;
    if (this.book.min == null || v < this.book.min) this.book.min = v;
  }

  _ptb(line) {
    const P = this.ptb;
    P.n++;
    const abs = re => { const m = re.exec(line); return m && m[1] !== 'n/a' ? Math.abs(num(m[1])) : null; };
    const rt = abs(/RTDS=([+-]?[\d.]+|n\/a) \|/);
    const pb = abs(/PolyBolt=([+-]?[\d.]+|n\/a)/);
    if (rt != null && (P.maxRtds == null || rt > P.maxRtds)) P.maxRtds = rt;
    if (pb != null && (P.maxPb == null || pb > P.maxPb)) P.maxPb = pb;
    if ((rt != null && rt >= 0.005) || (pb != null && pb >= 0.005)) P.nonZero++;
  }

  _strike(line) {
    const S = this.strike;
    const src = /strike_source=(\S+)/.exec(line);
    if (!src) return;
    S.n++;
    if (src[1] !== 'chainlink_twap') S.notCl++;
    const w = /espera=([\d.]+)s/.exec(line);
    if (w && (S.maxWait == null || num(w[1]) > S.maxWait)) S.maxWait = num(w[1]);
  }

  // Devuelve las dos líneas de la ventana [since, now) y empieza la siguiente
  report(now = Date.now()) {
    const c = this.c;
    const win = `${hhmm(this.since)}-${hhmm(now)} UTC${this.since === this.bootAt ? ' (desde el arranque)' : ''}`;
    const A = this.lastA ? `total ${usd(this.lastA.pnl)} (${this.lastA.w}-${this.lastA.l})` : 'total sin dato';
    const cuentas = [`[RESUMEN] cuentas ${win}`,
      `A: ${this.a.w}-${this.a.l} ${usd(this.a.pnl)}; ${A}`,
      `B: ${this.b.w}-${this.b.l} ${usd(this.b.pnl)}${this._bWindow()}; ${this._bTotal()}`,
      `pérdidas B: ${this.b.losses.length ? this.b.losses.join('; ') : 'ninguna'}`,
      ...this._b15Items()];
    const top = [...this.others.values()].sort((x, y) => y.n - x.n).slice(0, 4)
      .map(o => `${o.level === 'error' ? 'ERROR ' : ''}×${o.n} "${o.ex}"`);
    const f = (v, d = 0) => (v == null ? 'n/a' : v.toFixed(d));
    const L = this.loop, P = this.ptb, S = this.strike, K = this.book;
    const salud = [`[RESUMEN] salud ${win}`,
      `principal: atrasada ${c.atrasada}, muda ${c.muda}, top viejo ${c.topViejo}, en pausa ${c.pausa}; cortes WS1 ${c.ws1Cortes} (1013 ${c.ws1_1013}); WS2 desconectada ${c.ws2Caidas}; Sí/No distinto 3 s ${c.distinto3s}; STALE-GUARD ${c.staleGuard}`,
      `PolyBolt silencios ${c.polybolt}; Binance reconexiones ${c.bnReco} (tope ${c.bnTope}, sin pong ${c.bnSinPong}), ping contestado ${c.bnPingOk}`,
      `strike ${S.n} (no chainlink ${S.notCl}, espera máx ${f(S.maxWait, 1)} s); sin TWAP salteado ${c.skipStrike}; PTB-CHECK ${P.n} (Δ≠0 ${P.nonZero}, máx RTDS ${f(P.maxRtds, 2)}, PolyBolt ${f(P.maxPb, 2)})`,
      `BOOK-CHECK ${K.n ? `mín ${f(K.min, 1)}% prom ${(K.sum / K.n).toFixed(1)}%` : 'n/a'}, diferencias REALES ${c.bookReal}`,
      `LOOP ${L.n} min: retraso WS p99 máx ${f(L.wsP99)} ms, máx ${f(L.wsMax)} ms; lag p99 máx ${f(L.lagP99)} ms; CPU máx ${f(L.cpu)}%; minutos fuera de umbral ${L.bad}`,
      `SERIE btc15m ${c.serieBtc15m}, eth15m ${c.serieEth15m} (0 con modelo ${c.eth15_0modelo}), ${c.serieSol15m ? `sol15m ${c.serieSol15m} (0 con modelo ${c.sol15_0modelo}), ` : ''}eth5m ${c.serieEth5m} (0 con modelo ${c.eth0modelo}), btc1h ${c.serieBtc1h} (0 con modelo ${c.btc1h_0modelo}), 429 ${c.serie429}; corrió backtest ${c.backtest ? 'sí' : 'no'}, ejecución ${c.ejecucion ? 'sí' : 'no'}`,
      `WARN ${this.warn}, ERROR ${this.error}; otros: ${top.length ? top.join('; ') : 'ninguno'}`];
    this.baseB = this.lastB;
    this._reset(now);
    return [cuentas.join(' | '), salud.join(' | ')];
  }

  _bWindow() {
    const s = this.lastB, b = this.baseB;
    if (!s || !b || s.attempts == null || b.attempts == null) return '';
    const d = (k) => (s[k] && b[k] ? `${usd(s[k].pnl - b[k].pnl)} (${s[k].w - b[k].w}-${s[k].l - b[k].l})` : 'n/a');
    return ` (intentos ${s.attempts - b.attempts}, llenadas ${s.filled - b.filled}; REST ${d('rest')}, REST +${s.rest2?.ms ?? '?'}ms ${d('rest2')})`;
  }

  // "B15: …" (BTC 15 min) siempre; las otras series ("B15 ETH: …") desde que aparece su cuenta
  _b15Items() {
    const ids = ['btc15m', ...new Set([...Object.keys(this.lastB15), ...Object.keys(this.b15)].filter(id => id !== 'btc15m'))];
    return ids.map(id => {
      const B = this.b15[id] || { att: 0, fill: 0, w: 0, l: 0, pnl: 0, losses: [] }, s = this.lastB15[id];
      const label = B15_LABEL[id] || `B15 ${id}`;
      const total = s ? `total ${usd(s.pnl)} (${s.w}-${s.l}), intentos ${s.attempts}, llenadas ${s.filled}, abiertas ${s.open}` : 'total sin dato';
      return `${label}: intentos ${B.att}, llenadas ${B.fill}, ${B.w}-${B.l} ${usd(B.pnl)}; ${total}${B.losses.length ? `; pérdidas: ${B.losses.join('; ')}` : ''}`;
    });
  }

  _bTotal() {
    const s = this.lastB;
    if (!s) return 'total sin dato';
    return `total ${usd(s.pnl)} (${s.w}-${s.l})${s.rest ? `, REST ${usd(s.rest.pnl)} (${s.rest.w}-${s.rest.l})` : ''}${s.rest2 ? `, REST +${s.rest2.ms}ms ${usd(s.rest2.pnl)} (${s.rest2.w}-${s.rest2.l})` : ''}${s.open != null ? `, abiertas ${s.open}` : ''}`;
  }
}

// ms hasta el próximo HH:20:00 UTC
function msToNextEmit(now = Date.now()) {
  const d = new Date(now);
  d.setUTCMinutes(EMIT_MINUTE, 0, 0);
  if (d.getTime() <= now) d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime() - now;
}

const digest = new LogDigest();
let timer = null;
function schedule() {
  timer = setTimeout(() => {
    try { for (const l of digest.report()) emitLine(l); } catch (_) { /* solo registro */ }
    schedule();
  }, msToNextEmit());
  if (timer.unref) timer.unref();
}
if (ENABLED) schedule();

module.exports = {
  observe: ENABLED ? (level, prefix, body) => { try { digest.observe(level, prefix, body); } catch (_) { /* solo registro */ } } : () => {},
  LogDigest, msToNextEmit,
};
