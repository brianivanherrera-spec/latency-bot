#!/usr/bin/env node
/**
 * Informe de ejecución: cómo se llenan las órdenes (real y paper) — SOLO LECTURA.
 *
 * Lee /data/fills.jsonl (un registro por intento de compra), /data/signals.jsonl (resultado y
 * P&L de cada posición) y /data/shadow-markets.jsonl (ganador oficial de cada mercado) y mide,
 * por modo (live / paper):
 *   - llenado: intentos, llenadas, parciales, % de llenado y motivos de los sin-fill
 *   - sobreprecio: precio pagado − ask al decidir (promedio y p90)
 *   - latencia (real): decisión→envío, envío→respuesta del CLOB, decisión→fill
 *   - selección adversa: % de acierto de las llenadas contra el de las no llenadas (si
 *     hubieran entrado al ask de la decisión) y el EV/acc que se perdió en las no llenadas
 *   - P&L de las llenadas según signals.jsonl
 *   - en real: lo que habría dicho paper sobre las mismas órdenes (paper_would_fill) contra
 *     lo que pasó, para saber cuánto sobreestima paper el llenado
 *
 * Uso: node scripts/exec-report.js [dataDir]   (EXEC_REPORT_SINCE=ISO para acotar)
 * Escribe dataDir/exec-report.json y líneas [EJECUCION].
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FEE = parseFloat(process.env.TAKER_FEE_RATE || '0.072');
const fee = p => FEE * p * (1 - p);
const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const pctl = (arr, q) => {
  const a = arr.filter(v => v != null && isFinite(v)).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : null;
};
const mean = arr => { const a = arr.filter(v => v != null && isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
const r4 = v => (v == null ? null : +v.toFixed(4));

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

// Ganador del mercado de un intento: por fin del mercado (exec.market_end_ms) o, en registros
// viejos sin exec, por la hora de la decisión dentro de [start_ts, end_ts].
function winnerFinder(markets) {
  const ms = markets.filter(m => (m.winner === 'UP' || m.winner === 'DOWN') && m.end_ts)
    .map(m => ({ start: m.start_ts, end: m.end_ts, winner: m.winner })).sort((a, b) => a.end - b.end);
  return (endMs, tMs) => {
    if (endMs) { const m = ms.find(x => Math.abs(x.end - endMs) < 30_000); if (m) return m.winner; }
    if (tMs) { const m = ms.find(x => tMs >= x.start - 2000 && tMs < x.end); if (m) return m.winner; }
    return null;
  };
}

function noFillReason(f) {
  const e = f.exec || {};
  const px = num(f.order_price);
  if (e.mode === 'paper' || (!e.mode && /Paper mode/.test(f.rejection_reason || ''))) {
    if (e.fill_ask_delay != null && px != null && e.fill_ask_delay > px + 1e-9) return 'ask subió por encima del límite';
    if (e.size_delay != null && f.order_size != null && e.size_delay < f.order_size) return 'sin tamaño hasta el límite';
    return 'paper (sin detalle)';
  }
  return String(f.rejection_reason || f.order_status || 'desconocido').slice(0, 60);
}

function buildReport({ fills, signals, markets, since = null }) {
  const sigById = new Map(signals.filter(s => s.posId).map(s => [s.posId, s]));
  const winnerOf = winnerFinder(markets);
  const report = { generatedAt: new Date().toISOString(), since, modes: {} };
  for (const f of fills) {
    const t = f.latencies?.t3_price_decision_ms ?? f.timestamp;
    if (since && t < since) continue;
    const s = sigById.get(f.posId);
    const mode = f.exec?.mode || s?.mode || (/Paper mode|simulated/.test(`${f.rejection_reason} ${f.order_status}`) ? 'paper' : 'live');
    const M = report.modes[mode] ||= { rows: [] };
    const e = f.exec || {};
    const filled = f.fill_result === 'FILLED';
    const dir = f.signal_direction || s?.direction;
    const winner = winnerOf(e.market_end_ms, t);
    const decisionAsk = num(e.decision_ask) ?? num(f.best_ask);
    const fillPrice = num(e.fill_price) ?? (filled ? num(f.order_price) : null);
    M.rows.push({
      posId: f.posId, t, filled, dir, winner, decisionAsk, fillPrice,
      partial: filled && (e.partial || (num(f.size_filled) != null && num(f.order_size) != null && num(f.size_filled) < num(f.order_size))),
      reason: filled ? null : noFillReason(f),
      lat: f.latencies || null,
      paperWouldFill: e.paper_would_fill ?? null,
      result: s?.result ?? null, pnl: num(s?.pnl),
    });
  }
  for (const [mode, M] of Object.entries(report.modes)) {
    const R = M.rows, F = R.filter(r => r.filled), N = R.filter(r => !r.filled);
    const reasons = {};
    for (const r of N) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    const slip = F.filter(r => r.fillPrice != null && r.decisionAsk != null).map(r => r.fillPrice - r.decisionAsk);
    const wr = rows => { const k = rows.filter(r => r.winner); return { n: k.length, wr: k.length ? r4(k.filter(r => r.winner === r.dir).length / k.length) : null }; };
    const missed = N.filter(r => r.winner && r.decisionAsk != null && r.decisionAsk < 0.99);
    const closed = F.filter(r => r.result === 'WIN' || r.result === 'LOSS');
    const out = {
      attempts: R.length, filled: F.length, fillRate: R.length ? r4(F.length / R.length) : null,
      partial: F.filter(r => r.partial).length,
      noFillReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5),
      slippage: { n: slip.length, mean: r4(mean(slip)), p90: r4(pctl(slip, 0.9)) },
      latencyMs: mode === 'live' ? {
        decisionToSend: { p50: pctl(R.map(r => r.lat?.t3_to_t4_ms), 0.5), p90: pctl(R.map(r => r.lat?.t3_to_t4_ms), 0.9) },
        sendToResponse: { p50: pctl(R.map(r => r.lat?.t4_to_t5_ms), 0.5), p90: pctl(R.map(r => r.lat?.t4_to_t5_ms), 0.9) },
        decisionToFill: { p50: pctl(F.map(r => r.lat?.t3_to_t7_ms), 0.5), p90: pctl(F.map(r => r.lat?.t3_to_t7_ms), 0.9) },
      } : null,
      adverse: {
        filled: wr(F), notFilled: wr(N),
        missedEvPerShare: missed.length ? r4(mean(missed.map(r => (r.winner === r.dir ? 1 - r.decisionAsk : -r.decisionAsk) - fee(r.decisionAsk)))) : null,
        missedN: missed.length,
      },
      pnl: { closed: closed.length, wins: closed.filter(r => r.result === 'WIN').length,
        total: r4(closed.reduce((a, r) => a + (r.pnl || 0), 0)) },
    };
    if (mode === 'live') {
      const k = R.filter(r => r.paperWouldFill != null);
      const both = k.filter(r => r.paperWouldFill && r.filled).length, paperOnly = k.filter(r => r.paperWouldFill && !r.filled).length;
      const realOnly = k.filter(r => !r.paperWouldFill && r.filled).length, neither = k.filter(r => !r.paperWouldFill && !r.filled).length;
      out.paperVsReal = { n: k.length, both, paperOnly, realOnly, neither,
        paperFillRate: k.length ? r4((both + paperOnly) / k.length) : null, realFillRate: k.length ? r4((both + realOnly) / k.length) : null };
    }
    delete M.rows;
    Object.assign(M, out);
  }
  return report;
}

function lines(report) {
  const L = [];
  const pc = v => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  const c = v => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}¢`);
  for (const [mode, M] of Object.entries(report.modes)) {
    const tag = mode === 'live' ? 'REAL' : 'PAPER';
    L.push(`[EJECUCION] ${tag}: ${M.attempts} intentos, ${M.filled} llenadas (${pc(M.fillRate)}), ${M.partial} parciales | sin fill: ${M.noFillReasons.map(([r, n]) => `${r} ×${n}`).join(', ') || '—'}`);
    L.push(`[EJECUCION] ${tag}: sobreprecio vs ask al decidir ${c(M.slippage.mean)} prom, ${c(M.slippage.p90)} p90 (n=${M.slippage.n}) | acierto llenadas ${pc(M.adverse.filled.wr)} (n=${M.adverse.filled.n}) vs no llenadas ${pc(M.adverse.notFilled.wr)} (n=${M.adverse.notFilled.n}), EV/acc perdido en no llenadas ${c(M.adverse.missedEvPerShare)} | P&L ${M.pnl.wins}-${M.pnl.closed - M.pnl.wins} $${M.pnl.total}`);
    if (M.latencyMs) L.push(`[EJECUCION] REAL latencia ms (p50/p90): decisión→envío ${M.latencyMs.decisionToSend.p50}/${M.latencyMs.decisionToSend.p90} | envío→CLOB ${M.latencyMs.sendToResponse.p50}/${M.latencyMs.sendToResponse.p90} | decisión→fill ${M.latencyMs.decisionToFill.p50}/${M.latencyMs.decisionToFill.p90}`);
    if (M.paperVsReal) { const p = M.paperVsReal; L.push(`[EJECUCION] REAL vs lo que habría dicho paper (n=${p.n}): paper llena ${pc(p.paperFillRate)}, real ${pc(p.realFillRate)} | ambos ${p.both}, solo paper ${p.paperOnly}, solo real ${p.realOnly}, ninguno ${p.neither}`); }
  }
  if (!L.length) L.push('[EJECUCION] sin intentos registrados en el período');
  return L;
}

module.exports = { buildReport, lines, FEE };

if (require.main === module) {
  const dir = process.argv[2] || process.env.DATA_DIR || '/data';
  const since = process.env.EXEC_REPORT_SINCE ? Date.parse(process.env.EXEC_REPORT_SINCE) : null;
  const report = buildReport({
    fills: readJsonl(path.join(dir, 'fills.jsonl')),
    signals: readJsonl(path.join(dir, 'signals.jsonl')),
    markets: readJsonl(path.join(dir, 'shadow-markets.jsonl')),
    since,
  });
  try { fs.writeFileSync(path.join(dir, 'exec-report.json'), JSON.stringify(report)); } catch (_) {}
  for (const l of lines(report)) console.log(l);
}
