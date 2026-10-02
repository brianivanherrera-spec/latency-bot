/**
 * Utilidades de libro de órdenes del CLOB de Polymarket.
 *
 * El CLOB no garantiza el orden de los niveles: bids[0]/asks[0] no es el mejor precio
 * (el REST devuelve los bids de menor a mayor y los asks de mayor a menor). El mejor bid
 * es el máximo y el mejor ask el mínimo, siempre con tamaño > 0.
 */
'use strict';

const parsePrice = (l) => parseFloat(l?.price);
const parseSize = (l) => parseFloat(l?.size ?? l?.amount ?? 0) || 0;

// Mejor nivel de un lado: { price, size } o { price: null, size: null }
function bestLevel(levels, side) {
  let price = null, size = null;
  if (!Array.isArray(levels)) return { price, size };
  for (const l of levels) {
    const p = parsePrice(l), s = parseSize(l);
    if (!(p > 0 && p <= 1) || !(s > 0)) continue;
    if (price == null || (side === 'bid' ? p > price : p < price)) { price = p; size = s; }
  }
  return { price, size };
}

// Niveles ordenados del mejor al peor (bids desc, asks asc), solo con tamaño > 0
function sortedLevels(levels, side) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map(l => ({ price: parsePrice(l), size: parseSize(l) }))
    .filter(l => l.price > 0 && l.price <= 1 && l.size > 0)
    .sort((a, b) => side === 'bid' ? b.price - a.price : a.price - b.price);
}

// Mejor bid / ask de un libro { bids, asks }. crossed = bid >= ask (dato inválido)
function bestOfBook(book) {
  const bid = bestLevel(book?.bids, 'bid');
  const ask = bestLevel(book?.asks, 'ask');
  const crossed = bid.price != null && ask.price != null && bid.price >= ask.price;
  return { bestBid: bid.price, bestBidSize: bid.size, bestAsk: ask.price, bestAskSize: ask.size, crossed };
}

module.exports = { bestLevel, sortedLevels, bestOfBook, parseSize };
