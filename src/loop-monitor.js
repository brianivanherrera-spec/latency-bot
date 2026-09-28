/**
 * Monitor del event loop — para encontrar qué provoca los cortes 1013 "slow consumer".
 *
 * Cada 60 s deja una línea [LOOP] con:
 *   - retraso del event loop (p50 / p99 / máx) medido con perf_hooks
 *   - CPU del proceso en el intervalo (% de un núcleo) y heap usado
 *   - bloqueos >200 ms detectados (cantidad)
 *   - tiempo total y máximo por sección instrumentada con time(tag, fn)
 * Además, snapshot() devuelve lo mismo para loguearlo al momento de un corte del WS.
 */
'use strict';
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
  return {
    text: `lag p50=${ms(hist.percentile(50))}ms p99=${ms(hist.percentile(99))}ms máx=${ms(hist.max)}ms | bloqueos>${BLOCK_MS}ms=${blocks} (peor ${worstBlock}ms) | CPU ${cpuPct.toFixed(0)}% | heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB` +
      (cnt.length ? ` | ${cnt.join(' ')}` : '') + (top.length ? ` | ${top.join(' ')}` : ''),
    blocks, worstBlock, cpuPct, maxLagMs: hist.max / 1e6,
  };
}

function reset() {
  hist.reset();
  sections = new Map();
  counters = new Map();
  blocks = 0; worstBlock = 0;
  lastCpu = process.cpuUsage(); lastAt = Date.now();
}

const reportTimer = setInterval(() => {
  log(snapshot().text);
  reset();
}, INTERVAL_MS);
if (reportTimer.unref) reportTimer.unref();

module.exports = { time, count, snapshot, log };
