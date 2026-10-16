'use strict';
const { feePerShare } = require('./decision');

const clip = (p) => Math.min(0.999, Math.max(0.001, p));
const brier = (p, y) => (p - y) ** 2;
const logloss = (p, y) => -(y * Math.log(clip(p)) + (1 - y) * Math.log(1 - clip(p)));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const GAMMA_FLB = 1.1; // correccion fija favorito/longshot: p^g/(p^g+(1-p)^g), sin ajustar con pocos datos
const flb = (p) => p ** GAMMA_FLB / (p ** GAMMA_FLB + (1 - p) ** GAMMA_FLB);

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Bootstrap por evento (clusters): remuestrea eventos, no mercados. diffs: [{event, d}]
function bootstrapByEvent(rows, iters = 2000, seed = 12345) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.event)) by.set(r.event, []); by.get(r.event).push(r.d); }
  const ev = [...by.values()];
  if (!ev.length) return null;
  const rand = rng(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0, n = 0;
    for (let j = 0; j < ev.length; j++) { const e = ev[Math.floor(rand() * ev.length)]; for (const d of e) { sum += d; n++; } }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(rows.map((r) => r.d)), lo: means[Math.floor(0.025 * iters)], hi: means[Math.floor(0.975 * iters)], events: ev.length };
}

function group(rows, keyFn) {
  const out = {};
  for (const r of rows) { const k = keyFn(r); (out[k] ||= []).push(r); }
  return out;
}

const horizonBucket = (days) => (days < 7 ? '<7d' : days <= 30 ? '7-30d' : '>30d');
const confBucket = (c) => (typeof c === 'number' ? (c >= 0.7 ? 'alta' : c >= 0.4 ? 'media' : 'baja') : String(c ?? 'sin_dato').toLowerCase());

function computeReport(st) {
  const outcome = new Map(st.resolutions.map((r) => [r.market_id, r.outcome_yes]));
  const firstByMarket = new Map();
  for (const f of [...st.forecasts].sort((a, b) => a.ts.localeCompare(b.ts))) if (!firstByMarket.has(f.market_id)) firstByMarket.set(f.market_id, f);
  const rows = [];
  for (const f of firstByMarket.values()) {
    if (!outcome.has(f.market_id)) continue;
    const y = outcome.get(f.market_id);
    const m = f.mid_yes;
    const blend = 0.5 * f.p_yes + 0.5 * m;
    rows.push({ event: f.event_id, y, p: f.p_yes, m, blend, fm: flb(m) });
  }
  const n = rows.length;
  const score = (fn) => (n ? { brier: mean(rows.map((r) => brier(fn(r), r.y))), logloss: mean(rows.map((r) => logloss(fn(r), r.y))) } : null);
  const scores = { pronostico: score((r) => r.p), mercado: score((r) => r.m), mezcla_50_50: score((r) => r.blend), mercado_corregido_flb: score((r) => r.fm) };
  const diff = (fn) => bootstrapByEvent(rows.map((r) => ({ event: r.event, d: brier(fn(r), r.y) - brier(r.m, r.y) })));
  const vsMarket = diff((r) => r.p), blendVsMarket = diff((r) => r.blend);

  // calibracion del pronostico por tramos
  const cal = [];
  for (let i = 0; i < 10; i++) {
    const b = rows.filter((r) => r.p >= i / 10 && (i === 9 ? r.p <= 1 : r.p < (i + 1) / 10));
    if (b.length) cal.push({ tramo: `${i * 10}-${(i + 1) * 10}%`, n: b.length, p_media: mean(b.map((r) => r.p)), freq_obs: mean(b.map((r) => r.y)) });
  }

  // P&L hipotetico neto de comision sobre todas las compras de mercados resueltos
  const fmap = new Map(st.forecasts.map((f) => [f.key, f]));
  const pnlRows = [];
  for (const d of st.decisions) {
    if (d.action !== 'comprar' || !outcome.has(d.market_id)) continue;
    const y = outcome.get(d.market_id);
    const win = d.side === 'SI' ? y === 1 : y === 0;
    const pnl = (win ? d.shares : 0) - d.stake_usd - (d.fee_usd || 0);
    const f = fmap.get(d.key);
    const days = f ? (Date.parse(f.end_date) - Date.parse(f.ts)) / 864e5 : null;
    pnlRows.push({ pnl, stake: d.stake_usd, cat: d.category, hor: days === null ? 'sin_dato' : horizonBucket(days), conf: confBucket(f?.confidence) });
  }
  const pnlAgg = (rs) => ({ n: rs.length, pnl: rs.reduce((s, r) => s + r.pnl, 0), invertido: rs.reduce((s, r) => s + r.stake, 0) });
  const pnl = { total: pnlAgg(pnlRows), por_categoria: {}, por_horizonte: {}, por_confianza: {} };
  for (const [k, g] of Object.entries(group(pnlRows, (r) => r.cat))) pnl.por_categoria[k] = pnlAgg(g);
  for (const [k, g] of Object.entries(group(pnlRows, (r) => r.hor))) pnl.por_horizonte[k] = pnlAgg(g);
  for (const [k, g] of Object.entries(group(pnlRows, (r) => r.conf))) pnl.por_confianza[k] = pnlAgg(g);

  // convergencia: el mercado se mueve hacia el pronostico (todos los pronosticos con snapshot, resueltos o no)
  const conv = {};
  for (const h of ['24h', '72h', '7d']) {
    const pts = [];
    for (const s of st.snapshots.filter((x) => x.horizon === h)) {
      const f = fmap.get(s.key);
      if (!f) continue;
      const gap = f.p_yes - f.mid_yes;
      if (Math.abs(gap) < 0.02) continue;
      pts.push({ hacia: (s.mid_yes - f.mid_yes) * Math.sign(gap) });
    }
    conv[h] = { n: pts.length, pct_hacia_pronostico: pts.length ? pts.filter((p) => p.hacia > 0).length / pts.length : null, movimiento_medio_hacia: mean(pts.map((p) => p.hacia)) };
  }

  const crit = {
    resueltos_100: n >= 100,
    brier_mejor_que_mercado_ic_sin_cero: !!vsMarket && vsMarket.hi < 0,
    mezcla_le_gana_al_mercado: !!blendVsMarket && blendVsMarket.mean < 0 && blendVsMarket.hi < 0,
    pnl_neto_positivo: pnl.total.pnl > 0,
  };
  crit.cumple_todo = Object.values(crit).every(Boolean);
  let conclusion;
  if (n < 50) conclusion = `sin muestra suficiente (${n} resueltos, minimo 50)`;
  else conclusion = `n=${n}: Brier pronostico ${scores.pronostico.brier.toFixed(4)} vs mercado ${scores.mercado.brier.toFixed(4)} (dif ${vsMarket.mean.toFixed(4)}, IC95 por evento [${vsMarket.lo.toFixed(4)}, ${vsMarket.hi.toFixed(4)}]); P&L neto $${pnl.total.pnl.toFixed(2)}; ${crit.cumple_todo ? 'cumple el criterio para PENSAR en dinero real (no implementado)' : 'no cumple aun el criterio para dinero real'}`;
  return {
    generado: new Date().toISOString(),
    pronosticados: firstByMarket.size, resueltos: n, eventos_resueltos: new Set(rows.map((r) => r.event)).size,
    scores, brier_dif_vs_mercado: vsMarket, brier_dif_mezcla_vs_mercado: blendVsMarket,
    calibracion: cal, pnl_hipotetico: pnl, convergencia: conv,
    criterio_dinero_real: crit, conclusion,
    nota: 'Solo paper. Brier/log loss: un pronostico por mercado (el primero), contra el mid al pronosticar; bootstrap por evento.',
  };
}

function summaryLine(st, rep) {
  const buys = st.decisions.filter((d) => d.action === 'comprar').length;
  return `resumen pronosticados=${rep.pronosticados} resueltos=${rep.resueltos} compras_paper=${buys} abierto_usd=${st.portfolio.openUsd.toFixed(2)} pnl_usd=${rep.pnl_hipotetico.total.pnl.toFixed(2)} brier=${rep.scores.pronostico ? rep.scores.pronostico.brier.toFixed(4) : 'n/d'} brier_mercado=${rep.scores.mercado ? rep.scores.mercado.brier.toFixed(4) : 'n/d'} | ${rep.conclusion}`;
}

module.exports = { computeReport, summaryLine, bootstrapByEvent, brier, logloss, flb, feePerShare };
