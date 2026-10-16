'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const iso = (days) => new Date(Date.now() + days * 864e5).toISOString();
function mkMarket(id, o = {}) {
  return {
    id: String(id), question: o.question || `Pregunta ${id}?`, description: 'Reglas completas ' + id, conditionId: '0x' + id,
    endDate: o.endDate || iso(10), outcomes: '["Yes","No"]', outcomePrices: `["${o.price ?? 0.5}","${1 - (o.price ?? 0.5)}"]`,
    clobTokenIds: `["y${id}","n${id}"]`, liquidityNum: o.liq ?? 20000, active: true, closed: false, acceptingOrders: true,
    feesEnabled: o.fees ?? false, feeSchedule: o.feeSchedule, resolutionSource: 'fuente',
  };
}
const mkEvent = (id, tags, markets) => ({ id: String(id), title: 'Evento ' + id, tags: tags.map((t) => ({ slug: t })), markets });

// libro: asks/bids como [[precio,size],...]
const book = (bids, asks) => ({ bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })), asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })) });

function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  Object.assign(process.env, { DATA_DIR: dir, RETRY_BASE_MS: '1', HTTP_RETRIES: '0', MARKETS_PER_DAY: '10' }, env);
  return dir;
}
function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    for (const [pat, fn] of routes) {
      if (url.includes(pat)) {
        const body = typeof fn === 'function' ? fn(url) : fn;
        if (body === 404) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body };
      }
    }
    throw new Error('ruta sin mock: ' + url);
  };
}
module.exports = { mkMarket, mkEvent, book, setup, mockFetch, iso };
