'use strict';
// Punta a punta con sockets reales: servidores locales que imitan Binance, el RTDS (Chainlink spot y
// TWAP 60 s), el WebSocket de Polymarket y Gamma. El bot v2 corre como proceso aparte contra ellos.
const assert = require('./assert');
const http = require('http'), { spawn } = require('child_process'), WebSocket = require('ws');
const os = require('os'), fs = require('fs'), path = require('path');

const now0 = Date.now(), W = 300000, start = now0 - (now0 % W), end = start + W;
const K = 84000;                          // precio a superar (TWAP publicado en la apertura)
const CL = () => K + 30;                  // Chainlink $30 arriba → P(UP) alta
const BN = () => CL() + 15;               // Binance = Chainlink + base de $15
const servers = [];
const wss = (port, onConn) => { const s = new WebSocket.Server({ port }); s.on('connection', onConn); servers.push(s); return s; };

// Binance aggTrade: 20 ticks/s con ruido chico
wss(19101, (c) => {
  let i = 0;
  const t = setInterval(() => c.readyState === 1 && c.send(JSON.stringify({ e: 'aggTrade', p: String(BN() + Math.sin(i++ / 7) * 2), q: '0.01', T: Date.now(), m: false })), 50);
  c.on('close', () => clearInterval(t));
});
// RTDS: responde según el tópico suscripto (snapshot con historia + 1 punto por segundo)
wss(19102, (c) => {
  let timer;
  c.on('message', (d) => {
    const s = d.toString(); if (s === 'PING') return c.send('PONG');
    const topic = JSON.parse(s).subscriptions[0].topic;
    const val = topic === 'crypto_prices_twap_sixty' ? () => K : () => CL();
    const data = [];
    for (let t = start - 60000; t <= Date.now() - 1500; t += 1000) data.push({ timestamp: t - (t % 1000), value: topic === 'crypto_prices_twap_sixty' && t - (t % 1000) === start ? K : val() });
    c.send(JSON.stringify({ topic, type: 'subscribe', payload: { symbol: 'btc/usd', data } }));
    timer = setInterval(() => c.send(JSON.stringify({ payload: { symbol: 'btc/usd', timestamp: Date.now() - 1450, value: val() } })), 1000);
  });
  c.on('close', () => clearInterval(timer));
});
// Polymarket market WS: snapshot al handshake y deltas periódicos
wss(19103, (c) => {
  let timer;
  c.on('message', (d) => {
    const s = d.toString(); if (s === 'PING') return c.send('PONG');
    const m = JSON.parse(s);
    if (m.type !== 'market') return c.send('INVALID OPERATION');
    c.send(JSON.stringify([
      { event_type: 'book', asset_id: 'TOK_UP', bids: [{ price: '0.58', size: '200' }], asks: [{ price: '0.60', size: '50' }, { price: '0.62', size: '200' }] },
      { event_type: 'book', asset_id: 'TOK_DN', bids: [{ price: '0.38', size: '200' }], asks: [{ price: '0.42', size: '200' }] },
    ]));
    timer = setInterval(() => c.send(JSON.stringify({ event_type: 'price_change', price_changes: [{ asset_id: 'TOK_DN', price: '0.30', size: String(10 + Math.floor(Math.random() * 5)), side: 'BUY', best_bid: '0.38', best_ask: '0.42' }] })), 500);
  });
  c.on('close', () => clearInterval(timer));
});
// Gamma
const gamma = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url.startsWith('/events')) {
    const slugTs = Number(req.url.split('btc-updown-5m-')[1]);
    res.end(JSON.stringify([{ title: `Bitcoin Up or Down test ${slugTs}`, markets: [{ id: `G${slugTs}`, conditionId: '0xabc', clobTokenIds: JSON.stringify(['TOK_UP', 'TOK_DN']), outcomes: JSON.stringify(['Up', 'Down']), orderPriceMinTickSize: 0.01, orderMinSize: 5, feesEnabled: true, feeType: 'crypto' }] }]));
  } else res.end(JSON.stringify({ closed: false, outcomePrices: '["0.5","0.5"]', outcomes: '["Up","Down"]' }));
}).listen(19104);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2e2e-'));
const env = { ...process.env, PORT: '19105', DATA_DIR: dataDir, DOWNLOAD_SECRET: 'k', BINANCE_WS_URL: 'ws://127.0.0.1:19101', V2_RTDS_WS: 'ws://127.0.0.1:19102', V2_POLY_WS: 'ws://127.0.0.1:19103', V2_GAMMA: 'http://127.0.0.1:19104', V2_VOL_MIN_HISTORY_S: '12', V2_MAX_SECS_LEFT: '299' };
const bot = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js')], { env });
let out = '';
bot.stdout.on('data', d => { out += d; }); bot.stderr.on('data', d => { out += d; });
const get = (p) => new Promise(r => http.get({ host: '127.0.0.1', port: 19105, path: p }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r([res.statusCode, b])); }).on('error', e => r(['ERR', e.message])));

setTimeout(async () => {
  const secsLeft = (end - Date.now()) / 1000;
  const [sc, body] = await get('/status?key=k');
  const st = sc === 200 ? JSON.parse(body) : {};
  assert.eq(sc, 200, '/status responde');
  assert.eq((await get('/status?key=mal'))[0], 401, 'clave incorrecta → 401');
  assert.ok(/Binance aggTrade conectado/.test(out) && /Chainlink spot suscripto/.test(out) && /TWAP60 suscripto/.test(out), 'conectó Binance, Chainlink spot y TWAP 60 s');
  assert.ok(/Libro abierto para/.test(out), 'encontró el mercado en Gamma y abrió su libro');
  assert.eq(st.market?.K, K, 'precio a superar = TWAP publicado en la apertura');
  assert.near(st.feeds?.basis, -15, 1.5, `base Chainlink − Binance ≈ −$15 (${st.feeds?.basis?.toFixed(2)})`);
  const f = st.market?.fair || {};
  if (secsLeft > 70) {
    assert.ok(f.pUp > 0.6, `P(UP) alta con Chainlink $30 arriba (${f.pUp?.toFixed(3) ?? f.reason}, faltan ${secsLeft.toFixed(0)}s)`);
    assert.ok(/\[FILL\] BUY UP/.test(out), 'compró UP en paper contra el libro');
    assert.ok(!/\[FILL\] BUY DOWN/.test(out), 'no compró DOWN');
    const fills = fs.existsSync(path.join(dataDir, 'v2-fills.jsonl')) ? fs.readFileSync(path.join(dataDir, 'v2-fills.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
    assert.ok(fills.length > 0 && fills.every(x => x.fee > 0 && x.avgPrice <= 0.62), `fills con comisión y precio ≤ límite (${fills.map(x => `${x.shares}@${x.avgPrice}`).join(', ')})`);
  } else console.log(`  (quedan ${secsLeft.toFixed(0)} s del mercado: se saltean los chequeos de compra)`);
  const [rc, rep] = await get('/report?key=k');
  assert.ok(rc === 200 && /REPORTE/.test(rep), '/report responde');
  assert.ok(!/TypeError|ReferenceError|is not defined/.test(out), 'sin errores de programación en el log');
  if (process.exitCode) console.log(out.split('\n').slice(-40).join('\n'));
  bot.kill(); servers.forEach(s => s.close()); gamma.close();
  setTimeout(() => process.exit(), 200);
}, 22000);
