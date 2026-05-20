/**
 * Signal Logger — guarda cada señal y resultado en /data/signals.jsonl
 * Archivo JSONL: una línea JSON por señal, persistente en Railway Volume
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR   = process.env.DATA_DIR || '/data';
const SIGNAL_FILE = path.join(DATA_DIR, 'signals.jsonl');
const STATS_FILE  = path.join(DATA_DIR, 'stats.json');

// Asegurar que el directorio existe
function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
}

// Guardar una señal cuando se abre el trade
function logSignalOpen({ posId, direction, price, size, market, sig, utcHour }) {
  ensureDir();
  const record = {
    posId,
    timestamp:   new Date().toISOString(),
    utcHour,
    argHour:     (utcHour - 3 + 24) % 24,
    direction,
    price,
    size,
    market:      market?.question?.slice(-30) || '',
    zscore:      sig?.zScore?.toFixed(3),
    movePct:     sig?.movePct?.toFixed(4),
    imbalance:   sig?.imbalance?.toFixed(3),
    spreadRatio: sig?.spreadRatio?.toFixed(3),
    tickFreq:    sig?.tickFreq,
    rsi:         sig?.rsi?.toFixed(1),
    bufferSize:  sig?.bufferSize,
    result:      null,  // se completa cuando cierra
    pnl:         null,
  };

  try {
    fs.appendFileSync(SIGNAL_FILE, JSON.stringify(record) + '\n');
  } catch (e) {}

  return record;
}

// Actualizar el resultado cuando cierra el trade
function logSignalClose(posId, result, pnl) {
  ensureDir();
  try {
    // Leer todas las líneas, actualizar la que coincide con posId
    if (!fs.existsSync(SIGNAL_FILE)) return;
    const lines = fs.readFileSync(SIGNAL_FILE, 'utf8').trim().split('\n');
    const updated = lines.map(line => {
      try {
        const r = JSON.parse(line);
        if (r.posId === posId) {
          r.result = result;
          r.pnl = pnl;
          return JSON.stringify(r);
        }
        return line;
      } catch { return line; }
    });
    fs.writeFileSync(SIGNAL_FILE, updated.join('\n') + '\n');
  } catch (e) {}

  // Actualizar stats agregadas
  updateStats();
}

// Calcular y guardar estadísticas agregadas
function updateStats() {
  try {
    if (!fs.existsSync(SIGNAL_FILE)) return;
    const lines = fs.readFileSync(SIGNAL_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const closed = records.filter(r => r.result !== null);

    if (!closed.length) return;

    const wins   = closed.filter(r => r.result === 'WIN');
    const losses = closed.filter(r => r.result === 'LOSS');
    const totalPnL = closed.reduce((sum, r) => sum + (r.pnl || 0), 0);

    // Win rate por hora AR
    const byHour = {};
    for (const r of closed) {
      const h = r.argHour;
      if (!byHour[h]) byHour[h] = { wins: 0, total: 0, pnl: 0 };
      byHour[h].total++;
      byHour[h].pnl += r.pnl || 0;
      if (r.result === 'WIN') byHour[h].wins++;
    }

    // Win rate por rango de Z-score
    const byZscore = {};
    for (const r of closed) {
      const z = Math.abs(parseFloat(r.zscore) || 0);
      const bucket = z < 1.5 ? '<1.5' : z < 2.0 ? '1.5-2.0' : z < 2.5 ? '2.0-2.5' : '>2.5';
      if (!byZscore[bucket]) byZscore[bucket] = { wins: 0, total: 0 };
      byZscore[bucket].total++;
      if (r.result === 'WIN') byZscore[bucket].wins++;
    }

    // Win rate por imbalance
    const byImbalance = {};
    for (const r of closed) {
      const imb = parseFloat(r.imbalance) || 0;
      const bucket = imb < -0.2 ? 'sellers (<-0.2)' : imb > 0.2 ? 'buyers (>0.2)' : 'neutral';
      if (!byImbalance[bucket]) byImbalance[bucket] = { wins: 0, total: 0 };
      byImbalance[bucket].total++;
      if (r.result === 'WIN') byImbalance[bucket].wins++;
    }

    const stats = {
      updatedAt:   new Date().toISOString(),
      totalSignals: records.length,
      closedTrades: closed.length,
      wins:         wins.length,
      losses:       losses.length,
      winRate:      (wins.length / closed.length * 100).toFixed(1) + '%',
      totalPnL:     totalPnL.toFixed(2),
      byHour:       Object.fromEntries(
        Object.entries(byHour).sort((a,b) => parseInt(a[0])-parseInt(b[0])).map(([h, d]) => [
          `${String(h).padStart(2,'0')}h AR`,
          { winRate: (d.wins/d.total*100).toFixed(1)+'%', trades: d.total, pnl: d.pnl.toFixed(2) }
        ])
      ),
      byZscore:     Object.fromEntries(Object.entries(byZscore).map(([k, d]) => [
        k, { winRate: (d.wins/d.total*100).toFixed(1)+'%', trades: d.total }
      ])),
      byImbalance:  Object.fromEntries(Object.entries(byImbalance).map(([k, d]) => [
        k, { winRate: (d.wins/d.total*100).toFixed(1)+'%', trades: d.total }
      ])),
    };

    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {}
}

// Leer stats actuales
function getStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch { return null; }
}

module.exports = { logSignalOpen, logSignalClose, getStats };
