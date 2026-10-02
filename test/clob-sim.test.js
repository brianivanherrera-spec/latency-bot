/**
 * Pruebas de ejecución real (polymarket.js) con un cliente CLOB simulado.
 * Nada de esto corre en paper. Uso: node test/clob-sim.test.js
 *
 * El simulado imita a @polymarket/clob-client-v2 1.0.6: los errores HTTP vuelven como
 * { error } (no lanzan), cancelOrder responde { canceled, not_canceled } y los saldos de
 * tokens vienen en unidades de 1e6.
 */
'use strict';
process.env.DRY_RUN = 'false';
process.env.ORDER_TYPE = 'MARKET';
process.env.USE_FAK = 'true';
process.env.DUAL_FILL_ORDER = 'true';
process.env.MARKET_RETRY = 'true'; // DUAL nunca debe caer a MARKET_RETRY
process.env.MAX_GTC_ENTRY_ASK = '0.80';
process.env.LOG_FILE = 'off';
process.env.DATA_DIR = require('os').tmpdir();

const assert = require('assert');
const { OrderType, Side } = require('@polymarket/clob-client-v2');
const { PolymarketClient } = require('../src/polymarket');

const TOKEN = 'TOKEN_UP';

class MockClob {
  constructor(sc = {}) {
    this.sc = sc;
    this.calls = [];
    this.orders = new Map(); // id → { status, size_matched, price, getCount }
    this.balance = sc.balance ?? 0; // acciones
    this.seq = 0;
  }
  _log(name, args) { this.calls.push({ name, args }); }
  count(name) { return this.calls.filter(c => c.name === name).length; }
  async createAndPostMarketOrder(order, opts, type, deferExec) {
    this._log('market', [order, opts, type, deferExec]);
    return this.sc.market ? this.sc.market.call(this, order, opts, type) : { success: true, status: 'unmatched', orderID: `m${++this.seq}` };
  }
  async createAndPostOrder(order, opts, type, postOnly, deferExec) {
    this._log('limit', [order, opts, type, postOnly, deferExec]);
    return this.sc.limit ? this.sc.limit.call(this, order, opts, type) : { error: 'no implementado' };
  }
  async getOrder(id) {
    this._log('getOrder', [id]);
    if (this.sc.getOrder) return this.sc.getOrder.call(this, id);
    const o = this.orders.get(id);
    return o ? { id, status: o.status, size_matched: String(o.size_matched || 0), price: String(o.price) } : { error: 'not found', status: 404 };
  }
  async cancelOrder({ orderID }) {
    this._log('cancel', [orderID]);
    if (this.sc.cancel) return this.sc.cancel.call(this, orderID);
    const o = this.orders.get(orderID);
    if (o && o.status === 'live') { o.status = 'canceled'; return { canceled: [orderID], not_canceled: {} }; }
    return { canceled: [], not_canceled: { [orderID]: 'order not found or already canceled' } };
  }
  async cancelAll() { this._log('cancelAll', []); return { canceled: ['a', 'b'], not_canceled: {} }; }
  async updateBalanceAllowance(p) { this._log('updBal', [p]); return {}; }
  async getBalanceAllowance(p) {
    this._log('getBal', [p]);
    if (this.sc.getBal) return this.sc.getBal.call(this, p);
    return { balance: String(Math.round(this.balance * 1e6)), allowances: {} };
  }
  async getOrderBook() { return this.sc.book || { bids: [], asks: [] }; }
}

function client(mock, ask = 0.69) {
  const c = new PolymarketClient();
  c._initialized = true;
  c.clobClient = mock;
  c._polyWs = { getBestAskForToken: () => ask };
  return c;
}
const order = (over = {}) => ({ marketId: 'm', tokenId: TOKEN, side: 'BUY', price: 0.70, size: 7,
  marketQuestion: 'q', marketEndTs: Date.now() + 2500, ...over });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─── D4: firmas ─────────────────────────────────────────────────────────────
test('DUAL: FAK llena todo → tipo FAK como 3er argumento, sin deferExec, sin GTD', async () => {
  const m = new MockClob({
    market(o) { this.balance += 7; return { success: true, status: 'matched', orderID: 'f1', makingAmount: '4.90', takingAmount: '7' }; },
  });
  const r = await client(m).placeLimitOrder(order());
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.sizeFilled, 7);
  assert.strictEqual(r.fillPrice, 0.7);
  const call = m.calls.find(c => c.name === 'market');
  assert.strictEqual(call.args[2], OrderType.FAK, 'orderType 3er arg');
  assert.strictEqual(call.args[3], undefined, 'sin deferExec');
  assert.strictEqual(call.args[1].tickSize, '0.01');
  assert.strictEqual(call.args[1].negRisk, false);
  assert.strictEqual(call.args[0].orderType, undefined, 'orderType no va dentro del objeto');
  assert.strictEqual(m.count('limit'), 0, 'no manda GTD');
});

// ─── D2: delayed → estado final, GTD solo por lo que falta ──────────────────
test('DUAL: FAK delayed → espera estado final; GTD por el remanente; parcial ponderado', async () => {
  const m = new MockClob({
    market() { this.orders.set('f1', { status: 'delayed', size_matched: 0, price: 0.70 });
      setTimeout(() => { const o = this.orders.get('f1'); o.status = 'matched'; o.size_matched = 3; this.balance += 3; }, 400);
      return { success: true, status: 'delayed', orderID: 'f1', makingAmount: '0', takingAmount: '0' }; },
    limit(o, opts, type) { this.orders.set('g1', { status: 'live', size_matched: 0, price: o.price });
      setTimeout(() => { this.orders.get('g1').size_matched = 2; }, 500);
      return { success: true, status: 'live', orderID: 'g1' }; },
  });
  const r = await client(m).placeLimitOrder(order({ size: 10, marketEndTs: Date.now() + 3000 }));
  const gtd = m.calls.find(c => c.name === 'limit');
  assert.ok(gtd, 'manda GTD');
  assert.strictEqual(gtd.args[2], OrderType.GTD);
  assert.strictEqual(gtd.args[0].size, 7, 'GTD por 10 − 3');
  assert.strictEqual(m.count('market'), 1, 'una sola FAK');
  assert.strictEqual(r.sizeFilled, 5, '3 de la FAK + 2 de la GTD');
  assert.strictEqual(r.fillPrice, 0.7);
  assert.ok(m.count('cancel') >= 1, 'cancela la GTD al cierre');
});

test('DUAL: FAK delayed sin estado final pero el saldo muestra el fill → no manda GTD', async () => {
  const m = new MockClob({
    market() { this.balance += 10; return { success: true, status: 'delayed', orderID: 'f1' }; },
    getOrder() { return { id: 'f1', status: 'delayed', size_matched: '0' }; },
  });
  const r = await client(m).placeLimitOrder(order({ size: 10 }));
  assert.strictEqual(m.count('limit'), 0);
  assert.strictEqual(r.sizeFilled, 10);
});

test('DUAL: estado de la FAK desconocido y sin saldo → no GTD, no loop FOK, NO_FILL', async () => {
  const m = new MockClob({
    market() { return { success: true, status: 'delayed', orderID: 'f1' }; },
    getOrder() { return { error: 'timeout' }; },
    getBal() { return { error: 'timeout' }; },
  });
  const r = await client(m).placeLimitOrder(order({ size: 10 }));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'fak_state_unknown');
  assert.strictEqual(m.count('market'), 1, 'una sola orden de mercado');
  assert.strictEqual(m.count('limit'), 0);
});

test('DUAL: FAK sin fill y GTD rechazada → dual_no_fill (no cae a FOK ni MARKET_RETRY)', async () => {
  const m = new MockClob({
    market() { return { success: true, status: 'unmatched', orderID: 'f1', makingAmount: '0', takingAmount: '0' }; },
    limit() { return { error: 'invalid expiration', status: 400 }; },
  });
  const r = await client(m).placeLimitOrder(order({ size: 10 }));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'dual_no_fill');
  assert.strictEqual(m.count('market'), 1);
  assert.strictEqual(m.count('limit'), 1);
});

// ─── D3: getOrder fallido no resetea; cancel con { error } ──────────────────
test('GTD en el libro: getOrder que falla no pone lo llenado en 0; cancel con error no se da por OK', async () => {
  let n = 0;
  const m = new MockClob({
    market() { return { success: true, status: 'unmatched', orderID: 'f1' }; },
    limit(o) { this.orders.set('g1', { status: 'live', size_matched: 0, price: o.price }); return { success: true, status: 'live', orderID: 'g1' }; },
    getOrder(id) { n++; return n === 1 ? { id, status: 'live', size_matched: '6' } : { error: 'Request failed', status: 500 }; },
    cancel() { return { error: 'service unavailable', status: 503 }; },
  });
  const r = await client(m).placeLimitOrder(order({ size: 10, marketEndTs: Date.now() + 4500 }));
  assert.strictEqual(r.sizeFilled, 6, 'conserva el size_matched conocido');
  assert.strictEqual(r.success, true);
});

// ─── D5: GTD forzada ────────────────────────────────────────────────────────
test('GTD forzada: fillPrice = USDC/acciones y sizeFilled = acciones', async () => {
  const m = new MockClob({
    limit(o, opts, type) { return { success: true, status: 'matched', orderID: 'g1', makingAmount: '3.50', takingAmount: '5' }; },
  });
  const r = await client(m).placeLimitOrder(order({ size: 5, forcedOrderType: 'GTD' }));
  const call = m.calls.find(c => c.name === 'limit');
  assert.strictEqual(call.args[2], OrderType.GTD);
  assert.strictEqual(r.fillPrice, 0.7);
  assert.strictEqual(r.sizeFilled, 5);
});

test('GTD forzada que queda en el libro: se sigue (antes salía como NO_FILL con la orden viva)', async () => {
  const m = new MockClob({
    limit(o) { this.orders.set('g1', { status: 'live', size_matched: 0, price: o.price });
      setTimeout(() => { const x = this.orders.get('g1'); x.status = 'matched'; x.size_matched = 5; }, 300);
      return { success: true, status: 'live', orderID: 'g1' }; },
  });
  const r = await client(m).placeLimitOrder(order({ size: 5, forcedOrderType: 'GTD', marketEndTs: Date.now() + 5000 }));
  assert.strictEqual(r.sizeFilled, 5);
  assert.strictEqual(m.count('market'), 0, 'no manda FAK además de la GTD');
});

// ─── D1: excepción después de un fill ───────────────────────────────────────
test('Excepción después de un fill: el resultado conserva el fill', async () => {
  const c = client(new MockClob());
  c._placeLimitOrderInner = async (args, ctx) => { ctx.filledShares = 4; ctx.filledUsdc = 2.8; throw new Error('boom'); };
  const r = await c.placeLimitOrder(order());
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.sizeFilled, 4);
  assert.strictEqual(r.fillPrice, 0.7);
});

test('Resultado "matched" sin tamaño → sizeFilled y fillPrice completos', async () => {
  const c = client(new MockClob());
  c._placeLimitOrderInner = async () => ({ success: true, status: 'matched', orderId: 'x' });
  const r = await c.placeLimitOrder(order());
  assert.strictEqual(r.sizeFilled, 7);
  assert.strictEqual(r.fillPrice, 0.7);
  assert.strictEqual(r.usdcSpent, 4.9);
});

// ─── Retry-loop GTC: cancel con { error } aborta ───────────────────────────
test('Retry GTC: cancel que devuelve { error } aborta sin mandar otra orden', async () => {
  process.env.FILL_RETRY_ATTEMPT_SECONDS = '1';
  const m = new MockClob({
    limit(o) { this.orders.set(`g${++this.seq}`, { status: 'live', size_matched: 0, price: o.price }); return { success: true, status: 'live', orderID: `g${this.seq}` }; },
    cancel() { return { error: 'rate limited', status: 429 }; },
  });
  const c = client(m);
  const r = await c._placeGtcWithRetry({ rec: {}, tokenId: TOKEN, side: 'BUY', price: 0.7, size: 7, marketEndTs: Date.now() + 120000 });
  assert.strictEqual(r.error, 'cancel_failed');
  assert.strictEqual(m.count('limit'), 1, 'una sola orden');
  assert.strictEqual(m.calls.find(x => x.name === 'limit').args[2], OrderType.GTC);
});

// ─── Venta (position monitor) ───────────────────────────────────────────────
test('Venta: FAK como 3er arg, floor(saldo real), mejor bid = max(bids)', async () => {
  const m = new MockClob({
    balance: 6.7,
    book: { bids: [{ price: '0.40', size: '10' }, { price: '0.55', size: '10' }, { price: '0.50', size: '10' }], asks: [] },
    market(o) { return { success: true, status: 'matched', makingAmount: String(o.amount), takingAmount: (o.amount * 0.55).toFixed(2) }; },
  });
  const r = await client(m).sellPosition({ tokenId: TOKEN, size: 7, side: 'BUY', posId: 'P' });
  const call = m.calls.find(c => c.name === 'market');
  assert.strictEqual(call.args[2], OrderType.FAK);
  assert.strictEqual(call.args[0].side, Side.SELL);
  assert.strictEqual(call.args[0].amount, 6, 'floor(6.7)');
  assert.strictEqual(call.args[0].price, 0.55, 'max(bids)');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.soldShares, 6);
});

test('cancelAllOrders devuelve cuántas canceló', async () => {
  const r = await client(new MockClob()).cancelAllOrders();
  assert.deepStrictEqual(r, { ok: true, canceled: 2 });
});

(async () => {
  // Silenciar los logs del cliente durante las pruebas
  const origLog = console.log, origErr = console.error, origWarn = console.warn, origInfo = console.info;
  let pass = 0, fail = 0;
  for (const t of tests) {
    console.log = console.error = console.warn = console.info = () => {};
    let err = null;
    try { await t.fn(); } catch (e) { err = e; }
    console.log = origLog; console.error = origErr; console.warn = origWarn; console.info = origInfo;
    if (err) { fail++; console.log(`✗ ${t.name}\n    ${err.message}`); }
    else { pass++; console.log(`✓ ${t.name}`); }
  }
  console.log(`\n${pass}/${tests.length} OK${fail ? ` — ${fail} fallaron` : ''}`);
  process.exit(fail ? 1 : 0);
})();
