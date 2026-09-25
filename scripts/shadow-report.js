#!/usr/bin/env node
/**
 * Reporte del modo sombra.
 *   node scripts/shadow-report.js [shadow-markets.jsonl] [shadow-ticks.jsonl] [--since=2026-09-25T00:00Z]
 * También disponible en el bot:  GET /shadow-report?key=SECRET[&since=...]
 *
 * Responde 5 preguntas:
 *   1. ¿Los datos son confiables?            (cobertura, fuente del ganador, BTC vs resolución oficial)
 *   2. ¿El modelo está calibrado?            (cuando dice 70%, ¿gana ~70%?) y ¿predice mejor que el precio de Polymarket?
 *   3. ¿Cuánto habría ganado el modelo?      (umbral de ventaja × ventana de tiempo, 1 trade por mercado)
 *   4. ¿El modelo separa los trades buenos del bot de los malos?
 *   5. ¿Cuánto tarda Polymarket en reaccionar y cuánto dura una ventaja?
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normCdf } = require('../src/fair-value');

const DATA_DIR = process.env.DATA_DIR || '/data';
const args = process.argv.slice(2);
const pos = args.filter(a => !a.startsWith('--'));
const MARKETS = pos[0] || path.join(DATA_DIR, 'shadow-markets.jsonl');
const TICKS = pos[1] || path.join(DATA_DIR, 'shadow-ticks.jsonl');
const sinceArg = (args.find(a => a.startsWith('--since=')) || '').slice(8);
const SINCE = sinceArg ? (/^\d+$/.test(sinceArg) ? +sinceArg : Date.parse(sinceArg)) : 0;

const pct = (x, d = 1) => x == null || !Number.isFinite(x) ? '  n/a' : (x * 100).toFixed(d) + '%';
const usd = (x, d = 3) => x == null || !Number.isFinite(x) ? 'n/a' : (x >= 0 ? '+' : '') + x.toFixed(d);
const pad = (s, n) => String(s).padStart(n);
const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

async function readJsonl(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (!SINCE || o.start_ts >= SINCE) out.push(o); } catch (_) {}
  }
  return out;
}

function tradeStats(list) {           // list de {price, win}
  const n = list.length;
  if (!n) return { n: 0 };
  const w = list.filter(x => x.win).length;
  const cost = list.reduce((s, x) => s + x.price, 0);
  const pnl = list.reduce((s, x) => s + (x.win ? 1 - x.price : -x.price), 0);
  return { n, wr: w / n, avgPrice: cost / n, pnlTok: pnl / n, pnl, roi: pnl / cost, se: Math.sqrt((w / n) * (1 - w / n) / n) };
}
const fmtStats = s => s.n
  ? `n=${pad(s.n, 4)}  acierto=${pct(s.wr)} (±${(s.se * 100).toFixed(1)})  precio=${s.avgPrice.toFixed(3)}  ventaja real=${pad(((s.wr - s.avgPrice) * 100).toFixed(1), 5)} pts  $/token=${usd(s.pnlTok)}  sobre costo=${pct(s.roi)}`
  : 'n=   0';

(async () => {
  const markets = (await readJsonl(MARKETS)).filter(m => m.winner);
  const ticks = await readJsonl(TICKS);
  const winnerById = new Map(markets.map(m => [m.gamma_id, m.winner]));
  const L = [];
  const P = s => L.push(s);

  P('════════ REPORTE MODO SOMBRA ════════');
  if (!markets.length) { P('Todavía no hay mercados resueltos.'); console.log(L.join('\n')); return; }
  const t0 = Math.min(...markets.map(m => m.start_ts)), t1 = Math.max(...markets.map(m => m.end_ts));
  P(`Período: ${new Date(t0).toISOString().slice(0, 16)} → ${new Date(t1).toISOString().slice(0, 16)} UTC  (${((t1 - t0) / 3.6e6).toFixed(1)} h)`);

  // ── 1. Confiabilidad ─────────────────────────────────────────────────────
  P('\n1) DATOS');
  const bySrc = {};
  for (const m of markets) bySrc[m.winner_source] = (bySrc[m.winner_source] || 0) + 1;
  P(`   Mercados resueltos: ${markets.length}  | fuente del ganador: ${Object.entries(bySrc).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const official = markets.filter(m => m.winner_source === 'gamma' && m.btc_winner);
  const agree = official.filter(m => m.btc_winner === m.winner).length;
  P(`   BTC (Binance) apertura→cierre coincide con la resolución oficial: ${agree}/${official.length} (${pct(agree / official.length)})`);
  P(`     → si es <97%, la apertura/cierre de Binance difiere de Chainlink y el modelo se equivoca en mercados muy parejos`);
  P(`   Activación del mercado (mediana): ${median(markets.map(m => m.activation_delay_s))} s tarde | apertura desde: ${[...new Set(markets.map(m => m.strike_source))].join(', ')}`);

  // Filas utilizables: [t, secs_left, btc, p_up, yes_bid, yes_ask, no_bid, no_ask, sigma_e6, book_imb]
  const series = [];
  for (const tk of ticks) {
    const winner = winnerById.get(tk.gamma_id);
    if (!winner || !tk.strike) continue;
    const rows = tk.rows.filter(r => r[2] && r[8] && r[1] > 0);
    if (rows.length) series.push({ id: tk.gamma_id, K: tk.strike, up: winner === 'UP' ? 1 : 0, rows });
  }
  const zOf = (r, K) => Math.log(r[2] / K) / (r[8] * 1e-6 * Math.sqrt(r[1]));

  // ── 2. Calibración ───────────────────────────────────────────────────────
  P('\n2) CALIBRACIÓN (una muestra cada 10 s)');
  const samples = [];
  for (const s of series) for (const r of s.rows) if (r[0] % 10 === 0) samples.push({ z: zOf(r, s.K), up: s.up, r, id: s.id });
  // σ × k: elegir el k que mejor predice (log-loss)
  let bestK = 1, bestLL = Infinity;
  const ll = k => {
    let sum = 0;
    for (const x of samples) { const p = Math.min(1 - 1e-4, Math.max(1e-4, normCdf(x.z / k))); sum += -(x.up ? Math.log(p) : Math.log(1 - p)); }
    return sum / samples.length;
  };
  for (let k = 0.5; k <= 3.001; k += 0.1) { const v = ll(k); if (v < bestLL) { bestLL = v; bestK = +k.toFixed(1); } }
  P(`   Muestras: ${samples.length}.  Mejor ajuste de volatilidad: σ × ${bestK}  (1.0 = el modelo tal cual)`);
  P(`   Ojo: cada mercado aporta ~30 muestras con el MISMO resultado. Lo que cuenta es la columna "mercados": con menos de ~200, diferencias de ±15 pts son ruido.`);
  P('   P(UP) modelo | muestras | mercados | modelo decía | ganó UP de verdad');
  for (let b = 0; b < 10; b++) {
    const g = samples.filter(x => { const p = normCdf(x.z); return p >= b / 10 && p < (b + 1) / 10 + (b === 9 ? 1e-9 : 0); });
    if (!g.length) continue;
    const avgP = g.reduce((s, x) => s + normCdf(x.z), 0) / g.length;
    const fr = g.reduce((s, x) => s + x.up, 0) / g.length;
    P(`   ${pad(b * 10, 3)}–${pad(b * 10 + 10, 3)}%   | ${pad(g.length, 8)} | ${pad(new Set(g.map(x => x.id)).size, 8)} | ${pct(avgP)}       | ${pct(fr)}`);
  }
  // ¿Predice mejor que el propio precio de Polymarket? (Brier, menor = mejor)
  const both = samples.filter(x => x.r[4] != null && x.r[5] != null);
  if (both.length) {
    const brier = f => both.reduce((s, x) => s + (f(x) - x.up) ** 2, 0) / both.length;
    const bM = brier(x => normCdf(x.z)), bMk = brier(x => normCdf(x.z / bestK)), bP = brier(x => (x.r[4] + x.r[5]) / 2);
    P(`   Error cuadrático (menor = mejor, ${both.length} muestras): modelo=${bM.toFixed(4)}  modelo σ×${bestK}=${bMk.toFixed(4)}  precio Polymarket=${bP.toFixed(4)}`);
    const best = Math.min(bM, bMk), rel = (bP - best) / bP;
    P(`     → ${rel > 0.02 ? 'el modelo predice MEJOR que el precio de Polymarket (' + (rel * 100).toFixed(1) + '% menos error): hay información que el mercado todavía no incorporó'
      : rel < -0.02 ? 'el precio de Polymarket predice MEJOR que el modelo: el modelo no suma información de nivel; la ventaja, si existe, es solo de timing (sección 5)'
      : 'empate (diferencia < 2%): el modelo y Polymarket saben lo mismo en promedio; la ventaja, si existe, es de timing (sección 5)'}`);
  }

  // ── 3. Estrategia del modelo (1 trade por mercado, al ask) ───────────────
  P('\n3) QUÉ HABRÍA GANADO EL MODELO (1 entrada por mercado, comprando al ask, sin comisiones)');
  const windows = [['todo (≥10s)', 10, 300], ['10–60s', 10, 60], ['60–180s', 60, 180], ['180–300s', 180, 300]];
  const thrs = [0.03, 0.05, 0.08, 0.12, 0.15];
  const sim = (k, thr, lo, hi) => {
    const out = [];
    for (const s of series) {
      for (const r of s.rows) {
        if (r[1] < lo || r[1] > hi) continue;
        const p = normCdf(zOf(r, s.K) / k);
        const eU = r[5] != null ? p - r[5] : -1, eD = r[7] != null ? (1 - p) - r[7] : -1;
        const side = eU >= eD ? 'UP' : 'DOWN', e = Math.max(eU, eD);
        if (e >= thr) { const price = side === 'UP' ? r[5] : r[7]; out.push({ price, win: (side === 'UP') === (s.up === 1) }); break; }
      }
    }
    return tradeStats(out);
  };
  for (const k of [...new Set([1, bestK])]) {
    P(`   Modelo σ×${k}:`);
    for (const [wName, lo, hi] of windows) {
      for (const thr of thrs) {
        const st = sim(k, thr, lo, hi);
        if (st.n) P(`     ${wName.padEnd(12)} ventaja≥${pad((thr * 100).toFixed(0), 2)}pts  ${fmtStats(st)}`);
      }
    }
  }
  P('   (el σ×k ajustado se eligió con estos mismos datos: su resultado es optimista hasta confirmarlo con días nuevos)');

  // ── 4. Bot vs modelo ─────────────────────────────────────────────────────
  P('\n4) TRADES DEL BOT SEGÚN LO QUE DECÍA EL MODELO EN ESE MOMENTO');
  const bt = markets.flatMap(m => m.bot.trades.filter(t => t.win != null).map(t => ({ ...t })));
  P(`   Todos los trades del bot:             ${fmtStats(tradeStats(bt))}`);
  const groups = [['modelo ≥ +5 pts (también entraba)', t => t.model_edge != null && t.model_edge >= 0.05],
    ['modelo 0 a +5 pts', t => t.model_edge != null && t.model_edge >= 0 && t.model_edge < 0.05],
    ['modelo negativo (pagaste de más)', t => t.model_edge != null && t.model_edge < 0],
    ['sin dato del modelo', t => t.model_edge == null]];
  for (const [name, f] of groups) P(`   ${name.padEnd(38)} ${fmtStats(tradeStats(bt.filter(f)))}`);
  const sig = markets.filter(m => m.bot.signals.UP + m.bot.signals.DOWN > 0).length;
  P(`   Mercados con señal del bot: ${sig}/${markets.length} | con trade del bot: ${markets.filter(m => m.bot.trades.length).length} | donde el modelo tuvo ≥5 pts: ${markets.filter(m => m.model.first.find(f => f.thr === 0.05)?.side).length}`);

  // ── 5. Reacción de Polymarket ────────────────────────────────────────────
  P('\n5) REACCIÓN DE POLYMARKET');
  // correlación entre el cambio del modelo en t y el cambio del precio medio de YES en t+L
  const maxLag = 20, acc = Array.from({ length: maxLag + 1 }, () => ({ sxy: 0, sxx: 0, syy: 0, n: 0 }));
  for (const s of series) {
    const byT = new Map(s.rows.map(r => [r[0], r]));
    for (const r of s.rows) {
      const prev = byT.get(r[0] - 1);
      if (!prev || r[1] < 20) continue;
      const dp = normCdf(zOf(r, s.K)) - normCdf(zOf(prev, s.K));
      for (let lag = 0; lag <= maxLag; lag++) {
        const a = byT.get(r[0] + lag), b = byT.get(r[0] + lag - 1);
        if (!a || !b || a[4] == null || a[5] == null || b[4] == null || b[5] == null) continue;
        const dm = (a[4] + a[5]) / 2 - (b[4] + b[5]) / 2;
        const c = acc[lag]; c.sxy += dp * dm; c.sxx += dp * dp; c.syy += dm * dm; c.n++;
      }
    }
  }
  const corr = acc.map(c => c.n > 50 && c.sxx > 0 && c.syy > 0 ? c.sxy / Math.sqrt(c.sxx * c.syy) : null);
  const valid = corr.map((c, i) => [i, c]).filter(x => x[1] != null);
  if (valid.length) {
    const [lagBest] = valid.reduce((a, b) => (b[1] > a[1] ? b : a));
    P(`   Polymarket sigue al modelo con ~${lagBest} s de atraso (máxima correlación). Curva por segundo:`);
    P('   ' + valid.map(([i, c]) => `${i}s:${c.toFixed(2)}`).join('  '));
  } else P('   Sin datos suficientes.');
  // cuánto dura una ventaja ≥5 pts hasta bajar de 2 pts
  const dur = [];
  for (const s of series) {
    let startT = null;
    for (const r of s.rows) {
      const p = normCdf(zOf(r, s.K));
      const e = Math.max(r[5] != null ? p - r[5] : -1, r[7] != null ? (1 - p) - r[7] : -1);
      if (startT == null && e >= 0.05 && r[1] >= 10) startT = r[0];
      else if (startT != null && e < 0.02) { dur.push(r[0] - startT); startT = null; }
    }
  }
  if (dur.length) {
    const d = [...dur].sort((a, b) => a - b);
    P(`   Una ventaja ≥5 pts dura (hasta bajar de 2 pts): mediana ${median(d)} s, 25% dura ≤${d[Math.floor(d.length / 4)]} s, 75% ≤${d[Math.floor(3 * d.length / 4)]} s  (${d.length} casos)`);
  }

  console.log(L.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
