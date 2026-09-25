'use strict';
const assert = require('./assert');
const os = require('os'), fs = require('fs'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2r-'));
const base = require('../src/config');
const cfg = { ...base, DATA_DIR: dir, RESOLVE_TIMEOUT_MS: 50, RESOLVE_POLL_MS: 1 };
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const { Ledger } = require('../src/ledger');
const { Resolver } = require('../src/resolver');

const queue = []; const setT = (fn) => queue.push(fn);
const run = async () => { while (queue.length) await queue.shift()(); };

(async () => {
  // 1) Gamma oficial: closed + precio ≥ 0.99, outcomes en orden Down/Up (no asumir el orden)
  {
    const ledger = new Ledger({ cfg, log: quiet });
    const mk = { gammaId: 'A', label: 'A', startMs: 0, endMs: 300000, K: 100, Ksrc: 't', feeRate: 0.07 };
    ledger.recordBuy(mk, 'UP', { shares: 10, avgPrice: 0.6, cost: 6, fee: 0.168 }, {});
    const cash0 = ledger.cash;
    let calls = 0;
    const fetchJson = async () => (++calls < 3 ? { closed: false, outcomePrices: '["0.97","0.03"]' } : { closed: true, outcomes: '["Down","Up"]', outcomePrices: '["0","1"]' });
    const r = new Resolver({ cfg: { ...cfg, RESOLVE_TIMEOUT_MS: 60000 }, log: quiet, ledger, pricer: { strike: () => 100 }, clTwap: { at: () => ({ value: 101 }) }, fetchJson, setTimeoutFn: setT });
    r.onClose(mk); await run();
    assert.eq(calls, 3, 'espera a closed=true (no se apura con precio 0.97)');
    assert.near(ledger.cash - cash0, 10, 1e-9, 'Up ganó (aunque venga segundo en outcomes) → cobra $10');
    assert.eq(r.stats.provisionalAgree, 1, 'la resolución provisoria (TWAP publicado 101 ≥ 100) coincidió con la oficial');
    await new Promise(res => setTimeout(res, 100)); // escritura asíncrona
    const line = JSON.parse(fs.readFileSync(ledger.marketsFile, 'utf8').trim().split('\n').pop());
    assert.ok(line.winner === 'UP' && line.source === 'gamma' && Math.abs(line.pnl - (10 - 6 - 0.168)) < 1e-6, `resumen del mercado: PnL ${line.pnl}`);
  }
  // 2) Gamma no confirma → liquida con el TWAP publicado, marcado
  {
    const ledger = new Ledger({ cfg, log: quiet });
    const mk = { gammaId: 'B', label: 'B', startMs: 0, endMs: 300000, K: 100, feeRate: 0.07 };
    ledger.recordBuy(mk, 'UP', { shares: 5, avgPrice: 0.5, cost: 2.5, fee: 0.0875 }, {});
    const r = new Resolver({ cfg, log: quiet, ledger, pricer: { strike: () => 100 }, clTwap: { at: () => ({ value: 99 }) }, fetchJson: async () => { throw new Error('caído'); }, setTimeoutFn: setT });
    const t0 = Date.now(); r.onClose(mk);
    while (Date.now() - t0 < 80) await new Promise(res => setTimeout(res, 10)), await run();
    await run();
    await new Promise(res => setTimeout(res, 100));
    const line = JSON.parse(fs.readFileSync(ledger.marketsFile, 'utf8').trim().split('\n').pop());
    assert.ok(line.winner === 'DOWN' && line.source === 'twap_publicado_sin_gamma', `sin Gamma: DOWN por TWAP 99 < 100 (${line.winner}, ${line.source})`);
    assert.ok(!ledger.positions.B, 'posición liquidada');
  }
})();
