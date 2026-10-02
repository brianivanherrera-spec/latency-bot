'use strict';
// Pruebas de los arreglos de la revisión del 02/10 (G1, G2, G6, G7, G10). G4 está en t-trading.js.
const assert = require('./assert');
const os = require('os'), fs = require('fs'), path = require('path');
const base = require('../src/config');
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const { Ledger } = require('../src/ledger');
const { Resolver } = require('../src/resolver');
const { WsClient } = require('../src/feeds/ws-client');
const WebSocket = require('ws');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v2rev-'));

(async () => {
  // ── G1: estado del ledger ────────────────────────────────────────────────
  {
    const dir = tmp(), cfg = { ...base, DATA_DIR: dir };
    const l1 = new Ledger({ cfg, log: quiet });
    assert.eq(l1.cash, cfg.PAPER_BANKROLL, 'G1: sin archivo (ENOENT) = primer arranque con la banca inicial');
    l1.cash = 87.5;
    for (let i = 0; i < 50; i++) l1.save(); // antes: saves asíncronos pisándose en el mismo .tmp
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'v2-state.json'), 'utf8'));
    assert.eq(st.cash, 87.5, 'G1: save sincrónico deja el estado completo y legible');
    assert.ok(!fs.existsSync(path.join(dir, 'v2-state.json.tmp')), 'G1: no queda el .tmp');
    const l2 = new Ledger({ cfg, log: quiet });
    assert.eq(l2.cash, 87.5, 'G1: al arrancar recupera la banca guardada');

    fs.writeFileSync(path.join(dir, 'v2-state.json'), '{"cash": 87.5, "positions": {'); // truncado
    let threw = null;
    const errs = [];
    try { new Ledger({ cfg, log: { ...quiet, error: (m) => errs.push(m) } }); } catch (e) { threw = e; }
    assert.ok(threw && /corrupto/.test(threw.message), 'G1: estado corrupto → aborta (antes reseteaba a $100 sin aviso)');
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('v2-state.json.corrupt-')), 'G1: guarda una copia .corrupt');
    assert.ok(errs.length === 1, 'G1: lo loguea como error');
  }

  // ── G7: polvo de acciones ────────────────────────────────────────────────
  {
    const cfg = { ...base, DATA_DIR: tmp() };
    const l = new Ledger({ cfg, log: quiet });
    const mk = { gammaId: 'P', label: 'P', startMs: 0, endMs: 300000 };
    l.recordBuy(mk, 'UP', { shares: 10, avgPrice: 0.6, cost: 6, fee: 0.17 }, {});
    l.recordSell(mk, 'UP', { shares: 10 - 1e-12, avgPrice: 0.7, proceeds: 7, fee: 0.15 }, {});
    const s = l.positions.P.UP;
    assert.ok(s.shares === 0 && s.cost === 0 && s.fees === 0, `G7: resto < 1e-6 queda en 0 (quedó ${s.shares})`);
  }

  // ── G6: sin Gamma ni TWAP no se da por final, se sigue consultando con backoff ──
  {
    const cfg = { ...base, DATA_DIR: tmp(), RESOLVE_TIMEOUT_MS: 0, RESOLVE_POLL_MS: 1000, RESOLVE_MAX_POLL_MS: 8000 };
    const ledger = new Ledger({ cfg, log: quiet });
    const mk = { gammaId: 'G', label: 'G', startMs: 0, endMs: 300000, K: 100, feeRate: 0.07 };
    ledger.recordBuy(mk, 'UP', { shares: 5, avgPrice: 0.5, cost: 2.5, fee: 0.0875 }, {});
    const delays = []; const queue = [];
    const setT = (fn, ms) => { delays.push(ms); queue.push(fn); };
    let calls = 0;
    const fetchJson = async () => { calls++; if (calls < 6) throw new Error('caído'); return { closed: true, outcomes: '["Up","Down"]', outcomePrices: '["1","0"]' }; };
    const r = new Resolver({ cfg, log: quiet, ledger, pricer: { strike: () => 100, clSpot: { average: () => 99.9 } }, clTwap: { at: () => null }, fetchJson, setTimeoutFn: setT });
    r.onClose(mk);
    while (queue.length) await queue.shift()();
    assert.eq(calls, 6, 'G6: siguió consultando Gamma hasta que respondió');
    assert.ok(ledger.positions.G === undefined, 'G6: la posición se liquidó con el resultado oficial');
    const backoff = delays.slice(1);
    assert.ok(backoff.every((d, i) => i === 0 || d >= backoff[i - 1]) && Math.max(...backoff) <= 8000, `G6: backoff creciente con tope (${backoff.join(', ')})`);
    assert.eq(r.stats.fallback, 0, 'G6: no cerró como "desconocido"');
    await new Promise(res => setTimeout(res, 50));
    const line = JSON.parse(fs.readFileSync(ledger.marketsFile, 'utf8').trim().split('\n').pop());
    assert.ok(line.winner === 'UP' && 'twapClose' in line && line.ownAvgClose === 99.9, 'G11: markets.jsonl registra TWAP de cierre y promedio propio');
  }

  // ── G3: al cambiar Binance ↔ Coinbase la base se recalibra desde cero ────
  {
    const { BtcFeed } = require('../src/feeds/binance');
    const { Pricer } = require('../src/pricer');
    const btc = new BtcFeed({ cfg: base, log: quiet });
    const clSpot = {}; const pricer = new Pricer({ cfg: base, btc, clSpot, clTwap: {} });
    pricer.basis = 17.2; pricer.basisN = 40;
    btc._setSource('binance'); // misma fuente: no toca nada
    assert.ok(pricer.basis === 17.2 && pricer.basisN === 40, 'G3: misma fuente no resetea');
    btc._setSource('coinbase');
    assert.ok(pricer.basis === null && pricer.basisN === 0, 'G3: Binance → Coinbase resetea la base');
    pricer.basis = 0.4; pricer.basisN = 12;
    btc._setSource('binance');
    assert.ok(pricer.basis === null && pricer.basisN === 0, 'G3: Coinbase → Binance resetea la base');
  }

  // ── G10: un mercado se resuelve una sola vez ─────────────────────────────
  {
    const cfg = { ...base, DATA_DIR: tmp() };
    const r = new Resolver({ cfg, log: quiet, ledger: new Ledger({ cfg, log: quiet }), pricer: {}, clTwap: {}, fetchJson: async () => ({}), setTimeoutFn: () => {} });
    const mk = { gammaId: 'D1', label: 'D1' };
    assert.ok(r.onClose(mk) === true && r.onClose({ ...mk }) === false, 'G10: segundo onClose del mismo gammaId se ignora');
  }

  // ── G2: socket mudo → terminate y reconexión; el PONG no cuenta como dato ──
  {
    const srv = new WebSocket.Server({ port: 0 });
    await new Promise(res => srv.on('listening', res));
    let conns = 0;
    srv.on('connection', (c) => { conns++; c.on('message', m => { if (String(m) === 'PING') c.send('PONG'); }); });
    const cl = new WsClient({ url: `ws://127.0.0.1:${srv.address().port}`, name: 'T', log: quiet, pingText: 'PING', pingMs: 200, dataTimeoutMs: 1000, maxDelay: 200 }).start();
    await new Promise(res => setTimeout(res, 2600));
    assert.ok(conns >= 2, `G2: con solo PONG durante > 1 s se reconecta (${conns} conexiones)`);
    cl.stop(); srv.close();
  }
})();
