'use strict';
const { config } = require('./config');
const { fetchJson } = require('./util');

const lvl = (a) => (a || []).map((x) => ({ price: Number(x.price), size: Number(x.size) })).filter((x) => x.size > 0);

function parseBook(raw) {
  const bids = lvl(raw.bids).sort((a, b) => b.price - a.price);
  const asks = lvl(raw.asks).sort((a, b) => a.price - b.price);
  const bid = bids[0]?.price ?? null;
  const ask = asks[0]?.price ?? null;
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const depth = (levels, n) => levels.slice(0, n).reduce((s, x) => s + x.price * x.size, 0);
  return { bids, asks, bid, ask, mid, depth_bid_usd: depth(bids, 5), depth_ask_usd: depth(asks, 5) };
}

async function fetchBook(tokenId) {
  const raw = await fetchJson(`${config().CLOB_URL}/book?token_id=${encodeURIComponent(tokenId)}`);
  return parseBook(raw);
}

// Guarda lo necesario para auditar la decision (niveles recortados).
function snapshotBook(b) {
  const n = config().BOOK_LEVELS;
  return { bid: b.bid, ask: b.ask, mid: b.mid, depth_bid_usd: b.depth_bid_usd, depth_ask_usd: b.depth_ask_usd, bids: b.bids.slice(0, n), asks: b.asks.slice(0, n) };
}

module.exports = { parseBook, fetchBook, snapshotBook };
