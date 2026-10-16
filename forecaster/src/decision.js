'use strict';
const { config } = require('./config');

// comision por accion = tasa * (p(1-p))^exponente (exponente 1 => tasa*p*(1-p)); 0 si feesEnabled=false.
function feePerShare(p, market) {
  if (!market.fees_enabled) return 0;
  const fs = market.fee_schedule || {};
  const rate = Number(fs.rate ?? fs.feeRate ?? 0);
  const exp = Number(fs.exponent ?? 1);
  if (!(rate > 0)) return 0;
  return rate * Math.pow(p * (1 - p), exp);
}

// Recorre los asks hasta max_price y gasta hasta `stake` USD. Devuelve USD gastados, acciones y precio medio.
function fillAsks(asks, maxPrice, stake) {
  let usd = 0, shares = 0;
  for (const l of asks) {
    if (l.price > maxPrice + 1e-12 || usd >= stake) break;
    const take = Math.min(l.price * l.size, stake - usd);
    usd += take;
    shares += take / l.price;
  }
  return { usd, shares, avg: shares > 0 ? usd / shares : null };
}

// Regla fija. portfolio: { openUsd, openByEvent: Map event_id -> n }
function decide({ forecast, market, books, portfolio }) {
  const c = config();
  const p = forecast.p_yes;
  const sides = [
    { side: 'SI', p: p, book: books.yes },
    { side: 'NO', p: 1 - p, book: books.no },
  ];
  const evals = sides.map((s) => {
    const ask = s.book?.ask ?? null;
    if (ask === null) return { ...s, ask, fee: null, edge: null };
    const fee = feePerShare(ask, market);
    return { ...s, ask, fee, edge: s.p - ask - fee };
  });
  const detail = evals.map((e) => ({ side: e.side, ask: e.ask, fee: e.fee, edge: e.edge }));
  const best = evals.filter((e) => e.edge !== null && e.edge >= c.EDGE_MIN - 1e-9).sort((a, b) => b.edge - a.edge)[0];
  if (!best) {
    const sinLibro = evals.every((e) => e.ask === null);
    return { action: 'omitir', reason: sinLibro ? 'sin_ask' : 'edge_insuficiente', detail };
  }
  if ((portfolio.openByEvent.get(market.event_id) || 0) >= c.MAX_PER_EVENT) return { action: 'omitir', reason: 'tope_por_evento', detail };
  const room = c.MAX_OPEN_USD - portfolio.openUsd;
  if (room < c.MIN_FILL_USD) return { action: 'omitir', reason: 'tope_total_abierto', detail };
  const stake = Math.min(c.STAKE_USD, room);
  // precio maximo al que el edge sigue siendo >= EDGE_MIN (comision evaluada en ese precio)
  let maxPrice = best.ask;
  for (const l of best.book.asks) {
    if (best.p - l.price - feePerShare(l.price, market) >= c.EDGE_MIN - 1e-9) maxPrice = l.price; else break;
  }
  const fill = fillAsks(best.book.asks, maxPrice, stake);
  if (fill.usd < c.MIN_FILL_USD) return { action: 'omitir', reason: 'profundidad_insuficiente', detail };
  const fee_usd = fill.shares * feePerShare(fill.avg, market);
  return {
    action: 'comprar', side: best.side, token: best.side === 'SI' ? market.token_yes : market.token_no,
    stake_usd: fill.usd, shares: fill.shares, avg_price: fill.avg, fee_usd,
    edge: best.edge, p_side: best.p, detail,
    // el tope de riesgo se mide por lo gastado
  };
}

module.exports = { feePerShare, fillAsks, decide };
