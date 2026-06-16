/**
 * Signal Logger v2 — guarda señales con edge decay, consecutive losses y momentum
 * Archivo JSONL: una línea por señal, persistente en Railway Volume /data
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR    = process.env.DATA_DIR || '/data';
const SIGNAL_FILE = path.join(DATA_DIR, 'signals.jsonl');
const STATS_FILE  = path.join(DATA_DIR, 'stats.json');

function ensureDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
}

// Contador de losses consecutivos (en memoria, se resetea al reiniciar)
let consecutiveLosses = 0;

// Mapa de snapshots pendientes: posId → { record, btcPrice, getPolyPrice }
const pendingSnapshots = new Map();

// ─── Abrir trade ─────────────────────────────────────────────────────────────
function logSignalOpen({ posId, direction, price, size, market, sig, utcHour, btcPrice, getPolyPrice }) {
  ensureDir();

  const record = {
    posId,
    mode:             process.env.DRY_RUN === 'true' ? 'paper' : 'live',
    timestamp:        new Date().toISOString(),
    utcHour,
    argHour:          (utcHour - 3 + 24) % 24,
    direction,
    filled_price:     price,
    size,
    market:           market?.question?.slice(-30) || '',
    // Indicadores de señal
    zscore:           parseFloat(sig?.zScore?.toFixed(3) || 0),
    mode:             process.env.DRY_RUN === 'true' ? 'paper' : 'live',
    movePct:          parseFloat(sig?.movePct?.toFixed(4) || 0),
    imbalance:        parseFloat(sig?.imbalance?.toFixed(3) || 0),
    spreadRatio:      parseFloat(sig?.spreadRatio?.toFixed(3) || 1),
    tickFreq:         sig?.tickFreq || 0,
    rsi:              parseFloat(sig?.rsi?.toFixed(1) || 50),
    signalScore:      sig?.signalScore || null,
    bufferSize:       sig?.bufferSize || 0,
    // Estado del bot al momento de la señal
    consecutive_losses: consecutiveLosses,
    btc_price_entry:  btcPrice || null,
    // Edge decay — se completan con snapshots
    poly_price_t0:    null,
    poly_price_t1:    null,
    poly_price_t2:    null,
    poly_price_t5:    null,
    // Momentum post-señal
    btc_price_t30:    null,
    btc_price_change_30s: null,
    // Resultado
    open_timestamp:   Date.now(),
    close_timestamp:  null,
    trade_duration_seconds: null,
    result:           null,
    pnl:              null,
  };

  // Guardar inmediatamente
  try { fs.appendFileSync(SIGNAL_FILE, JSON.stringify(record) + '\n'); } catch(e) {}

  // Programar snapshots de precio Polymarket si tenemos la función
  if (getPolyPrice) {
    pendingSnapshots.set(posId, { record, getPolyPrice });

    // T+0 inmediato
    try { record.poly_price_t0 = getPolyPrice(direction); } catch(e) {}

    // T+1s
    setTimeout(() => {
      try {
        const snap = pendingSnapshots.get(posId);
        if (snap) snap.record.poly_price_t1 = getPolyPrice(direction);
      } catch(e) {}
    }, 1000);

    // T+2s
    setTimeout(() => {
      try {
        const snap = pendingSnapshots.get(posId);
        if (snap) snap.record.poly_price_t2 = getPolyPrice(direction);
      } catch(e) {}
    }, 2000);

    // T+5s
    setTimeout(() => {
      try {
        const snap = pendingSnapshots.get(posId);
        if (snap) snap.record.poly_price_t5 = getPolyPrice(direction);
        // Actualizar el archivo con los snapshots
        updateRecord(posId, {
          poly_price_t0: snap?.record.poly_price_t0,
          poly_price_t1: snap?.record.poly_price_t1,
          poly_price_t2: snap?.record.poly_price_t2,
          poly_price_t5: snap?.record.poly_price_t5,
        });
      } catch(e) {}
    }, 5000);
  }

  return record;
}

// ─── Cerrar trade ─────────────────────────────────────────────────────────────
function logSignalClose(posId, result, pnl, btcPriceNow) {
  ensureDir();

  // Actualizar consecutive losses
  if (result === 'WIN') {
    consecutiveLosses = 0;
  } else {
    consecutiveLosses++;
  }

  // Limpiar snapshot pendiente
  pendingSnapshots.delete(posId);

  // Actualizar registro con resultado y duración
  updateRecord(posId, {
    result,
    pnl,
    close_timestamp: Date.now(),
  }, true); // true = calcular duración

  // Actualizar stats
  updateStats();
}

// ─── Actualizar campos de un registro existente ───────────────────────────────
function updateRecord(posId, fields, calcDuration = false) {
  try {
    if (!fs.existsSync(SIGNAL_FILE)) return;
    const lines = fs.readFileSync(SIGNAL_FILE, 'utf8').trim().split('\n');
    const updated = lines.map(line => {
      try {
        const r = JSON.parse(line);
        if (r.posId !== posId) return line;
        Object.assign(r, fields);
        if (calcDuration && r.open_timestamp && r.close_timestamp) {
          r.trade_duration_seconds = Math.round((r.close_timestamp - r.open_timestamp) / 1000);
        }
        return JSON.stringify(r);
      } catch { return line; }
    });
    fs.writeFileSync(SIGNAL_FILE, updated.join('\n') + '\n');
  } catch(e) {}
}

// ─── Guardar BTC price 30s después de la señal ───────────────────────────────
function logBtcSnapshot30s(posId, btcPriceThen, btcPriceNow) {
  if (!btcPriceThen || !btcPriceNow) return;
  const change = ((btcPriceNow - btcPriceThen) / btcPriceThen * 100);
  updateRecord(posId, {
    btc_price_t30: btcPriceNow,
    btc_price_change_30s: parseFloat(change.toFixed(4)),
  });
}

// ─── Stats agregadas ──────────────────────────────────────────────────────────
function updateStats() {
  try {
    if (!fs.existsSync(SIGNAL_FILE)) return;
    const lines = fs.readFileSync(SIGNAL_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const closed = records.filter(r => r.result !== null);
    if (!closed.length) return;

    const wins = closed.filter(r => r.result === 'WIN');
    const totalPnL = closed.reduce((sum, r) => sum + (r.pnl || 0), 0);

    // Por hora AR
    const byHour = {};
    for (const r of closed) {
      const h = r.argHour;
      if (!byHour[h]) byHour[h] = { wins: 0, total: 0, pnl: 0 };
      byHour[h].total++;
      byHour[h].pnl += r.pnl || 0;
      if (r.result === 'WIN') byHour[h].wins++;
    }

    // Por Z-score
    const byZscore = {};
    for (const r of closed) {
      const z = Math.abs(r.zscore || 0);
      const b = z < 1.5 ? '<1.5' : z < 2.0 ? '1.5-2.0' : z < 2.5 ? '2.0-2.5' : '>2.5';
      if (!byZscore[b]) byZscore[b] = { wins: 0, total: 0 };
      byZscore[b].total++;
      if (r.result === 'WIN') byZscore[b].wins++;
    }

    // Por imbalance
    const byImbalance = {};
    for (const r of closed) {
      const imb = r.imbalance || 0;
      const b = imb < -0.2 ? 'sellers' : imb > 0.2 ? 'buyers' : 'neutral';
      if (!byImbalance[b]) byImbalance[b] = { wins: 0, total: 0 };
      byImbalance[b].total++;
      if (r.result === 'WIN') byImbalance[b].wins++;
    }

    // Por consecutive losses al momento de la señal
    const byConsecLoss = {};
    for (const r of closed) {
      const cl = r.consecutive_losses || 0;
      const b = cl === 0 ? '0' : cl === 1 ? '1' : cl === 2 ? '2' : '3+';
      if (!byConsecLoss[b]) byConsecLoss[b] = { wins: 0, total: 0 };
      byConsecLoss[b].total++;
      if (r.result === 'WIN') byConsecLoss[b].wins++;
    }

    // Edge decay promedio (cuánto se movió Polymarket en 1s, 2s, 5s)
    const withDecay = closed.filter(r => r.poly_price_t0 !== null && r.poly_price_t5 !== null);
    let avgDecay1s = null, avgDecay5s = null;
    if (withDecay.length > 5) {
      const decays1s = withDecay.map(r => Math.abs((r.poly_price_t1 - r.poly_price_t0) / (r.poly_price_t0 || 1) * 100));
      const decays5s = withDecay.map(r => Math.abs((r.poly_price_t5 - r.poly_price_t0) / (r.poly_price_t0 || 1) * 100));
      avgDecay1s = (decays1s.reduce((a,b) => a+b, 0) / decays1s.length).toFixed(3);
      avgDecay5s = (decays5s.reduce((a,b) => a+b, 0) / decays5s.length).toFixed(3);
    }

    const stats = {
      updatedAt:    new Date().toISOString(),
      totalSignals: records.length,
      closedTrades: closed.length,
      wins:         wins.length,
      losses:       closed.length - wins.length,
      winRate:      (wins.length / closed.length * 100).toFixed(1) + '%',
      totalPnL:     totalPnL.toFixed(2),
      edgeDecay: withDecay.length >= 5 ? {
        samples: withDecay.length,
        avgPolyMove1s_pct: avgDecay1s,
        avgPolyMove5s_pct: avgDecay5s,
        note: 'cuánto se mueve Polymarket en 1s/5s tras la señal',
      } : { note: 'necesita 5+ trades con snapshots' },
      byHour:       Object.fromEntries(
        Object.entries(byHour).sort((a,b) => parseInt(a[0])-parseInt(b[0])).map(([h, d]) => [
          `${String(h).padStart(2,'0')}h AR`,
          { winRate: (d.wins/d.total*100).toFixed(1)+'%', trades: d.total, pnl: d.pnl.toFixed(2) }
        ])
      ),
      byZscore:     Object.fromEntries(Object.entries(byZscore).map(([k,d]) => [k, { winRate: (d.wins/d.total*100).toFixed(1)+'%', trades: d.total }])),
      byImbalance:  Object.fromEntries(Object.entries(byImbalance).map(([k,d]) => [k, { winRate: (d.wins/d.total*100).toFixed(1)+'%', trades: d.total }])),
      byConsecLoss: Object.fromEntries(Object.entries(byConsecLoss).map(([k,d]) => [k, { winRate: (d.wins/d.total*100).toFixed(1)+'%', trades: d.total }])),
    };

    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch(e) {}
}

function getStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch { return null; }
}

function getConsecutiveLosses() { return consecutiveLosses; }

module.exports = { logSignalOpen, logSignalClose, logBtcSnapshot30s, getStats, getConsecutiveLosses };
