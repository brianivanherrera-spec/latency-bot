'use strict';
// Bot v2 — paper trading en Polymarket BTC Up/Down 5m. Nada de este proceso envía órdenes reales.
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { make } = require('./log');
const { BtcFeed } = require('./feeds/binance');
const { ChainlinkSeries } = require('./feeds/chainlink');
const { MarketScheduler } = require('./markets');
const { Pricer } = require('./pricer');
const { Ledger } = require('./ledger');
const { PaperExecutor } = require('./paper');
const { Strategy } = require('./strategy');
const { Resolver } = require('./resolver');
const { report } = require('./report');

const log = make('MAIN');
const fetchJson = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(cfg.FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

function build(deps = {}) {
  const btc = deps.btc || new BtcFeed({ cfg, log: make('BTC') });
  const clSpot = deps.clSpot || new ChainlinkSeries({ cfg, log: make('CL'), topic: 'crypto_prices_chainlink', name: 'Chainlink spot' });
  const clTwap = deps.clTwap || new ChainlinkSeries({ cfg, log: make('CL'), topic: 'crypto_prices_twap_sixty', name: 'Chainlink TWAP60' });
  const pricer = new Pricer({ cfg, btc, clSpot, clTwap });
  const ledger = new Ledger({ cfg, log: make('LEDGER') });
  const executor = new PaperExecutor({ cfg, log: make('PAPER'), ledger, setTimeoutFn: deps.setTimeoutFn });
  const strategy = new Strategy({ cfg, log: make('STRAT'), pricer, ledger, executor });
  const resolver = new Resolver({ cfg, log: make('RESOLVE'), ledger, pricer, clTwap, fetchJson: deps.fetchJson || fetchJson, setTimeoutFn: deps.setTimeoutFn });
  const scheduler = new MarketScheduler({
    cfg, log: make('MKT'), fetchJson: deps.fetchJson || fetchJson,
    onOpen: (mk) => log.info(`Libro abierto para ${mk.label} (UP/DOWN) — comisión ${mk.feeRate}`),
    onClose: (mk) => resolver.onClose(mk),
  });
  return { btc, clSpot, clTwap, pricer, ledger, executor, strategy, resolver, scheduler };
}

function main() {
  const app = build();
  log.info(`Bot v2 (PAPER) — banca $${cfg.PAPER_BANKROLL}, ventaja mínima ${(cfg.EDGE_MIN * 100).toFixed(1)}¢ por acción después de comisión, ¼ Kelly, σ×${cfg.VOL_MULT}`);
  app.btc.start(); app.clSpot.start(); app.clTwap.start(); app.scheduler.start();

  // Posiciones que quedaron abiertas de antes de un reinicio: resolverlas igual
  for (const [gammaId, p] of Object.entries(app.ledger.positions)) {
    const mk = { gammaId, label: p.label, startMs: p.startMs, endMs: p.startMs + cfg.WINDOW_MS };
    log.info(`Posición pendiente de ${p.label}: se resuelve al volver Gamma`);
    app.resolver.onClose(mk); // si el scheduler cierra el mismo mercado después, onClose lo ignora
  }

  setInterval(() => {
    const mk = app.scheduler.current();
    if (mk && mk.state === 'live') { try { app.strategy.evaluate(mk); } catch (e) { log.warn(`evaluate: ${e.message}`); } }
  }, cfg.EVAL_INTERVAL_MS);

  // Estado cada 5 min
  setInterval(() => {
    const f = app.scheduler.current() ? app.pricer.fair(app.scheduler.current()) : {};
    log.info(`[ESTADO] banca $${app.ledger.cash.toFixed(2)} | expuesto $${app.ledger.exposure().toFixed(2)} | día ${app.ledger.day.pnl >= 0 ? '+' : ''}$${app.ledger.day.pnl.toFixed(2)} | base CL−BN ${app.pricer.basis?.toFixed(2)} | σ ${app.btc.sigma()?.toExponential(2)} | P(UP) ahora ${f.pUp?.toFixed(3) ?? f.reason} | skips ${JSON.stringify(app.strategy.skips)}`);
    app.strategy.skips = {};
  }, 300000);

  const file = n => path.join(cfg.DATA_DIR, n);
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
    if (url.searchParams.get('key') !== cfg.SECRET) { res.writeHead(401); res.end('Unauthorized'); return; }
    if (url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const mk = app.scheduler.current();
      res.end(JSON.stringify({
        mode: 'paper', cash: app.ledger.cash, exposure: app.ledger.exposure(), day: app.ledger.day, totals: app.ledger.totals,
        market: mk ? { label: mk.label, K: mk.K, Ksrc: mk.Ksrc, fair: app.pricer.fair(mk), up: mk.book?.best('UP'), down: mk.book?.best('DOWN') } : null,
        feeds: { binance: app.btc.last, chainlink: app.clSpot.last(), basis: app.pricer.basis }, resolver: app.resolver.stats, skips: app.strategy.skips,
      }, null, 2));
      return;
    }
    if (url.pathname === '/report') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      const s = url.searchParams.get('since');
      res.end(report(cfg.DATA_DIR, s ? Date.parse(s) : 0, cfg.PAPER_BANKROLL));
      return;
    }
    const files = { '/fills': 'v2-fills.jsonl', '/markets': 'v2-markets.jsonl', '/evals': 'v2-evals.jsonl' };
    if (files[url.pathname]) {
      const f = file(files[url.pathname]);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('sin datos todavía'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename=${files[url.pathname]}` });
      fs.createReadStream(f).pipe(res);
      return;
    }
    res.writeHead(404); res.end('no encontrado');
  }).listen(cfg.PORT, () => log.info(`HTTP en puerto ${cfg.PORT}: /health /status /report /fills /markets /evals (?key=)`));
}

if (require.main === module) main();
module.exports = { build };
