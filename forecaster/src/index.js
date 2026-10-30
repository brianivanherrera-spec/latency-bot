'use strict';
const { config } = require('./config');
const { log, utcDate, readJsonl } = require('./util');
const pipeline = require('./pipeline');
const { computeReport, summaryLine } = require('./metrics');
const server = require('./server');

process.on('uncaughtException', (e) => { log(`excepcion no capturada: ${e.stack || e.message}`); server.status.lastError = e.message; });
process.on('unhandledRejection', (e) => { log(`promesa rechazada: ${e && e.stack || e}`); server.status.lastError = String(e); });

let busy = false;
let lastHourly = 0;
let summaryDate = null;

async function safe(name, fn) {
  try { return await fn(); } catch (e) { log(`fallo en ${name}: ${e.message}`); server.status.lastError = `${name}: ${e.message}`; }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = new Date();
    const today = utcDate(now);
    if (now.getUTCHours() >= config().SELECT_HOUR_UTC && !readJsonl('selections.jsonl').some((r) => r.date === today && r.target >= config().MARKETS_PER_DAY)) {
      await safe('seleccion', () => pipeline.runSelection(today));
      server.status.lastSelection = new Date().toISOString();
    }
    if (Date.now() - lastHourly >= 36e5) {
      lastHourly = Date.now();
      const f = await safe('pronosticos', () => pipeline.ingestForecasts());
      const r = await safe('resoluciones', () => pipeline.checkResolutions());
      const s = await safe('snapshots', () => pipeline.takeSnapshots());
      log(`ciclo horario: pronosticos nuevos=${f ?? 'err'} resoluciones=${r ?? 'err'} snapshots=${s ?? 'err'}`);
      await safe('cartera', async () => { const v = await pipeline.valorCartera(); log(v.resumen); const b = pipeline.carteraB(v.st, v.rows); log(b.resumen); log(`COMPARA pnl_total A=${(v.realizado + v.noReal).toFixed(2)} B=${b.total.toFixed(2)}`); });
      server.status.lastHourly = new Date().toISOString();
    }
    if (summaryDate !== today && now.getUTCHours() >= config().SELECT_HOUR_UTC) {
      const st = pipeline.loadState();
      log(summaryLine(st, computeReport(st)));
      await safe('valor posiciones', async () => { const v = await pipeline.valorCartera(st); for (const l of v.lines) log(l); for (const l of pipeline.reportePorTramo(st, v.rows)) log(l); });
      summaryDate = today;
    }
  } finally { busy = false; }
}

// Detalle de posiciones abiertas (paper) para supervision; no se usa en la investigacion.
function logPosiciones() {
  const st = pipeline.loadState();
  for (const d of st.decisions) {
    if (d.action !== 'comprar' || st.resolved.has(d.market_id)) continue;
    log(pipeline.posicionLine(d));
  }
}

function main() {
  const c = config();
  log(`iniciando (solo paper, sin ordenes reales). DATA_DIR=${c.DATA_DIR} MARKETS_PER_DAY=${c.MARKETS_PER_DAY}`);
  server.start();
  try { logPosiciones(); } catch (e) { log(`posiciones: ${e.message}`); }
  pipeline.valorCartera().then((v) => { v.lines.forEach((l) => log(l)); log(v.resumen); log(pipeline.carteraB(v.st, v.rows).resumen); pipeline.reportePorTramo(pipeline.loadState(), v.rows).forEach((l) => log(l)); }).catch((e) => log(`valor cartera: ${e.message}`));
  setInterval(() => tick().catch((e) => log(`tick: ${e.message}`)), 60000);
  tick().catch((e) => log(`tick: ${e.message}`));
}

if (require.main === module) main();
module.exports = { tick };
