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
      log(`PAPER compra ${d.side} ${id} $${d.stake_usd.toFixed(2)} (detalle de precios solo en /data, no en logs)`);
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
    appendJsonl('resolutions.jsonl', { ts: new Date().toISOString(), market_id: id, outcome_yes: py >= 0.99 ? 1 : 0 });
    n++;
  }
  return n;
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

module.exports = { loadState, runSelection, publishedCandidates, ingestForecasts, checkResolutions, takeSnapshots, readForecastFiles, HORIZONS };
