#!/usr/bin/env node
'use strict';
// Reporte del v2:  node src/report.js [DATA_DIR] [--since=ISO]   (o GET /report?key=)
const fs = require('fs');
const path = require('path');

function readJsonl(file, since) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(o => o && (!since || (o.ts || 0) >= since));
}

function report(dir, since = 0, bankroll = Number(process.env.V2_PAPER_BANKROLL || 100)) {
  const L = [], P = s => L.push(s);
  const pct = x => x == null || !Number.isFinite(x) ? 'n/a' : (x * 100).toFixed(1) + '%';
  const c = x => x == null || !Number.isFinite(x) ? 'n/a' : (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '¢';
  const usd = x => (x >= 0 ? '+$' : '−$') + Math.abs(x).toFixed(2);

  const markets = readJsonl(path.join(dir, 'v2-markets.jsonl'), since);
  const fills = readJsonl(path.join(dir, 'v2-fills.jsonl'), since);
  const winners = new Map(markets.filter(m => m.winner).map(m => [m.gammaId, m.winner]));

  P('════════ BOT v2 — REPORTE (paper) ════════');
  if (!markets.length) { P('Todavía no hay mercados resueltos.'); return L.join('\n'); }
  const t0 = Math.min(...markets.map(m => m.ts)), t1 = Math.max(...markets.map(m => m.ts)), hours = (t1 - t0) / 3.6e6 || 1;
  P(`Período: ${new Date(t0).toISOString().slice(0, 16)} → ${new Date(t1).toISOString().slice(0, 16)} UTC (${hours.toFixed(1)} h)`);

  // Resultado
  const traded = markets.filter(m => m.entries > 0);
  const pnl = markets.reduce((s, m) => s + (m.pnl || 0), 0);
  const fees = fills.reduce((s, f) => s + (f.fee || 0), 0);
  let peak = bankroll, eq = bankroll, dd = 0;
  for (const m of markets) { eq += m.pnl || 0; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  P('\n1) RESULTADO');
  P(`   Mercados vistos: ${markets.length} | con trade: ${traded.length} (${pct(traded.length / markets.length)})`);
  P(`   PnL total: ${usd(pnl)} (comisiones pagadas: $${fees.toFixed(2)}) | por hora: ${usd(pnl / hours)} | peor caída: ${usd(dd)}`);
  const w = traded.filter(m => m.pnl > 0).length;
  P(`   Mercados operados en ganancia: ${w}/${traded.length} (${pct(w / (traded.length || 1))})`);

  // Compras: lo que el modelo prometía vs lo que pasó
  const buys = fills.filter(f => f.action === 'BUY' && winners.has(f.gammaId));
  if (buys.length) {
    const sh = buys.reduce((s, f) => s + f.shares, 0);
    const promised = buys.reduce((s, f) => s + (f.q - (f.cost + f.fee) / f.shares) * f.shares, 0) / sh;
    const realized = buys.reduce((s, f) => s + ((winners.get(f.gammaId) === f.side ? 1 : 0) * f.shares - f.cost - f.fee), 0) / sh;
    const wins = buys.filter(f => winners.get(f.gammaId) === f.side).length;
    P('\n2) COMPRAS (hasta la resolución, sin contar ventas anticipadas)');
    P(`   ${buys.length} compras, ${sh.toFixed(0)} acciones | acierto: ${pct(wins / buys.length)} | precio medio $${(buys.reduce((s, f) => s + f.cost, 0) / sh).toFixed(3)}`);
    P(`   Ventaja por acción: el modelo prometía ${c(promised)} → se realizó ${c(realized)}`);
    P('   Calibración (P del modelo al entrar vs acierto real):');
    for (const [lo, hi] of [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]]) {
      const g = buys.filter(f => f.q >= lo && f.q < hi);
      if (!g.length) continue;
      const wr = g.filter(f => winners.get(f.gammaId) === f.side).length / g.length;
      P(`     P ${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%: ${String(g.length).padStart(4)} compras | P media ${pct(g.reduce((s, f) => s + f.q, 0) / g.length)} | acierto ${pct(wr)}`);
    }
    P('   Por tiempo restante al entrar:');
    for (const [lo, hi] of [[0, 60], [60, 120], [120, 180], [180, 240], [240, 301]]) {
      const g = buys.filter(f => f.secsLeft >= lo && f.secsLeft < hi);
      if (!g.length) continue;
      const s2 = g.reduce((s, f) => s + f.shares, 0);
      const r = g.reduce((s, f) => s + ((winners.get(f.gammaId) === f.side ? 1 : 0) * f.shares - f.cost - f.fee), 0);
      P(`     ${String(lo).padStart(3)}–${hi === 301 ? 300 : hi}s: ${String(g.length).padStart(4)} compras | resultado ${usd(r)} (${c(r / s2)} por acción)`);
    }
  }
  const sells = fills.filter(f => f.action === 'SELL');
  if (sells.length) P(`\n   Ventas anticipadas: ${sells.length} | PnL de esas ventas ${usd(sells.reduce((s, f) => s + (f.pnl || 0), 0))}`);

  // Datos de resolución
  const both = markets.filter(m => m.source === 'gamma' && m.provisional);
  P('\n3) DATOS');
  P(`   Resolución oficial (Gamma): ${markets.filter(m => m.source === 'gamma').length}/${markets.length} | el TWAP publicado al cierre predijo el oficial en ${both.filter(m => m.provisional === m.winner).length}/${both.length}`);
  P(`   Precio a superar: ${[...new Set(markets.map(m => m.Ksrc).filter(Boolean))].join(', ') || 'n/a'} | comisión usada: ${[...new Set(markets.map(m => m.feeRate))].join(', ')}`);
  return L.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--')) || process.env.DATA_DIR || './data';
  const s = (args.find(a => a.startsWith('--since=')) || '').slice(8);
  console.log(report(dir, s ? Date.parse(s) : 0));
}

module.exports = { report };
