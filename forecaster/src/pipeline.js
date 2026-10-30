'use strict';
const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { log, appendJsonl, readJsonl, utcDate } = require('./util');
const gamma = require('./gamma');
const clob = require('./clob');
const { decide } = require('./decision');

const forecastsDir = () => process.env.FORECASTS_DIR || path.join(__dirname, '..', 'forecasts');
const HORIZONS = { '24h': 24, '72h': 72, '7d': 168 };
const fkey = (date, id) => `${date}:${id}`;

// Todo el estado se reconstruye desde los jsonl.
function loadState() {
  const candidates = readJsonl('candidates.jsonl');
  const forecasts = readJsonl('forecasts.jsonl');
  const decisions = readJsonl('decisions.jsonl');
  const resolutions = readJsonl('resolutions.jsonl');
  const snapshots = readJsonl('snapshots.jsonl');
  const resolved = new Set(resolutions.map((r) => r.market_id));
  const lastForecastMid = new Map();
  for (const f of forecasts) if (f.mid_yes !== null) lastForecastMid.set(f.market_id, f.mid_yes);
  const openByEvent = new Map();
  let openUsd = 0;
  for (const d of decisions) {
    if (d.action !== 'comprar' || resolved.has(d.market_id)) continue;
    openUsd += d.stake_usd;
    openByEvent.set(d.event_id, (openByEvent.get(d.event_id) || 0) + 1);
  }
  return { candidates, forecasts, decisions, resolutions, snapshots, resolved, lastForecastMid, portfolio: { openUsd, openByEvent } };
}

// Linea de supervision de una posicion paper (incluye precio de entrada y pago).
function posicionLine(d) {
  const gana = d.shares - d.stake_usd - d.fee_usd;
  return `POSICION ${d.market_id} ${d.side} gastado=$${d.stake_usd.toFixed(2)} precio_medio=${d.avg_price.toFixed(3)} acciones=${d.shares.toFixed(2)} comision=$${d.fee_usd.toFixed(2)} si_gana=+$${gana.toFixed(2)} si_pierde=-$${(d.stake_usd + d.fee_usd).toFixed(2)}`;
}

// Lineas de supervision al resolver un mercado: resultado y pago de cada posicion paper.
function resolucionLines(id, question, outcomeYes, decisions) {
  const lines = [`RESOLUCION ${id} resultado=${outcomeYes ? 'SI' : 'NO'} ${question || ''}`.trim()];
  for (const d of decisions) {
    if (d.action !== 'comprar' || d.market_id !== id) continue;
    const gano = (d.side === 'SI') === Boolean(outcomeYes);
    const pnl = gano ? d.shares - d.stake_usd - d.fee_usd : -(d.stake_usd + d.fee_usd);
    lines.push(`RESOLUCION ${id} ${d.side} ${gano ? 'GANO' : 'PERDIO'} gastado=$${d.stake_usd.toFixed(2)} pnl=${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
  }
  return lines;
}

async function runSelection(date = utcDate()) {
  const st = loadState();
  const c = config();
  const todayRows = st.candidates.filter((r) => r.date === date);
  const done = readJsonl('selections.jsonl').some((r) => r.date === date && r.target >= c.MARKETS_PER_DAY);
  const remaining = c.MARKETS_PER_DAY - todayRows.length;
  if (done || remaining <= 0) { log(`seleccion de ${date} ya hecha (${todayRows.length} mercados)`); return []; }
  const events = await gamma.fetchEvents();
  const todayIds = new Set(todayRows.map((r) => r.market.market_id));
  const picked = gamma.selectMarkets(events, st.lastForecastMid, todayIds, remaining);
  for (const m of picked) {
    let books = {};
    try {
      const [yes, no] = await Promise.all([clob.fetchBook(m.token_yes), clob.fetchBook(m.token_no)]);
      books = { yes: clob.snapshotBook(yes), no: clob.snapshotBook(no) };
    } catch (e) { log(`no se pudo leer el libro de ${m.market_id}: ${e.message}`); }
    const ts = new Date().toISOString();
    appendJsonl('candidates.jsonl', { ts, date, market: m });
    appendJsonl('books.jsonl', { ts, kind: 'seleccion', market_id: m.market_id, liquidity: m.liquidity, fees_enabled: m.fees_enabled, fee_schedule: m.fee_schedule, ...books });
    // linea de log por mercado (canal de respaldo para la investigacion), sin precios
    log(`CANDIDATO ${date} ${JSON.stringify(gamma.publicCandidate(m))}`);
  }
  appendJsonl('selections.jsonl', { ts: new Date().toISOString(), date, target: c.MARKETS_PER_DAY, nuevos: picked.length });
  log(`seleccion de ${date}: ${picked.length} mercados nuevos (total hoy ${todayRows.length + picked.length}) de ${events.length} eventos`);
  return picked;
}

function publishedCandidates(date) {
  const rows = readJsonl('candidates.jsonl').filter((r) => !date || r.date === date);
  const last = date || rows.map((r) => r.date).sort().pop();
  return { date: last, markets: rows.filter((r) => r.date === last).map((r) => gamma.publicCandidate(r.market)) };
}

function readForecastFiles() {
  let names = [];
  try { names = fs.readdirSync(forecastsDir()).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(forecastsDir(), n), 'utf8'));
      const arr = Array.isArray(j) ? j : j.forecasts || [];
      for (const f of arr) out.push({ date: n.slice(0, 10), ...f });
    } catch (e) { log(`archivo de pronosticos ${n} ilegible: ${e.message}`); }
  }
  return out;
}

async function ingestForecasts() {
  const st = loadState();
  const done = new Set(st.forecasts.map((f) => fkey(f.date, f.market_id)));
  const cand = new Map(st.candidates.map((r) => [fkey(r.date, r.market.market_id), r.market]));
  let n = 0;
  for (const f of readForecastFiles()) {
    const id = String(f.market_id);
    const key = fkey(f.date, id);
    if (done.has(key)) continue;
    const market = cand.get(key);
    const p = Number(f.p_yes);
    if (!market) { log(`pronostico ${key} ignorado: el mercado no estaba en la lista de ese dia`); done.add(key); continue; }
    if (!(p > 0 && p < 1)) { log(`pronostico ${key} ignorado: p_yes invalido (${f.p_yes})`); done.add(key); continue; }
    let yes, no;
    try { [yes, no] = await Promise.all([clob.fetchBook(market.token_yes), clob.fetchBook(market.token_no)]); }
    catch (e) { log(`pronostico ${key}: sin libro (${e.message}), se reintenta luego`); continue; }
    const mid_yes = yes.mid ?? (no.mid !== null ? 1 - no.mid : null);
    if (mid_yes === null) { log(`pronostico ${key}: libro vacio, se reintenta luego`); continue; }
    const ts = new Date().toISOString();
    const row = {
      ts, date: f.date, key, market_id: id, event_id: market.event_id, category: market.category, end_date: market.end_date,
      p_yes: Math.min(0.99, Math.max(0.01, p)), confidence: f.confidence ?? null, reasoning: f.reasoning ?? '',
      key_uncertainties: f.key_uncertainties ?? [], sources: f.sources ?? [], prompt_version: f.prompt_version ?? null, mid_yes,
    };
    const books = { yes: clob.snapshotBook(yes), no: clob.snapshotBook(no) };
    appendJsonl('books.jsonl', { ts, kind: 'decision', market_id: id, key, liquidity: market.liquidity, fees_enabled: market.fees_enabled, fee_schedule: market.fee_schedule, ...books });
    appendJsonl('forecasts.jsonl', row);
    const d = decide({ forecast: row, market, books: { yes, no }, portfolio: st.portfolio });
    const dec = { ts, key, market_id: id, event_id: market.event_id, category: market.category, ...d };
    appendJsonl('decisions.jsonl', dec);
    if (d.action === 'comprar') {
      st.portfolio.openUsd += d.stake_usd;
      st.portfolio.openByEvent.set(market.event_id, (st.portfolio.openByEvent.get(market.event_id) || 0) + 1);
      log(`PAPER compra ${d.side} ${id} $${d.stake_usd.toFixed(2)}`);
      log(posicionLine({ ...d, market_id: id }));
    } else log(`PAPER omitido ${id}: ${d.reason}`);
    done.add(key);
    n++;
  }
  return n;
}

async function checkResolutions() {
  const st = loadState();
  const ids = [...new Set(st.forecasts.map((f) => f.market_id))].filter((id) => !st.resolved.has(id));
  let n = 0;
  for (const id of ids) {
    let m;
    try { m = await gamma.fetchMarket(id); } catch (e) { log(`resolucion ${id}: ${e.message}`); continue; }
    if (!m || !m.closed) continue;
    const prices = require('./util').parseField(m.outcomePrices);
    const outcomes = require('./util').parseField(m.outcomes);
    if (!prices || !outcomes) continue;
    const iy = outcomes.findIndex((o) => String(o).toLowerCase() === 'yes');
    const py = Number(prices[iy]);
    const disputed = /dispute/i.test(String(m.umaResolutionStatus || ''));
    if (disputed || !(py >= 0.99 || py <= 0.01)) { log(`resolucion ${id}: anulado/disputado/sin resultado claro, queda afuera`); continue; }
    const outcome_yes = py >= 0.99 ? 1 : 0;
    appendJsonl('resolutions.jsonl', { ts: new Date().toISOString(), market_id: id, outcome_yes });
    for (const l of resolucionLines(id, m.question, outcome_yes, st.decisions)) log(l);
    n++;
  }
  return n;
}

// Valor actual de las posiciones abiertas (mark-to-market) con P&L realizado y total.
// "actual" = precio medio del libro del lado comprado; "bid" = lo que se obtendria vendiendo ya.
const usd = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toFixed(2)}`;

function valorLine(d, b) {
  const costo = d.stake_usd + (d.fee_usd || 0);
  if (!b || b.mid === null) return `VALOR ${d.market_id} ${d.side} entrada=${d.avg_price.toFixed(3)} actual=sin_precio costo=$${costo.toFixed(2)}`;
  const vMid = d.shares * b.mid;
  const bid = b.bid ?? 0;
  return `VALOR ${d.market_id} ${d.side} entrada=${d.avg_price.toFixed(3)} actual=${b.mid.toFixed(3)} bid=${bid.toFixed(3)} valor=$${vMid.toFixed(2)} pnl=${usd(vMid - costo)} pnl_al_bid=${usd(d.shares * bid - costo)}`;
}

async function valorCartera(st = loadState(), fetchBook = clob.fetchBook) {
  const open = st.decisions.filter((d) => d.action === 'comprar' && !st.resolved.has(d.market_id));
  const outcome = new Map(st.resolutions.map((r) => [r.market_id, r.outcome_yes]));
  let realizado = 0;
  for (const d of st.decisions) {
    if (d.action !== 'comprar' || !st.resolved.has(d.market_id)) continue;
    const gano = (d.side === 'SI') === Boolean(outcome.get(d.market_id));
    realizado += (gano ? d.shares : 0) - d.stake_usd - (d.fee_usd || 0);
  }
  const rows = [];
  for (let i = 0; i < open.length; i += 8) {
    const chunk = open.slice(i, i + 8);
    const books = await Promise.all(chunk.map((d) => fetchBook(d.token).catch(() => null)));
    chunk.forEach((d, j) => rows.push({ d, b: books[j] }));
  }
  let invertido = 0, vMid = 0, vBid = 0, sinPrecio = 0;
  for (const { d, b } of rows) {
    const costo = d.stake_usd + (d.fee_usd || 0);
    invertido += costo;
    if (!b || b.mid === null) { sinPrecio++; vMid += costo; vBid += costo; continue; }
    vMid += d.shares * b.mid;
    vBid += d.shares * (b.bid ?? 0);
  }
  const noReal = vMid - invertido, noRealBid = vBid - invertido;
  const resumen = `CARTERA abiertas=${open.length} invertido=$${invertido.toFixed(2)} valor_actual=$${vMid.toFixed(2)} pnl_no_realizado=${usd(noReal)} (al bid ${usd(noRealBid)}) pnl_realizado=${usd(realizado)} pnl_total=${usd(realizado + noReal)} (al bid ${usd(realizado + noRealBid)}) sin_precio=${sinPrecio}`;
  return { st, rows, lines: rows.map(({ d, b }) => valorLine(d, b)), resumen, realizado, noReal, noRealBid, invertido, abiertas: open.length, sinPrecio };
}

// Rendimiento por tramo (precio de entrada, edge, divergencia con el mercado, confianza, categoria, horizonte).
// Cerradas: P&L real y aciertos. Abiertas: P&L a precio actual (si hay libro). No cambia ninguna decision.
function tramoDe(d, f) {
  const precio = d.avg_price < 0.1 ? 'precio<0.10' : d.avg_price < 0.3 ? 'precio 0.10-0.30' : d.avg_price <= 0.7 ? 'precio 0.30-0.70' : 'precio>0.70';
  const e = d.edge ?? 0;
  const edge = e < 0.12 ? 'edge 0.08-0.12' : e < 0.2 ? 'edge 0.12-0.20' : 'edge>=0.20';
  let div = 'diverg sin_dato';
  if (f && f.mid_yes !== null && f.mid_yes !== undefined) {
    const x = Math.abs(f.p_yes - f.mid_yes);
    div = x < 0.15 ? 'diverg<0.15' : x < 0.3 ? 'diverg 0.15-0.30' : 'diverg>=0.30';
  }
  const conf = `confianza ${f?.confidence || 'sin_dato'}`;
  const cat = `categoria ${d.category || 'sin_dato'}`;
  let hor = 'horizonte sin_dato';
  if (f && f.end_date) {
    const dias = (Date.parse(f.end_date) - Date.parse(f.ts)) / 864e5;
    hor = dias <= 3 ? 'horizonte<=3d' : dias <= 10 ? 'horizonte 4-10d' : dias <= 30 ? 'horizonte 11-30d' : 'horizonte>30d';
  }
  return [precio, edge, div, conf, cat, hor];
}

function reportePorTramo(st, rows = []) {
  const outcome = new Map(st.resolutions.map((r) => [r.market_id, r.outcome_yes]));
  const fByKey = new Map(st.forecasts.map((f) => [f.key, f]));
  const mtm = new Map();
  const dk = (d) => `${d.key}|${d.ts}|${d.side}|${d.stake_usd}`;
  for (const { d, b } of rows) mtm.set(dk(d), b);
  const g = new Map();
  for (const d of st.decisions) {
    if (d.action !== 'comprar') continue;
    const costo = d.stake_usd + (d.fee_usd || 0);
    const cerrada = st.resolved.has(d.market_id);
    let pnl = null, gano = false;
    if (cerrada) { gano = (d.side === 'SI') === Boolean(outcome.get(d.market_id)); pnl = (gano ? d.shares : 0) - costo; }
    else { const b = mtm.get(dk(d)); if (b && b.mid !== null) pnl = d.shares * b.mid - costo; }
    for (const t of tramoDe(d, fByKey.get(d.key))) {
      const r = g.get(t) || { n: 0, cerradas: 0, ganadas: 0, real: 0, abiertas: 0, noReal: 0, invertido: 0 };
      r.n++; r.invertido += costo;
      if (cerrada) { r.cerradas++; if (gano) r.ganadas++; r.real += pnl; }
      else { r.abiertas++; if (pnl !== null) r.noReal += pnl; }
      g.set(t, r);
    }
  }
  return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, r]) =>
    `TRAMO ${t} n=${r.n} invertido=$${r.invertido.toFixed(2)} cerradas=${r.cerradas} ganadas=${r.ganadas} pnl_real=${usd(r.real)} abiertas=${r.abiertas} pnl_no_realizado=${usd(r.noReal)} total=${usd(r.real + r.noReal)}`);
}

// Estrategia B (solo paper, sombra de la A): subconjunto de las compras de A que cumplen reglas mas estrictas.
// Reglas: precio de entrada >= 0.30; |p_yes - mid al pronosticar| <= 0.15; una posicion por mercado;
// una posicion abierta por evento. No cambia ninguna compra real de A; se mide en paralelo.
const dkey = (d) => `${d.key}|${d.ts}|${d.side}|${d.stake_usd}`;

function estrategiaB(st) {
  const fBy = new Map(st.forecasts.map((f) => [f.key, f]));
  const ordenadas = st.decisions.filter((d) => d.action === 'comprar').sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const mercados = new Set(), eventosAbiertos = new Set(), out = [];
  for (const d of ordenadas) {
    const f = fBy.get(d.key);
    if (!f || f.mid_yes === null || f.mid_yes === undefined) continue;
    if (d.avg_price < 0.3) continue;
    if (Math.abs(f.p_yes - f.mid_yes) > 0.15) continue;
    if (mercados.has(d.market_id)) continue;
    if (eventosAbiertos.has(d.event_id)) continue;
    mercados.add(d.market_id);
    if (!st.resolved.has(d.market_id)) eventosAbiertos.add(d.event_id);
    out.push(d);
  }
  return out;
}

function carteraB(st, rows = []) {
  const b = estrategiaB(st);
  const claves = new Set(b.map(dkey));
  const outcome = new Map(st.resolutions.map((r) => [r.market_id, r.outcome_yes]));
  let realizado = 0, invertido = 0, vMid = 0, vBid = 0, abiertas = 0;
  for (const d of b) {
    if (!st.resolved.has(d.market_id)) continue;
    const gano = (d.side === 'SI') === Boolean(outcome.get(d.market_id));
    realizado += (gano ? d.shares : 0) - d.stake_usd - (d.fee_usd || 0);
  }
  for (const { d, b: libro } of rows) {
    if (!claves.has(dkey(d))) continue;
    const costo = d.stake_usd + (d.fee_usd || 0);
    abiertas++; invertido += costo;
    if (!libro || libro.mid === null) { vMid += costo; vBid += costo; continue; }
    vMid += d.shares * libro.mid; vBid += d.shares * (libro.bid ?? 0);
  }
  const noReal = vMid - invertido, noRealBid = vBid - invertido;
  const resumen = `CARTERA_B abiertas=${abiertas} invertido=$${invertido.toFixed(2)} valor_actual=$${vMid.toFixed(2)} pnl_no_realizado=${usd(noReal)} (al bid ${usd(noRealBid)}) pnl_realizado=${usd(realizado)} pnl_total=${usd(realizado + noReal)} (al bid ${usd(realizado + noRealBid)}) compras_b=${b.length}`;
  return { resumen, b, realizado, noReal, noRealBid, invertido, abiertas, total: realizado + noReal };
}

async function takeSnapshots(now = Date.now()) {
  const st = loadState();
  const have = new Set(st.snapshots.map((s) => `${s.key}|${s.horizon}`));
  const cand = new Map(st.candidates.map((r) => [fkey(r.date, r.market.market_id), r.market]));
  let n = 0;
  for (const f of st.forecasts) {
    if (st.resolved.has(f.market_id)) continue;
    for (const [h, hours] of Object.entries(HORIZONS)) {
      if (have.has(`${f.key}|${h}`) || now < Date.parse(f.ts) + hours * 36e5) continue;
      const market = cand.get(f.key);
      if (!market) continue;
      try {
        const yes = await clob.fetchBook(market.token_yes);
        if (yes.mid === null) continue;
        appendJsonl('snapshots.jsonl', { ts: new Date().toISOString(), key: f.key, market_id: f.market_id, horizon: h, mid_yes: yes.mid });
        n++;
      } catch (e) { log(`snapshot ${f.key} ${h}: ${e.message}`); }
    }
  }
  return n;
}

module.exports = { posicionLine, resolucionLines, valorLine, valorCartera, reportePorTramo, tramoDe, estrategiaB, carteraB, loadState, runSelection, publishedCandidates, ingestForecasts, checkResolutions, takeSnapshots, readForecastFiles, HORIZONS };
