'use strict';
const assert = require('./assert');
const os = require('os'), fs = require('fs'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2t-'));
process.env.DATA_DIR = dir;
const base = require('../src/config');
// STALE_BOOK_MS alto: el test evalúa con relojes simulados (now + 10 s) sobre un libro actualizado en tiempo real
const cfg = { ...base, DATA_DIR: dir, STALE_BOOK_MS: 60000, SIM_LATENCY_MS: 0, EDGE_MIN: 0.03, KELLY_FRACTION: 0.25, MAX_STAKE_USD: 10, PAPER_BANKROLL: 100 };
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const { MarketBook } = require('../src/feeds/book');
const { PaperExecutor } = require('../src/paper');
const { Ledger } = require('../src/ledger');
const { Strategy } = require('../src/strategy');
const { takerFee } = require('../src/math');

const now = Date.now();
const mk = { label: 'T', gammaId: 'g1', startMs: now - 60000, endMs: now + 240000, upToken: 'U', downToken: 'D', minShares: 5, feeRate: 0.07 };
const book = new MarketBook({ cfg, log: quiet, market: mk });
book.client = { connected: true, stop() {} };
mk.book = book;

// ── Libro: snapshot + deltas (formato real del WS) ─────────────────────────
book.handle({ event_type: 'book', asset_id: 'U', bids: [{ price: '0.55', size: '100' }, { price: '0.56', size: '50' }], asks: [{ price: '0.60', size: '20' }, { price: '0.58', size: '10' }, { price: '0.62', size: '100' }] });
book.handle({ event_type: 'book', asset_id: 'D', bids: [{ price: '0.40', size: '30' }], asks: [{ price: '0.44', size: '40' }] });
let b = book.best('UP');
assert.ok(b.ask === 0.58 && b.bid === 0.56, `mejor ask/bid ordenando niveles desordenados (ask ${b.ask}, bid ${b.bid})`);
book.handle({ event_type: 'price_change', price_changes: [{ asset_id: 'U', price: '0.58', size: '0', side: 'SELL' }, { asset_id: 'U', price: '0.59', size: '15', side: 'SELL' }] });
assert.eq(book.best('UP').ask, 0.59, 'delta: nivel en 0 se borra y aparece uno nuevo');
book.handle({ topic: 'market', type: 'price_change', payload: { priceChanges: [{ tokenId: 'D', price: '0.43', size: '25', side: 'SELL' }] } });
assert.eq(book.best('DOWN').ask, 0.43, 'también entiende el formato nuevo (type/payload, camelCase)');
assert.ok(book.healthy(), 'libro sano con ambos snapshots');

// ── Walk del libro y consumo ───────────────────────────────────────────────
const fills = PaperExecutor.walk(book.levels('UP', 'asks'), 30, 0.60, true);
assert.ok(fills.length === 2 && fills[0].price === 0.59 && fills[1].shares === 15, 'walk: 15 @0.59 + 15 @0.60, se frena en el límite');
book.consume('UP', 'asks', 0.59, 15);
assert.eq(book.best('UP').ask, 0.60, 'liquidez tomada en paper no se reusa');
// G4: un snapshot/delta con el mismo tamaño NO libera lo tomado (antes sí, y el paper
// volvía a comprar la misma liquidez); se libera si el tamaño baja o pasa CONSUMED_TTL_MS
book.handle({ event_type: 'price_change', price_changes: [{ asset_id: 'U', price: '0.59', size: '15', side: 'SELL' }] });
assert.eq(book.best('UP').ask, 0.60, 'mismo tamaño en el WS: lo tomado sigue descontado');
book.handle({ event_type: 'book', asset_id: 'U', bids: [{ price: '0.55', size: '100' }, { price: '0.56', size: '50' }], asks: [{ price: '0.59', size: '15' }, { price: '0.60', size: '20' }, { price: '0.62', size: '100' }] });
assert.eq(book.best('UP').ask, 0.60, 'snapshot nuevo con el mismo tamaño: sigue descontado');
book.handle({ event_type: 'price_change', price_changes: [{ asset_id: 'U', price: '0.59', size: '0', side: 'SELL' }] });
book.handle({ event_type: 'price_change', price_changes: [{ asset_id: 'U', price: '0.59', size: '15', side: 'SELL' }] });
assert.eq(book.best('UP').ask, 0.59, 'el nivel bajó (alguien lo tomó) y volvió: disponible de nuevo');
book.consume('UP', 'asks', 0.59, 15);
const ck = book.consumed.get('UP|asks|0.5900'); ck.at -= (cfg.CONSUMED_TTL_MS + 1);
assert.eq(book.best('UP').ask, 0.59, `pasados ${cfg.CONSUMED_TTL_MS} ms lo tomado deja de descontarse`);

// ── Estrategia: entra solo con ventaja después de comisión ─────────────────
const ledger = new Ledger({ cfg, log: quiet });
const exec = new PaperExecutor({ cfg, log: quiet, ledger, setTimeoutFn: fn => fn() });
let pUp = 0.66;
const pricer = { fair: () => ({ pUp, K: 1, Ksrc: 't', mean: 1, sd: 1, basis: 0, secsLeft: 240 }) };
const st = new Strategy({ cfg, log: quiet, pricer, ledger, executor: exec });
// UP asks: 0.59 (15), 0.60 (20), 0.62 (100). Ventaja neta: 0.66−0.59−fee(0.59)=0.053 ✓, 0.66−0.60−0.0168=0.043 ✓, 0.66−0.62−0.0165=0.0235 ✗
const plan = st.plan(mk, 'UP', 0.66);
assert.ok(plan && plan.limit === 0.60 && plan.shares === 35, `plan UP: toma 0.59 y 0.60, no 0.62 (límite ${plan?.limit}, ${plan?.shares} acc)`);
st.evaluate(mk, now);
const pos = ledger.positions.g1;
const fee59 = takerFee(0.59, 0.07), fee60 = takerFee(0.60, 0.07);
assert.ok(pos && pos.UP.shares > 0 && pos.DOWN.shares === 0, `compró UP (${pos?.UP.shares} acciones)`);
// Kelly: c ≈ costo medio + comisión; stake = 100 × 0.25 × kelly, tope $10
const c = plan.c, kelly = (0.66 - c) / (1 - c), stake = Math.min(100 * 0.25 * kelly, 10);
// Kelly pide ~$2.9 (4.7 acc), menos que el mínimo de 5 pero más de la mitad → redondea a 5
assert.eq(pos.UP.shares, 5, `¼ Kelly pide $${stake.toFixed(2)} (<5 acc, ≥ mitad del mínimo) → compra el mínimo de 5`);
assert.ok(pos.UP.fees > 0 && Math.abs(pos.UP.fees / pos.UP.shares - fee59) < 0.002, `cobró comisión ≈ ${fee59.toFixed(4)} por acción`);

// cooldown
const before = pos.UP.shares;
st.evaluate(mk, now + 500);
assert.eq(ledger.positions.g1.UP.shares, before, 'cooldown: no vuelve a comprar a los 0.5 s');

// sin ventaja → no compra
pUp = 0.55;
st.evaluate(mk, now + 5000);
assert.eq(ledger.positions.g1.UP.shares, before, 'con P=55% y ask 0.59 no compra');

// ── Salida anticipada: el mercado paga de más ──────────────────────────────
pUp = 0.50; // el modelo ahora dice 50%, y hay bids a 0.55–0.56
book.handle({ event_type: 'price_change', price_changes: [{ asset_id: 'U', price: '0.56', size: '500', side: 'BUY' }] });
st.evaluate(mk, now + 10000);
const after = ledger.positions.g1.UP.shares;
assert.ok(after < before, `vendió porque bid 0.56 − comisión > P 0.50 + 0.03 (quedan ${after})`);

// ── Liquidación ────────────────────────────────────────────────────────────
const cash0 = ledger.cash;
const res = ledger.settle(mk, 'UP');
assert.near(ledger.cash - cash0, after, 1e-6, 'al ganar UP cobra $1 por acción restante');
assert.ok(res.pnl !== null && !ledger.positions.g1, `PnL del mercado ${res.pnl}, posición cerrada`);

// ── No abrir el lado contrario ─────────────────────────────────────────────
const mk2 = { ...mk, gammaId: 'g2', book };
ledger.recordBuy(mk2, 'UP', { shares: 10, avgPrice: 0.5, cost: 5, fee: 0.1 }, {});
ledger.positions.g2.lastEntryAt = 0;
pUp = 0.30; // DOWN tendría ventaja (ask DOWN 0.43, P(DOWN)=0.70)
st.evaluate(mk2, now + 20000);
assert.eq(ledger.positions.g2.DOWN.shares, 0, 'con UP abierto no compra DOWN');
