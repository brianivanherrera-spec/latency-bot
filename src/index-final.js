/**
 * LATENCY BOT - VERSIÓN FINAL
 * ✅ SignalEngine + PnLTracker + Cooldown + Live orders + Diagnóstico
 */

const { BinanceWS } = require('./binance');
const { PolymarketWS } = require('./polymarket-ws');
const marketResearch = require('./market-research');
const RESEARCH_MODE = process.env.RESEARCH_MODE === 'true';
const { SignalEngine } = require('./signal');
const { PolymarketClient } = require('./polymarket');
const { PnLTracker } = require('./tracker');
const { Logger } = require('./logger');
const config = require('./config');

// DYNAMIC_SIZING: escala automática de order size según balance actual.
// Variable de entorno: DYNAMIC_SIZE_SCALE="30:3,50:5,100:7,200:10,500:20,1000:50"
// Formato: "balanceMinimo:orderSize" separados por coma, en orden creciente.
// Si no está seteada o el balance no supera ningún tramo, usa ORDER_SIZE_USDC fijo.
function getDynamicOrderSize(balance, fallbackSize) {
  const scaleStr = process.env.DYNAMIC_SIZE_SCALE;
  if (!scaleStr || balance === null || balance === undefined) return fallbackSize;

  try {
    const tramos = scaleStr.split(',').map(pair => {
      const [bal, size] = pair.split(':').map(Number);
      return { bal, size };
    }).sort((a, b) => a.bal - b.bal);

    let selected = fallbackSize;
    for (const tramo of tramos) {
      if (balance >= tramo.bal) selected = tramo.size;
    }
    return selected;
  } catch (e) {
    return fallbackSize;
  }
}
const { alertTradeSignal, alertBotStart } = require('./alerts');
const signalLogger = require('./signal-logger');

const logger = new Logger('MAIN');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── Servidor HTTP para descargar signals.jsonl desde el browser ──────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.DOWNLOAD_SECRET || 'latency2026';

// ─── Dashboard HTML ────────────────────────────────────────────────────────────
function getDashboardHTML(key) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Latency Bot</title>
<style>
  :root {
    --bg:      #0a0c0f;
    --surface: #111318;
    --border:  #1e222a;
    --muted:   #3a3f4b;
    --text:    #c8cdd8;
    --dim:     #6b7280;
    --green:   #22c55e;
    --red:     #ef4444;
    --yellow:  #f59e0b;
    --blue:    #3b82f6;
    --mono:    'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    --sans:    system-ui, -apple-system, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--sans); min-height: 100vh; }

  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 24px; border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .logo { font-family: var(--mono); font-size: 13px; letter-spacing: 0.08em; color: var(--dim); }
  .logo span { color: var(--green); }
  .badge {
    font-family: var(--mono); font-size: 11px; padding: 3px 10px;
    border-radius: 3px; letter-spacing: 0.05em;
  }
  .badge.live   { background: rgba(239,68,68,.15);  color: var(--red);    border: 1px solid rgba(239,68,68,.3); }
  .badge.paper  { background: rgba(59,130,246,.15); color: var(--blue);   border: 1px solid rgba(59,130,246,.3); }
  .badge.ok     { background: rgba(34,197,94,.1);   color: var(--green);  border: 1px solid rgba(34,197,94,.25); }
  #last-update  { font-size: 11px; color: var(--dim); font-family: var(--mono); }

  main { padding: 20px 24px; display: grid; gap: 16px; max-width: 1200px; margin: 0 auto; }

  /* Fila de stats grandes */
  .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .kpi {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; padding: 16px 18px;
  }
  .kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--dim); margin-bottom: 8px; }
  .kpi-value { font-family: var(--mono); font-size: 26px; font-weight: 600; line-height: 1; }
  .kpi-sub   { font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 4px; }
  .pos { color: var(--green); } .neg { color: var(--red); } .neu { color: var(--text); }

  /* Fila secundaria */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 680px) { .two-col { grid-template-columns: 1fr; } }

  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; overflow: hidden;
  }
  .card-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--dim); padding: 12px 16px; border-bottom: 1px solid var(--border);
  }

  /* Tabla de trades */
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--dim);
       padding: 8px 12px; text-align: left; font-weight: 500; }
  td { font-family: var(--mono); font-size: 12px; padding: 7px 12px;
       border-top: 1px solid var(--border); }
  tr:hover td { background: rgba(255,255,255,.02); }
  .win  { color: var(--green); } .loss { color: var(--red); }
  .dir-up { color: #60a5fa; } .dir-dn { color: #c084fc; }

  /* Live status */
  .status-grid { padding: 14px 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .status-row { display: flex; justify-content: space-between; align-items: center; }
  .status-label { font-size: 11px; color: var(--dim); }
  .status-val   { font-family: var(--mono); font-size: 12px; }

  /* Mini bar WR */
  .wr-bar-wrap { padding: 14px 16px; }
  .wr-bar-label { display: flex; justify-content: space-between; font-size: 11px; color: var(--dim); margin-bottom: 6px; }
  .wr-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .wr-bar-fill { height: 100%; border-radius: 3px; transition: width .4s ease; }

  /* Balance sparkline placeholder */
  .spark { padding: 14px 16px; }
  #spark-canvas { width: 100%; height: 60px; display: block; }

  /* Posición abierta */
  .open-pos { padding: 14px 16px; }
  .open-pos-none { font-size: 12px; color: var(--dim); font-family: var(--mono); }

  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot.green { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot.red   { background: var(--red);   box-shadow: 0 0 6px var(--red); }
  .dot.dim   { background: var(--muted); }

  .pill {
    display: inline-block; font-size: 10px; font-family: var(--mono);
    padding: 2px 8px; border-radius: 3px; letter-spacing: 0.04em;
  }
  .pill.win  { background: rgba(34,197,94,.12);  color: var(--green); }
  .pill.loss { background: rgba(239,68,68,.12);  color: var(--red); }

  footer { padding: 14px 24px; text-align: center; font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); }
  #refresh-bar { height: 2px; background: var(--green); width: 100%; transform-origin: left; transition: transform 30s linear; }
</style>
</head>
<body>
<div id="refresh-bar"></div>
<header>
  <div class="logo">⚡ <span>latency</span>-bot</div>
  <div style="display:flex;gap:10px;align-items:center">
    <span id="mode-badge" class="badge">—</span>
    <span class="badge ok" id="ws-badge">WS</span>
    <span id="last-update">cargando...</span>
  </div>
</header>

<main>
  <div class="kpi-row" id="kpi-row">
    <div class="kpi"><div class="kpi-label">Balance</div><div class="kpi-value neu" id="k-balance">—</div><div class="kpi-sub" id="k-mode">—</div></div>
    <div class="kpi"><div class="kpi-label">PnL hoy</div><div class="kpi-value" id="k-pnl">—</div><div class="kpi-sub" id="k-pnl-sub">—</div></div>
    <div class="kpi"><div class="kpi-label">Win Rate</div><div class="kpi-value" id="k-wr">—</div><div class="kpi-sub" id="k-wr-sub">—</div></div>
    <div class="kpi"><div class="kpi-label">Fill Rate</div><div class="kpi-value" id="k-fill">—</div><div class="kpi-sub" id="k-fill-sub">—</div></div>
    <div class="kpi"><div class="kpi-label">BTC</div><div class="kpi-value neu" id="k-btc">—</div><div class="kpi-sub" id="k-poly">—</div></div>
  </div>

  <div class="two-col">
    <!-- Posición abierta + estado -->
    <div class="card">
      <div class="card-title">Estado en vivo</div>
      <div class="status-grid" id="live-status">
        <div class="status-row"><span class="status-label">Señales</span><span class="status-val" id="s-signals">—</span></div>
        <div class="status-row"><span class="status-label">Uptime</span><span class="status-val" id="s-uptime">—</span></div>
        <div class="status-row"><span class="status-label">Poly YES</span><span class="status-val" id="s-polyes">—</span></div>
        <div class="status-row"><span class="status-label">Slots activos</span><span class="status-val" id="s-slots">—</span></div>
      </div>
      <div style="padding: 0 16px 14px">
        <div class="card-title" style="padding:0;border:0;margin-bottom:10px">Posición abierta</div>
        <div class="open-pos-none" id="open-pos-text">Sin posición abierta</div>
      </div>
    </div>

    <!-- Win Rate visual -->
    <div class="card">
      <div class="card-title">Rendimiento hoy</div>
      <div class="wr-bar-wrap" id="wr-bars">
        <div class="wr-bar-label"><span>UP</span><span id="wr-up-pct">—</span></div>
        <div class="wr-bar"><div class="wr-bar-fill pos" id="wr-up-bar" style="width:0%"></div></div>
        <div style="height:10px"></div>
        <div class="wr-bar-label"><span>DOWN</span><span id="wr-dn-pct">—</span></div>
        <div class="wr-bar"><div class="wr-bar-fill" id="wr-dn-bar" style="width:0%;background:var(--blue)"></div></div>
      </div>
      <div style="padding: 0 16px 14px; display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center;">
        <div><div class="kpi-label">Z 0-2</div><div class="kpi-value" style="font-size:16px" id="z-low">—</div></div>
        <div><div class="kpi-label">Z 2-3</div><div class="kpi-value" style="font-size:16px" id="z-mid">—</div></div>
        <div><div class="kpi-label">Z 3+</div><div class="kpi-value" style="font-size:16px" id="z-hi">—</div></div>
      </div>
    </div>
  </div>

  <!-- Últimos trades -->
  <div class="card">
    <div class="card-title">Últimos trades</div>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Hora</th><th>Dir</th><th>Z</th><th>Score</th><th>Precio</th><th>PnL</th><th>Resultado</th>
        </tr></thead>
        <tbody id="trades-body">
          <tr><td colspan="7" style="color:var(--dim);text-align:center;padding:20px">Cargando...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</main>

<footer>Actualiza cada 30s · <a href="/?key=${key}&refresh=1" style="color:var(--dim)">forzar</a></footer>

<script>
const KEY = '${key}';
let balanceHistory = [];

function fmt(n, dec=2) { return n == null ? '—' : Number(n).toFixed(dec); }
function fmtUSD(n) {
  if (n == null) return '—';
  const s = Math.abs(n).toFixed(2);
  return (n >= 0 ? '+$' : '-$') + s;
}
function fmtUptime(s) {
  if (!s) return '—';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return h + 'h ' + m + 'm';
}
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

async function loadHealth() {
  try {
    const r = await fetch('/health');
    const d = await r.json();
    document.getElementById('k-btc').textContent = d.btcPrice ? '$' + Number(d.btcPrice).toLocaleString('en',{maximumFractionDigits:0}) : '—';
    document.getElementById('s-polyes').textContent = d.polyYes ? d.polyYes.toFixed(3) : '—';
    document.getElementById('s-signals').textContent = d.signals ?? '—';
    document.getElementById('s-uptime').textContent = fmtUptime(d.uptime);
    document.getElementById('s-slots').textContent = d.openPositions ?? '—';
    const modeBadge = document.getElementById('mode-badge');
    modeBadge.textContent = d.mode === 'live' ? '🔴 LIVE' : '✓ PAPER';
    modeBadge.className = 'badge ' + (d.mode === 'live' ? 'live' : 'paper');
    document.getElementById('k-mode').textContent = d.mode === 'live' ? 'capital real' : 'paper trading';
  } catch(e) {}
}

async function loadStats() {
  try {
    const r = await fetch('/stats?key=' + KEY + '&days=1');
    const d = await r.json();
    if (d.error) return;

    // KPIs
    const pnlEl = document.getElementById('k-pnl');
    pnlEl.textContent = fmtUSD(d.pnl);
    pnlEl.className = 'kpi-value ' + (d.pnl > 0 ? 'pos' : d.pnl < 0 ? 'neg' : 'neu');
    document.getElementById('k-pnl-sub').textContent = (d.trades ?? 0) + ' trades hoy';

    const wrEl = document.getElementById('k-wr');
    wrEl.textContent = d.wr != null ? d.wr + '%' : '—';
    wrEl.className = 'kpi-value ' + (d.wr >= 55 ? 'pos' : d.wr >= 45 ? 'neu' : 'neg');
    document.getElementById('k-wr-sub').textContent = (d.wins??0) + 'W / ' + (d.losses??0) + 'L';

    const fillEl = document.getElementById('k-fill');
    fillEl.textContent = d.fill_rate != null ? d.fill_rate + '%' : '—';
    fillEl.className = 'kpi-value ' + (d.fill_rate >= 65 ? 'pos' : d.fill_rate >= 50 ? 'neu' : 'neg');
    document.getElementById('k-fill-sub').textContent = (d.nofills??0) + ' NO_FILLs';

    // Poly
    document.getElementById('k-poly').textContent = 'Poly YES: ' + (document.getElementById('s-polyes').textContent);

    // Barras WR por dirección
    const up = d.by_direction?.UP;
    const dn = d.by_direction?.DOWN;
    if (up) {
      document.getElementById('wr-up-pct').textContent = up.wr + '% (' + up.n + ' trades)';
      document.getElementById('wr-up-bar').style.width = up.wr + '%';
    }
    if (dn) {
      document.getElementById('wr-dn-pct').textContent = dn.wr + '% (' + dn.n + ' trades)';
      document.getElementById('wr-dn-bar').style.width = dn.wr + '%';
      document.getElementById('wr-dn-bar').style.background = dn.wr >= 55 ? 'var(--green)' : dn.wr >= 45 ? 'var(--yellow)' : 'var(--red)';
    }

    // Z-score buckets
    const zBuckets = d.by_zscore || {};
    const z0 = zBuckets['z_0_2']; const z1 = zBuckets['z_2_3']; const z2 = zBuckets['z_3_4'] || zBuckets['z_3_99'] || zBuckets['z_4_99'];
    document.getElementById('z-low').textContent = z0 ? z0.wr + '%' : '—';
    document.getElementById('z-low').className = 'kpi-value ' + (!z0 ? 'neu' : z0.wr >= 55 ? 'pos' : z0.wr >= 45 ? 'neu' : 'neg');
    document.getElementById('z-mid').textContent = z1 ? z1.wr + '%' : '—';
    document.getElementById('z-mid').className = 'kpi-value ' + (!z1 ? 'neu' : z1.wr >= 55 ? 'pos' : z1.wr >= 45 ? 'neu' : 'neg');
    document.getElementById('z-hi').textContent = z2 ? z2.wr + '%' : '—';
    document.getElementById('z-hi').className = 'kpi-value ' + (!z2 ? 'neu' : z2.wr >= 55 ? 'pos' : z2.wr >= 45 ? 'neu' : 'neg');

  } catch(e) {}
}

async function loadTrades() {
  try {
    const r = await fetch('/signals?key=' + KEY);
    const text = await r.text();
    const lines = text.trim().split('\\n').filter(Boolean);
    const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const today = new Date(); today.setHours(0,0,0,0);
    const recent = all
      .filter(t => t.result === 'WIN' || t.result === 'LOSS')
      .filter(t => new Date(t.timestamp) >= today)
      .slice(-15).reverse();

    const tbody = document.getElementById('trades-body');
    if (!recent.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--dim);text-align:center;padding:20px">Sin trades hoy</td></tr>';
      return;
    }

    tbody.innerHTML = recent.map(t => {
      const pnlSign = t.pnl >= 0 ? 'pos' : 'neg';
      const dirClass = t.direction === 'UP' ? 'dir-up' : 'dir-dn';
      const dirArrow = t.direction === 'UP' ? '▲ UP' : '▼ DN';
      const hora = fmtTime(t.timestamp);
      const precio = t.filled_price ? '$' + Number(t.filled_price).toFixed(3) : '—';
      return \`<tr>
        <td>\${hora}</td>
        <td class="\${dirClass}">\${dirArrow}</td>
        <td>\${t.zscore != null ? Number(t.zscore).toFixed(1) : '—'}</td>
        <td>\${t.signalScore ?? '—'}</td>
        <td>\${precio}</td>
        <td class="\${pnlSign}">\${fmtUSD(t.pnl)}</td>
        <td><span class="pill \${t.result === 'WIN' ? 'win' : 'loss'}">\${t.result}</span></td>
      </tr>\`;
    }).join('');

    // Balance actual estimado
    const totalPnl = all.filter(t => (t.result==='WIN'||t.result==='LOSS') && new Date(t.timestamp)>=today)
      .reduce((s,t) => s+(t.pnl||0), 0);
    document.getElementById('k-balance').textContent = '~$' + (30 + totalPnl).toFixed(2);

    // Posición abierta
    const open = all.filter(t => !t.result || t.result === null).slice(-1)[0];
    const posEl = document.getElementById('open-pos-text');
    if (open) {
      posEl.innerHTML = \`<span class="dot green"></span><span style="color:var(--text)">\${open.direction} @ \${open.filled_price ? '$'+Number(open.filled_price).toFixed(3) : '?'}</span><span style="color:var(--dim);margin-left:8px">\${open.market?.split(' - ')[1] || ''}</span>\`;
    } else {
      posEl.innerHTML = '<span class="dot dim"></span><span style="color:var(--dim)">Sin posición abierta</span>';
    }

  } catch(e) {}
}

async function refresh() {
  document.getElementById('last-update').textContent = 'actualizando...';
  await Promise.all([loadHealth(), loadStats(), loadTrades()]);
  document.getElementById('last-update').textContent = 'actualizado ' + fmtTime(new Date().toISOString());
  // Reiniciar barra de progreso
  const bar = document.getElementById('refresh-bar');
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';
  setTimeout(() => {
    bar.style.transition = 'transform 30s linear';
    bar.style.transform = 'scaleX(0)';
  }, 50);
}

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const sigStats = (typeof signal !== 'undefined' && signal?.getStats) ? signal.getStats() : {};
    const trackerStats = (typeof tracker !== 'undefined' && tracker?.getStats) ? tracker.getStats() : {};
    res.end(JSON.stringify({
      status: 'ok',
      mode: process.env.DRY_RUN === 'true' ? 'paper' : 'live',
      orderType: process.env.ORDER_TYPE || 'GTC',
      btcTrendFilter: parseInt(process.env.BTC_TREND_FILTER || '0'),
      uptime: process.uptime(),
      btcPrice: sigStats.lastPrice || null,
      polyYes: sigStats.polyYes || null,
      wins: trackerStats.wins || 0,
      losses: trackerStats.losses || 0,
      totalPnL: trackerStats.totalPnL || 0,
      openPositions: trackerStats.openPositions || 0,
      signals: sigStats.signals || 0,
    }));
    return;
  }
  
  if (url.pathname === '/signals' && url.searchParams.get('key') === SECRET) {
    const file = path.join(process.env.DATA_DIR || '/data', 'signals.jsonl');
    if (!fs.existsSync(file)) {
      res.writeHead(404); res.end('No signals file yet'); return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename=signals.jsonl',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (url.pathname === '/research' && url.searchParams.get('key') === SECRET) {
    const file = process.env.RESEARCH_FILE || path.join(process.env.DATA_DIR || '/data', 'market-research.jsonl');
    if (!fs.existsSync(file)) {
      res.writeHead(404); res.end('No research file yet — activar RESEARCH_MODE=true'); return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename=market-research.jsonl',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  
  if (url.pathname === '/stats' && url.searchParams.get('key') === SECRET) {
    // Resumen liviano sin bajar el log completo: /stats?key=X&days=1
    const days = parseInt(url.searchParams.get('days') || '1');
    const summary = signalLogger.getDailySummary(days);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary, null, 2));
    return;
  }

  if (url.pathname === '/' && url.searchParams.get('key') === SECRET) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML(SECRET));
    return;
  }
  
  res.writeHead(401); res.end('Unauthorized');
});

httpServer.listen(PORT, () => {
  logger.info(`🌐 HTTP server en puerto ${PORT} — /signals?key=${SECRET} para descargar`);
});

const tracker = new PnLTracker();
const activePositions = new Map();

let lastTradeTime = 0;
const COOLDOWN = parseInt(process.env.COOLDOWN_SECONDS || '180') * 1000; // configurable via Railway

async function main() {
  logger.info('═'.repeat(70));
  logger.info('🎯 LATENCY BOT - Versión Final');
  logger.info('═'.repeat(70));
  logger.info(`Modo: ${config.DRY_RUN ? 'PAPER TRADING ✓' : 'LIVE 🔴'}`);
  logger.info(`Cooldown: ${COOLDOWN/1000}s | Min edge: ${config.MIN_EDGE_PCT}%`);
  logger.info('');
  alertBotStart({ dryRun: config.DRY_RUN });

  const signal = new SignalEngine();
  const poly = new PolymarketClient();
  const ws = new BinanceWS();
  const polyWs = new PolymarketWS(); // Fix B: WebSocket en tiempo real

  let cachedMarket = null;
  let nextMarketCache = null;   // FIX A: mercado pre-fetcheado
  let lastPolyPrice = '';
  let preFetchScheduled = false;

  // FIX A: calcular timestamp del próximo mercado de 5 minutos
  function getNextWindowTs() {
    const now = Math.floor(Date.now() / 1000);
    const currentWindow = now - (now % 300);
    return currentWindow + 300; // próximo múltiplo de 300s
  }

  // FIX A: pre-fetchear el próximo mercado antes de que el actual cierre
  async function preFetchNextMarket() {
    if (preFetchScheduled) return;
    preFetchScheduled = true;
    const nextTs = getNextWindowTs();
    const msUntilNext = (nextTs * 1000) - Date.now();
    // Pre-fetchear 30s antes del próximo mercado
    const delay = Math.max(0, msUntilNext - 30000);
    logger.info(`[POLY] Pre-fetch próximo mercado en ${Math.round(delay/1000)}s (T-30s antes de apertura)`);
    setTimeout(async () => {
      preFetchScheduled = false;
      const m = await poly.findNextBTCMarket(nextTs);
      if (m) {
        nextMarketCache = m;
        logger.info(`[POLY] ✅ Próximo mercado pre-cacheado: ${m.question}`);
      }
    }, delay);
  }

  async function actualizarPrecioPolymarket() {
    // Si no hay mercado activo, usar el pre-cacheado si está disponible
    if (!cachedMarket?.gammaId) {
      if (nextMarketCache) {
        // Verificar que el próximo mercado ya empezó
        const now = Date.now();
        const marketStart = new Date(nextMarketCache.endDate).getTime() - 300000;
        if (now >= marketStart) {
          cachedMarket = nextMarketCache;
          nextMarketCache = null;
          logger.info(`[POLY] ✅ Mercado pre-cacheado activado: ${cachedMarket.question}`);
          logger.info(`[POLY] yesToken: ${cachedMarket.yesTokenId}`);
          logger.info(`[POLY] noToken: ${cachedMarket.noTokenId}`);
          // Fix B: suscribir al nuevo mercado via WS
          polyWs.unsubscribeAll();
          polyWs.subscribe(cachedMarket.yesTokenId, cachedMarket.noTokenId);
          if (RESEARCH_MODE) {
            marketResearch.startMarket({
              marketId: cachedMarket.conditionId || cachedMarket.gammaId,
              question: cachedMarket.question,
              endDate: cachedMarket.endDate,
              priceAtOpen: signal.getStats()?.lastPrice || 0,
            });
          }
        }
      }
      // Si no hay pre-cache, buscar normalmente
      if (!cachedMarket?.gammaId) {
        const m = await poly.findBTCMarket();
        if (m) {
          cachedMarket = m;
          logger.info(`[POLY] Mercado: ${m.question}`);
          logger.info(`[POLY] yesToken: ${m.yesTokenId}`);
          logger.info(`[POLY] noToken: ${m.noTokenId}`);
          // Fix B: suscribir al WS de Polymarket para precio en tiempo real
          polyWs.unsubscribeAll();
          polyWs.subscribe(m.yesTokenId, m.noTokenId);
          if (RESEARCH_MODE) {
            marketResearch.startMarket({
              marketId: m.conditionId || m.gammaId,
              question: m.question,
              endDate: m.endDate,
              priceAtOpen: signal.getStats()?.lastPrice || 0,
            });
          }
        } else {
          return;
        }
      }
    }

    if (!cachedMarket?.gammaId) return;
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets/${cachedMarket.gammaId}`);
      if (!res.ok) {
        logger.warn(`[POLY] Gamma API error: ${res.status}`);
        return;
      }
      const data = await res.json();
      if (data.outcomePrices) {
        const prices = typeof data.outcomePrices === 'string'
          ? JSON.parse(data.outcomePrices)
          : data.outcomePrices;
        const yes = parseFloat(prices[0]);
        const no = parseFloat(prices[1]);
        if (yes >= 0.05 && yes <= 0.95) {
          signal.updatePolyPrice(yes, no);
          const tag = `YES=${yes.toFixed(3)} NO=${no.toFixed(3)}`;
          if (tag !== lastPolyPrice) {
            logger.info(`[POLY] ${tag}`);
            lastPolyPrice = tag;
          }
          if (RESEARCH_MODE && marketResearch.isActive()) {
            marketResearch.recordTick({
              btcPrice: signal.getStats()?.lastPrice,
              polyYes: yes, polyNo: no,
            });
          }
          // FIX A: pre-fetchear próximo mercado cuando quedan ~60s
          if (!cachedMarket?.endDate) return;
          const msRestantes = new Date(cachedMarket.endDate).getTime() - Date.now();
          if (msRestantes < 60000 && msRestantes > 0 && !nextMarketCache) {
            preFetchNextMarket();
          }
        } else {
          logger.info(`[POLY] Mercado resuelto (YES=${yes}), activando pre-cache...`);
          if (RESEARCH_MODE && marketResearch.isActive()) {
            marketResearch.closeMarket({
              finalPrice: signal.getStats()?.lastPrice,
              winner: yes >= 0.95 ? 'UP' : 'DOWN',
            });
          }
          cachedMarket = null;
          lastPolyPrice = '';
          preFetchScheduled = false;
        }
      }
    } catch (err) {
      logger.warn(`[POLY] Error actualizando precio: ${err.message}`);
    }
  }

  // Fix B: callback del WS de Polymarket — precio en tiempo real (<50ms)
  // Guardamos el último precio en variables locales para que el signal-logger
  // pueda leerlas dinámicamente en los snapshots t0/t1/t2/t5 — antes leía
  // del objeto de señal que quedaba estático desde el momento de la señal.
  let livePolyYes = null;
  let livePolyNo  = null;
  let lastLoggedPolyYes = null;
  let lastLoggedPolyAt = 0;

  polyWs.onPrice((yes, no) => {
    signal.updatePolyPrice(yes, no);
    livePolyYes = yes;
    livePolyNo  = no;
    // Loguear solo si: cambió >0.02 desde el último log Y pasaron >5s
    // El WS manda decenas de ticks/minuto — sin este throttle llena el log
    const now = Date.now();
    const priceMoved = lastLoggedPolyYes === null || Math.abs(yes - lastLoggedPolyYes) >= 0.02;
    const timeElapsed = now - lastLoggedPolyAt > 5000;
    if (priceMoved && timeElapsed) {
      logger.info(`[POLY-WS] YES=${yes.toFixed(3)} NO=${no.toFixed(3)}`);
      lastLoggedPolyYes = yes;
      lastLoggedPolyAt = now;
    }
  });

  polyWs.onResolved((winner) => {
    // Solo log — NO nullificar cachedMarket acá.
    // El poll Gamma / transición de mercado ya maneja el cambio de ventana.
    // Nullificar + unsubscribe generaba loop: resuelto → null → refetch →
    // resubscribe → best_bid_ask extremo → "resuelto" otra vez.
    logger.info(`[POLY-WS] Mercado resuelto (${winner}) — esperando transición natural`);
  });

  // Conectar WS de Polymarket en paralelo
  polyWs.connect().catch(err => logger.warn(`Polymarket WS no disponible: ${err.message} — usando HTTP polling`));

  logger.info('[POLY] Obteniendo precio inicial...');
  await actualizarPrecioPolymarket();

  // HTTP polling cada 2s como fallback si el WS falla
  setInterval(actualizarPrecioPolymarket, 2000);

  setInterval(async () => {
    await tracker.checkClosedPositions();
  }, 60000);

  // ─── Position Monitor: SL / TP / Lock-in ─────────────────────────────────
  // Revisa cada 3 segundos todas las posiciones abiertas. Si el precio actual
  // del token supera el umbral de take-profit (lock-in) o cae por debajo del
  // stop-loss, cierra la posición activamente vendiendo al mercado.
  //
  // Por qué importa: sin esto, una posición perdedora quema el 100% del stake
  // hasta la resolución. Con SL al 50%, rescatamos ~la mitad en pérdidas claras.
  // Con lock-in al 0.90+, aseguramos la ganancia cuando el edge ya se expresó
  // y el riesgo de reversión pesa más que lo que queda por ganar.
  //
  //   POSITION_MONITOR=true           → activa el monitor (default: false)
  //   LOCK_IN_THRESHOLD=0.92          → cierra si el token llega a $0.92+ (ganancia)
  //   STOP_LOSS_PCT=0.5               → cierra si perdiste >50% del stake (pérdida)
  //   POSITION_MONITOR_INTERVAL_MS=3000 → frecuencia de chequeo
  const monitorEnabled = process.env.POSITION_MONITOR === 'true';
  if (monitorEnabled && !config.DRY_RUN) {
    const LOCK_IN = parseFloat(process.env.LOCK_IN_THRESHOLD || '0.92');
    const SL_PCT  = parseFloat(process.env.STOP_LOSS_PCT || '0.5');
    const MONITOR_INTERVAL = parseInt(process.env.POSITION_MONITOR_INTERVAL_MS || '3000');
    const closingPositions = new Set(); // evitar doble-cierre

    setInterval(async () => {
      const openPositions = tracker.getOpenPositions();
      if (!openPositions.length) return;

      for (const pos of openPositions) {
        if (closingPositions.has(pos.id)) continue;
        if (!pos.tokenId) continue; // posición sin tokenId no se puede monitorear

        let midPrice;
        try {
          midPrice = await poly.getTokenMidPrice(pos.tokenId);
        } catch (e) { continue; }
        if (midPrice === null) continue;

        // Para un BUY (compramos YES/NO esperando que suba a $1):
        //   - lock-in si midPrice >= LOCK_IN (ya casi ganó, asegurar)
        //   - SL si midPrice <= entryPrice * (1 - SL_PCT) (perdió >SL_PCT del stake)
        // Para un SELL (vendemos NO esperando que baje a $0):
        //   - lock-in si el precio del token cayó a <= (1 - LOCK_IN) — espejo
        //   - SL si el precio subió demasiado contra nosotros
        const isBuy = pos.side === 'BUY';
        const tokenCurrentPrice = midPrice;
        const slThreshold = isBuy
          ? pos.entryPrice * (1 - SL_PCT)
          : pos.entryPrice + (pos.entryPrice * SL_PCT);

        const hitLockIn = isBuy
          ? tokenCurrentPrice >= LOCK_IN
          : tokenCurrentPrice <= (1 - LOCK_IN);
        const hitSL = isBuy
          ? tokenCurrentPrice <= slThreshold
          : tokenCurrentPrice >= slThreshold;

        if (!hitLockIn && !hitSL) continue;

        const reason = hitLockIn ? `LOCK-IN (precio $${tokenCurrentPrice.toFixed(3)} >= $${LOCK_IN})` : `STOP-LOSS (precio $${tokenCurrentPrice.toFixed(3)} <= $${slThreshold.toFixed(3)})`;
        logger.warn(`[POSITION-MONITOR] 🚨 ${reason} en ${pos.id} — cerrando`);
        closingPositions.add(pos.id);

        const exitResult = await poly.sellPosition({
          tokenId: pos.tokenId,
          size: pos.size,
          side: pos.side,
          posId: pos.id,
        });

        if (exitResult.success) {
          // Calcular PnL real de la salida anticipada
          const exitPrice = exitResult.price;
          const pnl = isBuy
            ? parseFloat(((exitPrice - pos.entryPrice) * pos.size).toFixed(2))
            : parseFloat(((pos.entryPrice - exitPrice) * pos.size).toFixed(2));
          tracker.forceClosePosition(pos.id, pnl, reason);
        }
        closingPositions.delete(pos.id);
      }
    }, MONITOR_INTERVAL);
    logger.info(`[POSITION-MONITOR] ✅ Activo — lock-in: $${LOCK_IN} | SL: ${SL_PCT*100}% del stake | intervalo: ${MONITOR_INTERVAL}ms`);
  }

  // Historial de precio BTC con timestamp para filtro de tendencia exacto
  const btcPriceHistory = []; // [{price, ts}] — ventana de 1 hora (filtro rápido)
  const BTC_TREND_WINDOW_MS = 60 * 60 * 1000; // 1 hora en ms

  // Segundo historial para el filtro de ventana larga — detecta derivas lentas
  // y sostenidas que el filtro de 1 hora no puede ver (ej: BTC +$1800 en 38hs
  // a ~$60/hora, nunca supera $500/hora pero acumula una tendencia real).
  // Controlado por BTC_TREND_FILTER_LONG y BTC_TREND_WINDOW_HOURS_LONG.
  const btcPriceHistoryLong = []; // [{price, ts}]
  const BTC_TREND_WINDOW_HOURS_LONG = parseFloat(process.env.BTC_TREND_WINDOW_HOURS_LONG || '4');
  const BTC_TREND_WINDOW_MS_LONG = BTC_TREND_WINDOW_HOURS_LONG * 60 * 60 * 1000;

  // Tercer historial: ventana de 10 minutos para detectar movimientos bruscos
  // rápidos. Complementa al de 1h (sacudidas) y al de 4h (derivas lentas).
  // Controlado por BTC_TREND_FILTER_10M (umbral en $, default 0 = desactivado).
  const btcPriceHistory10m = []; // [{price, ts}]
  const BTC_TREND_WINDOW_10M_MS = 10 * 60 * 1000; // 10 minutos

  ws.onPrice(async (priceData) => {
    const btcPriceNow = priceData.price || priceData.currentPrice || priceData.lastPrice || 0;
    const nowMs = Date.now();
    if (btcPriceNow > 0) {
      btcPriceHistory.push({ price: btcPriceNow, ts: nowMs });
      // Limpiar entradas más viejas de 1 hora
      while (btcPriceHistory.length > 0 && nowMs - btcPriceHistory[0].ts > BTC_TREND_WINDOW_MS) {
        btcPriceHistory.shift();
      }
      // Historial largo — mantiene hasta BTC_TREND_WINDOW_HOURS_LONG horas
      btcPriceHistoryLong.push({ price: btcPriceNow, ts: nowMs });
      while (btcPriceHistoryLong.length > 0 && nowMs - btcPriceHistoryLong[0].ts > BTC_TREND_WINDOW_MS_LONG) {
        btcPriceHistoryLong.shift();
      }
      // Historial de 10 minutos para trend filter rápido
      btcPriceHistory10m.push({ price: btcPriceNow, ts: nowMs });
      while (btcPriceHistory10m.length > 0 && nowMs - btcPriceHistory10m[0].ts > BTC_TREND_WINDOW_10M_MS) {
        btcPriceHistory10m.shift();
      }
    }

    const sig = signal.process(priceData);
    if (!sig || sig.direction === 'NEUTRAL') return;
    const MIN_BUFFER = parseInt(process.env.MIN_BUFFER_SIZE || '100');
    if (sig.bufferSize !== undefined && sig.bufferSize < MIN_BUFFER) return; // warmup

    // ─── Filtro de horario ────────────────────────────────────────────
    if (config.TRADING_HOURS_ENABLED) {
      const utcHour = new Date().getUTCHours();
      if (config.TRADING_HOURS_BLOCKED_UTC.includes(utcHour)) {
        return; // hora bloqueada — win rate histórico < 45%
      }
    }

    // ─── Filtro de tendencia BTC ──────────────────────────────────────
    const trendFilter = parseInt(process.env.BTC_TREND_FILTER || '0');
    if (trendFilter > 0 && btcPriceHistory.length > 0) {
      const btcPriceNow = sig.currentPrice || btcPriceHistory[btcPriceHistory.length-1]?.price || 0;
      const oldestEntry = btcPriceHistory[0];
      const ageMinutes = (Date.now() - oldestEntry.ts) / 60000;
      const btcMoveLastHour = btcPriceNow - oldestEntry.price;

      // Loggear estado del historial cada 5 minutos
      if (btcPriceHistory.length % 300 === 1) {
        logger.info(`[TREND] Historial: ${ageMinutes.toFixed(0)}min | BTC move: $${btcMoveLastHour.toFixed(0)} | filtro: $${trendFilter}`);
      }

      // Solo aplicar filtro si tenemos al menos 5 minutos de historial
      if (ageMinutes >= 5) {
        if (btcMoveLastHour > trendFilter && sig.direction === 'DOWN') {
          logger.warn(`[SKIP] 📈 BTC +$${btcMoveLastHour.toFixed(0)} en ${ageMinutes.toFixed(0)}min — bloqueando DOWN`);
          return;
        }
        if (btcMoveLastHour < -trendFilter && sig.direction === 'UP') {
          logger.warn(`[SKIP] 📉 BTC $${btcMoveLastHour.toFixed(0)} en ${ageMinutes.toFixed(0)}min — bloqueando UP`);
          return;
        }
      }
    }

    // ─── Filtro de tendencia BTC — ventana larga ──────────────────────────
    // Detecta derivas lentas y sostenidas (ej: BTC +$1800 en 38hs a ~$60/hora)
    // que el filtro de 1 hora no puede ver porque nunca superan el umbral puntual
    // aunque acumulen una tendencia real. Requiere BTC_TREND_FILTER_LONG > 0.
    //   BTC_TREND_FILTER_LONG=500      → umbral en $ para la ventana larga
    //   BTC_TREND_WINDOW_HOURS_LONG=4  → cuántas horas mira atrás (default 4)
    const trendFilterLong = parseInt(process.env.BTC_TREND_FILTER_LONG || '0');
    if (trendFilterLong > 0 && btcPriceHistoryLong.length > 0) {
      const btcPriceNow = sig.currentPrice || btcPriceHistoryLong[btcPriceHistoryLong.length-1]?.price || 0;
      const oldestLong = btcPriceHistoryLong[0];
      const ageHoursLong = (Date.now() - oldestLong.ts) / 3600000;
      const btcMoveLong = btcPriceNow - oldestLong.price;

      // Solo aplicar si tenemos al menos el 50% de la ventana configurada
      if (ageHoursLong >= BTC_TREND_WINDOW_HOURS_LONG * 0.5) {
        if (btcMoveLong > trendFilterLong && sig.direction === 'DOWN') {
          logger.warn(`[SKIP] 📈 TREND-LARGO: BTC +$${btcMoveLong.toFixed(0)} en ${(ageHoursLong).toFixed(1)}hs — bloqueando DOWN`);
          return;
        }
        if (btcMoveLong < -trendFilterLong && sig.direction === 'UP') {
          logger.warn(`[SKIP] 📉 TREND-LARGO: BTC $${btcMoveLong.toFixed(0)} en ${(ageHoursLong).toFixed(1)}hs — bloqueando UP`);
          return;
        }
      }
    }

    // ─── Filtro de tendencia BTC — 10 minutos ─────────────────────────────
    // Detecta movimientos bruscos en ventana corta. Complementa al de 1h y 4h.
    // Un $150 en 10 min = $900/hora equivalente — señal fuerte y accionable.
    //   BTC_TREND_FILTER_10M=150  → umbral razonable (0 = desactivado)
    const trendFilter10m = parseInt(process.env.BTC_TREND_FILTER_10M || '0');
    if (trendFilter10m > 0 && btcPriceHistory10m.length > 0) {
      const btcPriceNow10m = sig.currentPrice || btcPriceHistory10m[btcPriceHistory10m.length-1]?.price || 0;
      const oldest10m = btcPriceHistory10m[0];
      const age10mMin = (Date.now() - oldest10m.ts) / 60000;
      const btcMove10m = btcPriceNow10m - oldest10m.price;
      if (age10mMin >= 2) {
        if (btcMove10m > trendFilter10m && sig.direction === 'DOWN') {
          logger.warn(`[SKIP] 📈 TREND-10M: BTC +$${btcMove10m.toFixed(0)} en ${age10mMin.toFixed(0)}min — bloqueando DOWN`);
          return;
        }
        if (btcMove10m < -trendFilter10m && sig.direction === 'UP') {
          logger.warn(`[SKIP] 📉 TREND-10M: BTC $${btcMove10m.toFixed(0)} en ${age10mMin.toFixed(0)}min — bloqueando UP`);
          return;
        }
      }
    }

    // ─── Filtro "Polymarket ya se movió" ──────────────────────────────────
    // Si Polymarket ya absorbió el lag (precio lejos de 0.50), nuestro edge
    // ya es menor. Inspirado en tochiugo v3: max_poly_move_after_signal=0.03.
    //   MAX_POLY_MOVE=0.03  → si mid ya está en 0.53+/0.47-, skip
    const maxPolyMove = parseFloat(process.env.MAX_POLY_MOVE || '0');
    if (maxPolyMove > 0) {
      const polyMid = sig.direction === 'UP' ? sig.edge?.polyYes : sig.edge?.polyNo;
      if (polyMid !== undefined && Math.abs(polyMid - 0.5) > maxPolyMove) {
        logger.warn(`[SKIP] 📊 POLY-MOVIDO: mid $${polyMid?.toFixed(3)} ya absorbió el lag (umbral: ${maxPolyMove})`);
        return;
      }
    }

    const now = Date.now();

    if (now - lastTradeTime < COOLDOWN) return;

    // ─── Circuit Breaker ──────────────────────────────────────────────────
    // 3 losses consecutivos → pausa 30 minutos para evitar rachas malas
    const CIRCUIT_BREAKER_LOSSES = parseInt(process.env.CIRCUIT_BREAKER_LOSSES || '3');
    const CIRCUIT_BREAKER_PAUSE_MS = parseInt(process.env.CIRCUIT_BREAKER_PAUSE_MIN || '30') * 60 * 1000;
    const consecLosses = signalLogger.getConsecutiveLosses();
    if (consecLosses >= CIRCUIT_BREAKER_LOSSES) {
      if (!global._lastCircuitBreakTime) global._lastCircuitBreakTime = now;
      const pauseRemaining = Math.max(0, CIRCUIT_BREAKER_PAUSE_MS - (now - global._lastCircuitBreakTime));
      if (pauseRemaining > 0) {
        logger.warn(`[CIRCUIT BREAKER] ${consecLosses} losses seguidos — pausa ${Math.ceil(pauseRemaining/60000)}min restantes`);
        return;
      }
    } else {
      global._lastCircuitBreakTime = null;
    }

    // ✅ LOG DE DIAGNÓSTICO - ver qué pasa con cada señal
    logger.info(`[SIG] ${sig.direction} | Z:${sig.zScore.toFixed(2)} Move:${sig.movePct.toFixed(3)}% | ${sig.edge?.reason} ${sig.edge?.edgePct ?? 'n/a'}%`);

    if (!sig.edge || sig.edge.reason !== 'EDGE_FOUND') return;
    if (sig.edge.edgePct < config.MIN_EDGE_PCT || sig.edge.edgePct > 15) return;

    const maxSlots = parseInt(process.env.MAX_ACTIVE_POSITIONS || '1');
    if (activePositions.size >= maxSlots) {
      logger.warn(`[SKIP] Slot ocupado (${activePositions.size}/${maxSlots}) — esperando que se libere una posición`);
      return;
    } // límite de posiciones simultáneas

    // DUAL_ENTRY_MODE: permite 2 entradas en el mismo mercado —
    // una temprana (lógica normal) y una tardía (LATE_ENTRY confirmado).
    // Sin DUAL_ENTRY_MODE, se mantiene el bloqueo clásico de 1 entrada por mercado.
    const dualEntryMode = process.env.DUAL_ENTRY_MODE === 'true';
    // Fix: antes este bloque completo se salteaba si cachedMarket.conditionId
    // era falsy (ej. durante la transición de un mercado a otro), dejando
    // pasar entradas sin chequear duplicados — "fail-open". Ahora siempre
    // se evalúa: usa gammaId como fallback, y si no hay NINGÚN id confiable
    // de mercado, trata cualquier posición activa como conflicto potencial
    // ("fail-safe" — ante la duda, bloquea en vez de dejar pasar).
    const marketKey = cachedMarket?.conditionId || cachedMarket?.gammaId || null;
    const entriesInThisMarket = marketKey
      ? Array.from(activePositions.values()).filter(p => p.marketId === marketKey)
      : Array.from(activePositions.values());

    if (!marketKey && activePositions.size > 0) {
      logger.warn(`[SKIP] Sin ID de mercado confiable y ya hay ${activePositions.size} posición(es) activa(s) — bloqueando por seguridad`);
      return;
    }

    if (marketKey || activePositions.size > 0) {
      if (dualEntryMode) {
        // Máximo 2 entradas por mercado: 1 normal + 1 late entry
        const maxPerMarket = 2;
        if (entriesInThisMarket.length >= maxPerMarket) {
          logger.warn(`[SKIP] Ya hay ${entriesInThisMarket.length} posiciones en este mercado (máx ${maxPerMarket})`);
          return;
        }
        // Si ya hay 1 entrada, la segunda SOLO puede ser vía LATE_ENTRY confirmado
        if (entriesInThisMarket.length >= 1 && entriesInThisMarket[0].entryType !== 'late') {
          // Marcar que esta próxima entrada (si pasa) será la "late" —
          // se valida más abajo en el bloque LATE_ENTRY_MODE
          global.__pendingEntryType = 'late';
        }
      } else {
        // Comportamiento clásico: solo 1 entrada por mercado
        if (entriesInThisMarket.length >= 1) {
          logger.warn(`[SKIP] Ya hay posición abierta en este mercado — evitando doble entry`);
          return;
        }
      }
    }

    // DYNAMIC_SIZING: escala el order size automáticamente según el balance
    // actual en Polymarket. Se define con pares "balance:size" separados por
    // coma, por ejemplo: "30:3,50:5,100:7,200:10" — usa el tramo más alto
    // que el balance actual ya haya superado.
    //
    // Fix: en PAPER, currentBalance venía del balance REAL de la wallet
    // (consultado una sola vez al arrancar) y nunca reflejaba el crecimiento
    // del capital simulado. Acá se calcula el balance simulado en vivo,
    // en cada señal, a partir del P&L acumulado del tracker.
    const balanceForSizing = config.DRY_RUN
      ? parseFloat(process.env.PAPER_CAPITAL || '25') +
        (parseFloat((tracker.getSummary().totalPnL ?? '0').replace('+', '').replace('$', '')) || 0)
      : currentBalance;

    if (!config.DRY_RUN && balanceForSizing === null) {
      logger.warn('[SIZE] ⚠️ currentBalance es null — DYNAMIC_SIZE_SCALE no puede aplicar, usando ORDER_SIZE_USDC fijo (revisar getBalance/auth)');
    }

    const exposure = getDynamicOrderSize(balanceForSizing, config.ORDER_SIZE_USDC);
    if (process.env.DYNAMIC_SIZE_SCALE && exposure !== config.ORDER_SIZE_USDC) {
      logger.info(`[SIZE] 📊 Balance $${balanceForSizing} → order size dinámico: $${exposure}`);
    }

    const totalExposure = Array.from(activePositions.values())
      .reduce((sum, p) => sum + p.exposure, 0);
    // Fix: antes usaba "exposure * 2" fijo sin importar MAX_ACTIVE_POSITIONS,
    // lo que en la práctica seguía topeando a 2 posiciones de capital aunque
    // maxSlots estuviera en 3+ — nunca se llegaba a usar el slot extra.
    const maxExposure = Math.min(config.MAX_TOTAL_EXPOSURE_USDC, exposure * maxSlots);
    if (totalExposure + exposure > maxExposure) return;

    if (!cachedMarket?.gammaId) {
      logger.warn('[SKIP] No hay mercado disponible');
      return;
    }

    const marketEnd = new Date(cachedMarket.endDate).getTime();
    const msRestantes = marketEnd - now;
    const segsRestantes = Math.floor(msRestantes / 1000);

    if (msRestantes <= 0) {
      logger.warn(`[SKIP] ⏱️ Mercado YA CERRADO hace ${Math.abs(segsRestantes)}s`);
      cachedMarket = null;
      return;
    }

    const MIN_SECS = parseInt(process.env.MIN_SECONDS_REMAINING || '60');
    if (segsRestantes < MIN_SECS) {
      logger.warn(`[SKIP] ⏱️ Solo ${segsRestantes}s restantes — muy tarde (mín ${MIN_SECS}s)`);
      return;
    }

    // ─── Modo entrada tardía con confirmación (LATE_ENTRY_MODE) ────────
    // Estrategia alternativa: en vez de anticiparse (latency arb clásico),
    // esperar a que la dirección ya esté confirmada dentro del período
    // y el precio del token ya refleje esa convicción (no cerca de 50/50).
    //
    // Con DUAL_ENTRY_MODE=true, este filtro SOLO aplica a la segunda entrada
    // del mismo mercado (global.__pendingEntryType === 'late'). La primera
    // entrada usa la lógica normal (temprana) sin esperar confirmación.
    const lateEntryMode = process.env.LATE_ENTRY_MODE === 'true';
    const dualEntryModeActive = process.env.DUAL_ENTRY_MODE === 'true';
    const isSecondEntry = global.__pendingEntryType === 'late';
    const applyLateEntryFilter = lateEntryMode && (!dualEntryModeActive || isSecondEntry);

    let entryType = 'early';
    if (applyLateEntryFilter) {
      const maxSecs = parseInt(process.env.MAX_SECONDS_REMAINING || '150');
      if (segsRestantes > maxSecs) {
        logger.info(`[SKIP] 🕐 LATE_ENTRY: ${segsRestantes}s restantes — muy pronto (máx ${maxSecs}s), esperando confirmación`);
        global.__pendingEntryType = null;
        return;
      }
      // Precio del token en la dirección elegida debe reflejar convicción
      const tokenPrice = sig.direction === 'UP' ? sig.edge.polyYes : sig.edge.polyNo;
      const minConviction = parseFloat(process.env.LATE_ENTRY_MAX_PRICE || '0.30');
      if (tokenPrice > minConviction) {
        logger.info(`[SKIP] 🕐 LATE_ENTRY: precio $${tokenPrice.toFixed(3)} > $${minConviction} — sin convicción suficiente todavía`);
        global.__pendingEntryType = null;
        return;
      }
      logger.info(`[LATE_ENTRY] ✅ Confirmado: ${segsRestantes}s restantes, precio $${tokenPrice.toFixed(3)} — alta convicción`);
      entryType = 'late';
    }
    global.__pendingEntryType = null; // reset — se usa una sola vez por evaluación

    // Fix (causa raíz de las "entradas duplicadas"): con DUAL_ENTRY_MODE=true
    // y LATE_ENTRY_MODE=false, la segunda entrada del mismo mercado quedaba
    // marcada como candidata 'late' pero la validación de late-entry (que
    // vive en el bloque de LATE_ENTRY_MODE) nunca corría — así que pasaba
    // directo como una entrada normal más, generando 2 posiciones casi
    // simultáneas en el mismo mercado. La regla real es: la segunda entrada
    // SOLO es válida si fue confirmada como 'late'; si no, se bloquea.
    if (isSecondEntry && entryType !== 'late') {
      logger.warn(`[SKIP] Segunda entrada en el mismo mercado sin confirmación LATE_ENTRY — bloqueando (DUAL_ENTRY requiere LATE_ENTRY_MODE para la 2da entrada)`);
      return;
    }

    // Fix: reservar el slot ACÁ, apenas se confirma que no hay otra entrada
    // en este mercado y hay slot libre — antes esto se reservaba recién al
    // final del bloque (abajo del todo), dejando una ventana de milisegundos
    // donde dos señales casi simultáneas podían pasar los mismos chequeos
    // y terminar abriendo 2 posiciones en el mismo mercado (visto en logs
    // del 24/07: entradas duplicadas con 2-54ms de diferencia).
    lastTradeTime = now;
    const posId = `POS_${Date.now()}`;
    activePositions.set(posId, {
      exposure: 0, openTime: now,
      marketId: marketKey,
      entryType,
    });

    logger.info(`[TIMING] ✅ ${segsRestantes}s restantes — OK para entrar (tipo: ${entryType})`);
    logger.info(`  [IND] Imbalance:${sig.imbalance?.toFixed(2)} Spread:${sig.spreadRatio?.toFixed(2)}x Ticks/10s:${sig.tickFreq} RSI:${sig.rsi?.toFixed(1)} Score:${sig.signalScore}`);

    const side = sig.direction === 'UP' ? 'BUY' : 'SELL';
    const priceRaw = sig.direction === 'UP' ? sig.edge.polyYes : sig.edge.polyNo;
    const tokenId = sig.direction === 'UP' ? cachedMarket.yesTokenId : cachedMarket.noTokenId;

    // PRICE_TOLERANCE: acepta fills hasta N ticks arriba del precio detectado
    // Cubre el movimiento de precio entre detección y ejecución (HTTP polling 0-2s)
    // Default 0.02 = 2 ticks — sube fill rate de ~74% a ~90% con mínimo impacto en edge
    const priceTolerance = parseFloat(process.env.PRICE_TOLERANCE || '0.02');

    // EDGE_BOOST: cuando el edge calculado supera un umbral, arrancar el primer
    // intento con 1-2 ticks adicionales de agresividad. La lógica: una señal
    // con edge ≥ 2% tiene tanta convicción que vale sacrificar un centavo más
    // para asegurar el fill en vez de perder la oportunidad por falta de liquidez.
    // Basado en evidencia: los fills que tardan >90s pierden sistemáticamente
    // (04/08) — arrancar más agresivo en señales fuertes evita esos llenados tardíos.
    //   EDGE_BOOST_THRESHOLD=2.0   → edge en % desde donde se activa
    //   EDGE_BOOST_TICKS=0.01      → cuánto extra se suma al precio (1 tick = $0.01)
    const edgeBoostThreshold = parseFloat(process.env.EDGE_BOOST_THRESHOLD || '0');
    const edgeBoostTicks = parseFloat(process.env.EDGE_BOOST_TICKS || '0.01');
    const edgePct = sig.edge?.edgePct || 0;
    const edgeBoost = (edgeBoostThreshold > 0 && edgePct >= edgeBoostThreshold) ? edgeBoostTicks : 0;
    if (edgeBoost > 0) logger.info(`[PRICE] Edge ${edgePct.toFixed(2)}% ≥ ${edgeBoostThreshold}% → boost de +$${edgeBoost} al precio inicial`);

    const price = Math.min(0.97, parseFloat((priceRaw + priceTolerance + edgeBoost).toFixed(3)));
    const size = Math.floor(exposure / price);

    logger.info(`[PRICE] Raw: $${priceRaw.toFixed(3)} + tolerance: $${priceTolerance}${edgeBoost > 0 ? ` + boost: $${edgeBoost}` : ''} → orden: $${price.toFixed(3)}`);

    // Fix 1: size check ANTES del Discord alert — no alertar órdenes que no van a ejecutarse
    if (size < 5) {
      logger.warn(`[SKIP] Size ${size} < mínimo 5 tokens de Polymarket (ORDER_SIZE_USDC=$${exposure} muy bajo)`);
      activePositions.delete(posId); // liberar la reserva — esta entrada no va a ejecutarse
      return;
    }

    // Fire-and-forget — no bloquea la ejecución de la orden
    alertTradeSignal({
      direction: sig.direction,
      price,
      edge: sig.edge.edgePct,
      move: sig.movePct,
      zscore: sig.zScore,
      segsRestantes,
      market: cachedMarket,
      size,
      exposure,
    }).catch(e => logger.warn(`Discord alert failed: ${e.message}`));

    logger.info(`[OPEN] ${sig.direction} @ $${price.toFixed(3)} | Edge: ${sig.edge.edgePct.toFixed(2)}% | Move: ${sig.movePct.toFixed(3)}%`);
    logger.info(`  Exposure: $${exposure} | Size: ${size} | Token: ${tokenId}`);

    // Completar la reserva con el exposure real (ya sabíamos marketId/entryType desde antes)
    activePositions.set(posId, {
      exposure, openTime: now,
      marketId: marketKey,
      entryType,  // 'early' o 'late' — usado por el gate de DUAL_ENTRY_MODE
    });

    // Registrar señal en volumen persistente
    const utcHour = new Date().getUTCHours();
    const btcPriceAtSignal = sig.currentPrice;
    signalLogger.logSignalOpen({
      posId,
      direction: sig.direction,
      price,
      size,
      market: cachedMarket,
      sig,
      utcHour,
      btcPrice: btcPriceAtSignal,
      // getPolyPrice: lee el precio ACTUAL del WS en tiempo real para que
      // los snapshots t0/t1/t2/t5 reflejen el movimiento real de Polymarket
      // post-entrada. Antes leía sig.edge?.polyYes que era el precio al
      // momento de la señal y nunca cambiaba — todos los snapshots eran iguales.
      // Con livePolyYes/No actualizados por el WS en cada tick, ahora t5 puede
      // mostrar el precio real 5 segundos después de entrar.
      getPolyPrice: (dir) => {
        // Preferir precio del WS (tiempo real); fallback al precio de la señal
        const wsPrice = dir === 'UP' ? livePolyYes : livePolyNo;
        if (wsPrice !== null) return wsPrice;
        return dir === 'UP' ? sig.edge?.polyYes : sig.edge?.polyNo;
      },
    });

    // BTC snapshot 30s después
    setTimeout(() => {
      signalLogger.logBtcSnapshot30s(posId, btcPriceAtSignal, signal.getStats()?.lastPrice);
    }, 30000);

    // ✅ Ejecutar orden real (solo en LIVE)
    if (!config.DRY_RUN) {
      try {
        const orderResult = await poly.placeLimitOrder({
          marketId: cachedMarket.conditionId,
          tokenId,
          side: 'BUY',
          price,
          size,
          marketQuestion: cachedMarket.question,
          marketEndTs: new Date(cachedMarket.endDate).getTime(), // para el presupuesto de FILL_RETRY
        });

        // Fix 2: GTC — verificar fill antes de abrir posición en tracker
        if (!orderResult.success) {
          const reason = orderResult.error === 'gtc_timeout'
            ? `timeout ${config.GTC_TIMEOUT_SECONDS || 60}s sin fill`
            : (orderResult.error || 'sin liquidez');
          logger.warn(`[LIVE] ⚠️ Orden no llenada — ${reason}`);
          // Marcar señal como NO ejecutada en signal logger
          signalLogger.logSignalClose(posId, 'NO_FILL', 0);
          activePositions.delete(posId);
          return;
        }

        const fillMs = orderResult.fillTimeMs || null;
        // FIX: usar el tamaño REALMENTE llenado, no el pedido — un fill
        // parcial (ej. 3 de 5 tokens) ya no se registra como si hubiera
        // llenado completo.
        const actualSize = orderResult.sizeFilled || size;
        // FIX: usar el precio REAL al que llenó, no el precio original
        // cotizado. Si el retry-loop tuvo que mejorar precio (ej. de $0.135
        // a $0.155 en varios intentos), el costo real es más alto que el
        // primer precio pedido — sin esto, el PnL registrado queda
        // sistemáticamente más optimista que el gasto real de la wallet.
        const actualPrice = orderResult.fillPrice || price;
        if (actualPrice !== price) {
          logger.warn(`[LIVE] 💲 Precio real de fill ($${actualPrice.toFixed(3)}) distinto al cotizado ($${price.toFixed(3)}) — usando el real para el tracker`);
        }
        if (orderResult.partial) {
          logger.warn(`[LIVE] 🔶 Fill PARCIAL: ${actualSize}/${size} tokens — abriendo posición por el tamaño real, no el pedido`);
        }
        logger.info(`[LIVE] ✅ Orden llenada (GTC): ${orderResult.orderId} | fill_time: ${fillMs ? fillMs+'ms' : 'instantáneo'} | size: ${actualSize}/${size} | price: $${actualPrice.toFixed(3)}`);

        // Guardar fill_time_ms en signal logger
        if (fillMs !== null) signalLogger.updateFillTime(posId, fillMs);

        // Fix 2: tracker solo se abre DESPUÉS de fill confirmado
        tracker.openPosition({
          marketId: cachedMarket.conditionId,
          gammaId: cachedMarket.gammaId,
          marketQuestion: cachedMarket.question,
          side,
          price: actualPrice,
          size: actualSize,
          endDate: cachedMarket.endDate,
          posId,
          tokenId,    // necesario para el position monitor
          mode: 'live',
          entryType,
        });

        setTimeout(() => activePositions.delete(posId), 8 * 60 * 1000);

      } catch (err) {
        logger.error(`[LIVE] ❌ Error: ${err.message}`);
        signalLogger.logSignalClose(posId, 'NO_FILL', 0);
        activePositions.delete(posId);
        return;
      }

    } else {
      // PAPER: simular fill rate realista (GTC no siempre llena)
      const paperFillRate = parseFloat(process.env.PAPER_FILL_RATE || '0.75');
      const filled = Math.random() < paperFillRate;

      if (!filled) {
        logger.warn(`[PAPER] ⚠️ Simulando GTC sin fill (fill rate ${(paperFillRate*100).toFixed(0)}%)`);
        signalLogger.logSignalClose(posId, 'NO_FILL', 0);
        activePositions.delete(posId);
        return;
      }

      tracker.openPosition({
        marketId: cachedMarket.conditionId,
        gammaId: cachedMarket.gammaId,
        marketQuestion: cachedMarket.question,
        side,
        price,
        size,
        endDate: cachedMarket.endDate,
        posId,
        mode: 'paper',
        entryType,  // 'early' o 'late' — para DUAL_ENTRY_MODE
      });

      setTimeout(() => activePositions.delete(posId), 8 * 60 * 1000);
    }
  });

  ws.onError((err) => logger.error(`WS error: ${err.message}`));

  logger.info('Conectando a Coinbase WebSocket...');
  await ws.connect();
  logger.info('✓ Conectado\n');

  // Balance inicial al arrancar
  let initialBalance = null;
  let currentBalance = null;

  poly.getBalance().then(b => {
    if (b !== null) {
      initialBalance = b;
      currentBalance = b;
      logger.info(`💰 Balance inicial Polymarket: $${b} USDC`);
    }
  }).catch(() => {});

  setInterval(async () => {
    const stats = tracker.getSummary();
    const sigStats = signal.getStats();

    // Actualizar balance real cada 5 minutos
    if (!config.DRY_RUN) {
      const bal = await poly.getBalance().catch((e) => {
        logger.warn(`[BALANCE] ⚠️ getBalance() falló: ${e?.message || e}`);
        return null;
      });
      if (bal !== null) {
        currentBalance = bal;
      } else {
        logger.warn(`[BALANCE] ⚠️ getBalance() devolvió null — currentBalance sigue en ${currentBalance ?? 'null'}`);
      }
    }

    const pnlReal = (currentBalance !== null && initialBalance !== null)
      ? (currentBalance - initialBalance).toFixed(2)
      : 'n/a';
    const pnlSign = parseFloat(pnlReal) >= 0 ? '+' : '';

    // Mostrar stats del volumen si hay datos
    const volStats = signalLogger.getStats();
    if (volStats && volStats.closedTrades >= 5) {
      logger.info(`  📊 Stats volumen: ${volStats.closedTrades} trades | WR: ${volStats.winRate} | P&L: $${volStats.totalPnL}`);
    }
    logger.info('─'.repeat(60));
    logger.info('[HEALTH]');
    logger.info(`  Señales: ${sigStats.signals} | BTC: $${sigStats.lastPrice?.toFixed(2) ?? 'n/a'}`);
    logger.info(`  Poly YES: ${sigStats.polyYes ?? 'n/a'} | Poly age: ${sigStats.polyAge}`);
    logger.info(`  Active slots: ${activePositions.size}/10`);
    logger.info(`  Cooldown: ${Math.max(0, Math.ceil((lastTradeTime + COOLDOWN - Date.now()) / 1000))}s`);
    logger.info('');
    logger.info('=== BALANCE REAL ===');
    if (config.DRY_RUN) {
      const s = tracker.getSummary();
      const paperPnL = parseFloat((s.totalPnL ?? '0').replace('+','').replace('$','')) || 0;
      const paperBalance = (parseFloat(process.env.PAPER_CAPITAL || '25') + paperPnL).toFixed(2);
      const sign = paperPnL >= 0 ? '+' : '';
      logger.info(`  📋 PAPER TRADING (capital inicial: $${process.env.PAPER_CAPITAL || '25'})`);
      logger.info(`  💰 Balance simulado: $${paperBalance} USDC`);
      logger.info(`  📈 P&L simulado: ${sign}$${paperPnL.toFixed(2)}`);
      logger.info(`  Trades W:${s.wins} L:${s.losses} | Win Rate: ${s.winRate}`);
    } else {
      logger.info(`  💰 Balance: $${currentBalance ?? 'consultando...'} USDC`);
      logger.info(`  📈 P&L sesión: ${pnlSign}$${pnlReal}`);
      logger.info(`  Trades W:${stats.wins} L:${stats.losses} | Win Rate: ${stats.winRate}`);
    }
    logger.info('─'.repeat(60));
  }, 5 * 60 * 1000);
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
