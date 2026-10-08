/**
 * Monitor del event loop — para encontrar qué provoca los cortes 1013 "slow consumer".
 *
 * Cada 60 s deja una línea [LOOP] con:
 *   - retraso del event loop (p50 / p99 / máx) medido con perf_hooks
 *   - CPU del proceso en el intervalo (% de un núcleo) y heap usado
 *   - bloqueos >200 ms detectados (cantidad)
 *   - tiempo total y máximo por sección instrumentada con time(tag, fn)
 *   - latencia del threadpool de libuv (sondeo con fs.stat cada 1 s) y la escritura a
 *     disco más lenta del intervalo
 * Además, snapshot() devuelve lo mismo para loguearlo al momento de un corte del WS.
 */
'use strict';
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');

// logger.js usa este módulo (mide stdout), así que el Logger se pide recién al usarlo
let _logger = null;
const log = msg => {
  if (!_logger) { const { Logger } = require('./logger'); _logger = new Logger('LOOP'); }
  _logger.info(msg);
};
const INTERVAL_MS = parseInt(process.env.LOOP_MONITOR_MS || '60000');
const BLOCK_MS = parseInt(process.env.LOOP_BLOCK_MS || '200');

const hist = monitorEventLoopDelay({ resolution: 10 });
hist.enable();

let sections = new Map(); // tag -> { n, totalMs, maxMs }
let tpSamples = [];       // latencias del sondeo del threadpool (ms)
let disk = { n: 0, maxMs: 0 }; // escrituras a disco (async-append y shadow)
let counters = new Map(); // tag -> n
let blocks = 0;
let worstBlock = 0;
let lastCpu = process.cpuUsage();
let lastAt = Date.now();

// Detector de bloqueos: un timer cada 100 ms; si llega tarde, el loop estuvo trabado
let expected = Date.now() + 100;
const blockTimer = setInterval(() => {
  const now = Date.now();
  const late = now - expected;
  if (late > BLOCK_MS) { blocks++; if (late > worstBlock) worstBlock = late; }
  expected = now + 100;
}, 100);
if (blockTimer.unref) blockTimer.unref();

// Sondeo del threadpool de libuv (lo usan fs.promises, la descompresión permessage-deflate
// de los WebSocket y dns): cada TP_PROBE_MS un fs.stat chico; si tarda, el threadpool está
// ocupado (p. ej. escrituras lentas al volumen) aunque el event loop esté libre.
const TP_PROBE_MS = parseInt(process.env.LOOP_TP_PROBE_MS || '1000');
if (TP_PROBE_MS > 0) {
  const tpTimer = setInterval(() => {
    const t0 = process.hrtime.bigint();
    fs.stat(__dirname, () => {
      tpSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (tpSamples.length > 5000) tpSamples.shift();
    });
  }, TP_PROBE_MS);
  if (tpTimer.unref) tpTimer.unref();
}

// Duración de una escritura a disco (para ver si el volumen se traba)
function observeDisk(msTaken) {
  disk.n++;
  if (msTaken > disk.maxMs) disk.maxMs = msTaken;
}

// Mide una sección sincrónica. Devuelve lo que devuelva fn.
function time(tag, fn) {
  const t0 = process.hrtime.bigint();
  try { return fn(); } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    let s = sections.get(tag);
    if (!s) { s = { n: 0, totalMs: 0, maxMs: 0 }; sections.set(tag, s); }
    s.n++; s.totalMs += ms; if (ms > s.maxMs) s.maxMs = ms;
  }
}

function count(tag, n = 1) { counters.set(tag, (counters.get(tag) || 0) + n); }

const ms = ns => (ns / 1e6).toFixed(0);

function snapshot() {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  const elapsed = Math.max(1, now - lastAt);
  const cpuPct = ((cpu.user + cpu.system) / 1000 / elapsed) * 100;
  const top = [...sections.entries()]
    .sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 4)
    .map(([k, s]) => `${k}=${s.totalMs.toFixed(0)}ms/${s.n} (máx ${s.maxMs.toFixed(0)})`);
  const cnt = [...counters.entries()].map(([k, n]) => `${k}=${Math.round(n)}`);
  const tp = [...tpSamples].sort((a, b) => a - b);
  const tpP99 = tp.length ? tp[Math.min(tp.length - 1, Math.floor(tp.length * 0.99))] : null;
  const tpMax = tp.length ? tp[tp.length - 1] : null;
  const tpText = tp.length ? ` | threadpool p99=${tpP99.toFixed(0)}ms máx=${tpMax.toFixed(0)}ms (n=${tp.length})` : '';
  const diskText = disk.n ? ` | disco máx=${disk.maxMs.toFixed(0)}ms (n=${disk.n})` : '';
  return {
    text: `lag p50=${ms(hist.percentile(50))}ms p99=${ms(hist.percentile(99))}ms máx=${ms(hist.max)}ms | bloqueos>${BLOCK_MS}ms=${blocks} (peor ${worstBlock}ms) | CPU ${cpuPct.toFixed(0)}% | heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB` +
      tpText + diskText +
      (cnt.length ? ` | ${cnt.join(' ')}` : '') + (top.length ? ` | ${top.join(' ')}` : ''),
    blocks, worstBlock, cpuPct, maxLagMs: hist.max / 1e6, tpMaxMs: tpMax, diskMaxMs: disk.n ? disk.maxMs : null,
  };
}

function reset() {
  hist.reset();
  sections = new Map();
  counters = new Map();
  tpSamples = [];
  disk = { n: 0, maxMs: 0 };
  blocks = 0; worstBlock = 0;
  lastCpu = process.cpuUsage(); lastAt = Date.now();
}

const reportTimer = setInterval(() => {
  log(snapshot().text);
  reset();
}, INTERVAL_MS);
if (reportTimer.unref) reportTimer.unref();

module.exports = { time, count, snapshot, log, observeDisk };
