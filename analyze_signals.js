/**
 * Análisis de signals.jsonl del Railway Volume
 * Uso: node analyze_signals.js [ruta_al_archivo]
 * Default: ./signals.jsonl
 */

const fs = require('fs');

const FILE = process.argv[2] || './signals.jsonl';

if (!fs.existsSync(FILE)) {
  console.log(`Archivo no encontrado: ${FILE}`);
  console.log('Bajalo de Railway Volume y correlo así:');
  console.log('  node analyze_signals.js signals.jsonl');
  process.exit(1);
}

const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const closed = all.filter(r => r.result !== null);

if (!closed.length) {
  console.log('No hay trades cerrados todavía.');
  process.exit(0);
}

const wins = closed.filter(r => r.result === 'WIN');
const losses = closed.filter(r => r.result === 'LOSS');
const totalPnL = closed.reduce((s, r) => s + (r.pnl || 0), 0);

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  ANÁLISIS DE SEÑALES — LATENCY BOT');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`Total trades: ${closed.length} (${all.length - closed.length} abiertos)`);
console.log(`Wins: ${wins.length} | Losses: ${losses.length}`);
console.log(`Win Rate: ${(wins.length/closed.length*100).toFixed(1)}%`);
console.log(`P&L Total: $${totalPnL.toFixed(2)}`);

// ─── 1. Por hora AR ────────────────────────────────────────────────────────
console.log('\n─── WIN RATE POR HORA (Argentina) ─────────────────────────');
const byHour = {};
for (const r of closed) {
  const h = r.argHour ?? ((r.utcHour - 3 + 24) % 24);
  if (!byHour[h]) byHour[h] = { wins: 0, total: 0, pnl: 0 };
  byHour[h].total++;
  byHour[h].pnl += r.pnl || 0;
  if (r.result === 'WIN') byHour[h].wins++;
}
for (const [h, d] of Object.entries(byHour).sort((a,b) => parseInt(a[0])-parseInt(b[0]))) {
  const wr = (d.wins/d.total*100).toFixed(1);
  const bar = '█'.repeat(Math.round(d.wins/d.total*20));
  const flag = wr >= 65 ? ' 🟢 BUENA' : wr <= 45 ? ' 🔴 MALA' : '';
  console.log(`  ${String(h).padStart(2,'0')}h AR: ${wr}% ${bar} (${d.total} trades, P&L: $${d.pnl.toFixed(2)})${flag}`);
}

// ─── 2. Por Z-score ────────────────────────────────────────────────────────
console.log('\n─── WIN RATE POR Z-SCORE ───────────────────────────────────');
const byZ = { '<1.5': {w:0,t:0}, '1.5-2.0': {w:0,t:0}, '2.0-2.5': {w:0,t:0}, '2.5-3.0': {w:0,t:0}, '>3.0': {w:0,t:0} };
for (const r of closed) {
  const z = Math.abs(r.zscore || 0);
  const b = z < 1.5 ? '<1.5' : z < 2.0 ? '1.5-2.0' : z < 2.5 ? '2.0-2.5' : z < 3.0 ? '2.5-3.0' : '>3.0';
  byZ[b].t++;
  if (r.result === 'WIN') byZ[b].w++;
}
for (const [k, d] of Object.entries(byZ)) {
  if (!d.t) continue;
  const wr = (d.w/d.t*100).toFixed(1);
  console.log(`  Z ${k}: ${wr}% (${d.t} trades)`);
}

// ─── 3. Por RSI ────────────────────────────────────────────────────────────
console.log('\n─── WIN RATE POR RSI ───────────────────────────────────────');
const byRSI = { '<20 (sobrevendido)': {w:0,t:0}, '20-40': {w:0,t:0}, '40-60 (neutral)': {w:0,t:0}, '60-80': {w:0,t:0}, '>80 (sobrecomprado)': {w:0,t:0} };
for (const r of closed) {
  const rsi = r.rsi || 50;
  const b = rsi < 20 ? '<20 (sobrevendido)' : rsi < 40 ? '20-40' : rsi < 60 ? '40-60 (neutral)' : rsi < 80 ? '60-80' : '>80 (sobrecomprado)';
  byRSI[b].t++;
  if (r.result === 'WIN') byRSI[b].w++;
}
for (const [k, d] of Object.entries(byRSI)) {
  if (!d.t) continue;
  const wr = (d.w/d.t*100).toFixed(1);
  console.log(`  RSI ${k}: ${wr}% (${d.t} trades)`);
}

// ─── 4. Por consecutive losses ─────────────────────────────────────────────
console.log('\n─── WIN RATE POR LOSSES CONSECUTIVOS PREVIOS ──────────────');
const byCL = { '0': {w:0,t:0}, '1': {w:0,t:0}, '2': {w:0,t:0}, '3+': {w:0,t:0} };
for (const r of closed) {
  const cl = r.consecutive_losses || 0;
  const b = cl >= 3 ? '3+' : String(cl);
  byCL[b].t++;
  if (r.result === 'WIN') byCL[b].w++;
}
for (const [k, d] of Object.entries(byCL)) {
  if (!d.t) continue;
  const wr = (d.w/d.t*100).toFixed(1);
  const flag = k === '3+' && wr < 40 ? ' ← CIRCUIT BREAKER acá' : '';
  console.log(`  Losses previos ${k}: ${wr}% (${d.t} trades)${flag}`);
}

// ─── 5. Edge decay ─────────────────────────────────────────────────────────
const withDecay = closed.filter(r => r.poly_price_t0 != null && r.poly_price_t5 != null);
if (withDecay.length >= 3) {
  console.log('\n─── EDGE DECAY (velocidad de corrección Polymarket) ────────');
  const move1s = withDecay.map(r => Math.abs(((r.poly_price_t1||r.poly_price_t0) - r.poly_price_t0) / r.poly_price_t0 * 100));
  const move2s = withDecay.map(r => Math.abs(((r.poly_price_t2||r.poly_price_t0) - r.poly_price_t0) / r.poly_price_t0 * 100));
  const move5s = withDecay.map(r => Math.abs(((r.poly_price_t5||r.poly_price_t0) - r.poly_price_t0) / r.poly_price_t0 * 100));
  const avg = arr => arr.reduce((a,b) => a+b, 0) / arr.length;
  console.log(`  Samples: ${withDecay.length}`);
  console.log(`  Polymarket se mueve en promedio:`);
  console.log(`    T+1s: ${avg(move1s).toFixed(2)}%`);
  console.log(`    T+2s: ${avg(move2s).toFixed(2)}%`);
  console.log(`    T+5s: ${avg(move5s).toFixed(2)}%`);
  console.log(`  → Si Railway tarda ~400ms, capturás el movimiento antes de T+1s`);
}

// ─── 6. BTC momentum post-señal ────────────────────────────────────────────
const withBTC30 = closed.filter(r => r.btc_price_change_30s != null);
if (withBTC30.length >= 3) {
  console.log('\n─── MOMENTUM BTC 30s POST-SEÑAL ────────────────────────────');
  const continued = withBTC30.filter(r => {
    const sameDir = (r.direction === 'DOWN' && r.btc_price_change_30s < 0) ||
                    (r.direction === 'UP'   && r.btc_price_change_30s > 0);
    return sameDir;
  });
  const wrContinued = continued.filter(r => r.result === 'WIN').length / (continued.length || 1) * 100;
  const reversed = withBTC30.filter(r => {
    const sameDir = (r.direction === 'DOWN' && r.btc_price_change_30s < 0) ||
                    (r.direction === 'UP'   && r.btc_price_change_30s > 0);
    return !sameDir;
  });
  const wrReversed = reversed.filter(r => r.result === 'WIN').length / (reversed.length || 1) * 100;
  console.log(`  BTC continuó en misma dirección (${continued.length} trades): ${wrContinued.toFixed(1)}% WR`);
  console.log(`  BTC revirtió (${reversed.length} trades): ${wrReversed.toFixed(1)}% WR`);
}

// ─── 7. Imbalance ──────────────────────────────────────────────────────────
console.log('\n─── WIN RATE POR ORDERBOOK IMBALANCE ──────────────────────');
const byImb = { 'sellers (<-0.2)': {w:0,t:0}, 'neutral': {w:0,t:0}, 'buyers (>0.2)': {w:0,t:0} };
for (const r of closed) {
  const imb = r.imbalance || 0;
  const b = imb < -0.2 ? 'sellers (<-0.2)' : imb > 0.2 ? 'buyers (>0.2)' : 'neutral';
  byImb[b].t++;
  if (r.result === 'WIN') byImb[b].w++;
}
for (const [k, d] of Object.entries(byImb)) {
  if (!d.t) continue;
  console.log(`  ${k}: ${(d.w/d.t*100).toFixed(1)}% (${d.t} trades)`);
}

// ─── 8. Recomendación de tamaño por hora ──────────────────────────────────
console.log('\n─── RECOMENDACIÓN DE SIZE POR HORA (con $25 capital) ──────');
console.log('  (basado en tus datos reales, no el backtest histórico)\n');
for (const [h, d] of Object.entries(byHour).sort((a,b) => parseInt(a[0])-parseInt(b[0]))) {
  if (d.total < 3) continue;
  const wr = d.wins/d.total;
  let size, reason;
  if (wr >= 0.70) { size = '$8'; reason = 'WR excelente'; }
  else if (wr >= 0.60) { size = '$5'; reason = 'WR bueno'; }
  else if (wr >= 0.50) { size = '$3'; reason = 'WR aceptable'; }
  else { size = 'SKIP'; reason = 'WR bajo — no operar'; }
  console.log(`  ${String(h).padStart(2,'0')}h AR: ${size.padEnd(6)} ← ${(wr*100).toFixed(0)}% WR (${reason})`);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  Guardá este análisis. El lunes lo usamos para calibrar.');
console.log('═══════════════════════════════════════════════════════════\n');
